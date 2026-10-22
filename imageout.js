// 画像の書き出し(エンコード)と、変換先の形式の一覧。
// 形式を増やすときは、FORMATS に 1 つ足す。exts の先頭が、標準の拡張子。
window.ImageOut = (() => {
  const { loadScript, LIBS } = Tools;

  // ---------- 共通の部品 ----------
  const pixelsOf = (canvas) => canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;

  // 透明な部分を持てない形式のために、白い背景に重ねた RGBA を返す
  function flatPixels(canvas) {
    const flat = document.createElement("canvas");
    flat.width = canvas.width;
    flat.height = canvas.height;
    const ctx = flat.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, flat.width, flat.height);
    ctx.drawImage(canvas, 0, 0);
    return ctx.getImageData(0, 0, flat.width, flat.height).data;
  }

  const gray = (r, g, b) => Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

  // 長辺が max を超えないように縮めた canvas(余白を足して正方形にすることもできる)
  function fitCanvas(canvas, max, square = false) {
    const k = Math.min(1, max / Math.max(canvas.width, canvas.height));
    const w = Math.max(1, Math.round(canvas.width * k));
    const h = Math.max(1, Math.round(canvas.height * k));
    const out = document.createElement("canvas");
    out.width = square ? max : w;
    out.height = square ? max : h;
    out.getContext("2d").drawImage(canvas, (out.width - w) >> 1, (out.height - h) >> 1, w, h);
    return out;
  }

  // 数値を決まった長さのバイト列にして、並べる
  class Bytes {
    constructor() {
      this.parts = [];
    }
    u8(...v) {
      this.parts.push(Uint8Array.from(v));
      return this;
    }
    u16(v, little = true) {
      return little ? this.u8(v & 255, (v >> 8) & 255) : this.u8((v >> 8) & 255, v & 255);
    }
    u32(v, little = true) {
      const b = [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
      return this.u8(...(little ? b : b.reverse()));
    }
    text(s) {
      return this.u8(...[...s].map((c) => c.charCodeAt(0)));
    }
    raw(bytes) {
      this.parts.push(bytes);
      return this;
    }
    zeros(n) {
      this.parts.push(new Uint8Array(n));
      return this;
    }
    blob(type) {
      return new Blob(this.parts, { type });
    }
  }

  // ---------- 各形式のエンコーダー ----------
  // PNG・JPEG・WebP はブラウザの機能を使う。WebP を書き出せないブラウザでは、PNG になってしまうので呼び出し側で気付けるよう、できた Blob の種類を返す
  const viaCanvas = (type, { flat = false } = {}) => async (canvas, { quality }) => {
    let source = canvas;
    if (flat) {
      source = document.createElement("canvas");
      source.width = canvas.width;
      source.height = canvas.height;
      const ctx = source.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, source.width, source.height);
      ctx.drawImage(canvas, 0, 0);
    }
    const blob = await toBlob(source, type, quality / 100);
    if (!blob) throw new Error("encode");
    return blob;
  };

  // WebAssembly 版のコーデック(AVIF・JPEG XL)を読み込む
  const wasm = {};
  async function loadCodec(name, base, codecPath) {
    wasm[name] ??= (async () => {
      const { initEmscriptenModule } = await import(LIBS.jsquash + base + "/utils.js");
      return initEmscriptenModule((await import(LIBS.jsquash + base + codecPath)).default);
    })();
    return wasm[name];
  }

  async function encodeAvif(canvas, { quality }) {
    const codec = await loadCodec("avif", "avif@2.1.1", "/codec/enc/avif_enc.js");
    const pixels = pixelsOf(canvas);
    const out = codec.encode(new Uint8Array(pixels.buffer), canvas.width, canvas.height, {
      quality, qualityAlpha: -1, denoiseLevel: 0, tileColsLog2: 0, tileRowsLog2: 0, speed: 8, subsample: quality >= 90 ? 3 : 1,
      chromaDeltaQ: false, sharpness: 0, tune: 0, enableSharpYUV: false, bitDepth: 8, lossless: false,
    });
    if (!out) throw new Error("encode");
    return new Blob([out.buffer], { type: "image/avif" });
  }

  async function encodeJxl(canvas, { quality }) {
    const codec = await loadCodec("jxl", "jxl@1.3.0", "/codec/enc/jxl_enc.js");
    const out = codec.encode(pixelsOf(canvas), canvas.width, canvas.height, {
      effort: 4, quality, progressive: false, epf: -1, lossyPalette: false, decodingSpeedTier: 0,
      photonNoiseIso: 0, lossyModular: false, lossless: false,
    });
    if (!out) throw new Error("encode");
    return new Blob([out.buffer], { type: "image/jxl" });
  }

  // GIF: 256 色以内に減らして、LZW 圧縮する
  function quantize(data, maxColors) {
    // 色を 5 ビットずつに丸めて数え、色数の多い箱を二つに割っていく(メディアンカット)
    const hist = new Uint32Array(32768);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] >= 128) hist[((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3)]++;
    }
    const keys = [];
    for (let k = 0; k < hist.length; k++) if (hist[k]) keys.push(k);
    if (!keys.length) return [[0, 0, 0]];
    const channel = (k, c) => (k >> (10 - 5 * c)) & 31;
    const range = (box) => {
      let best = { size: -1, c: 0 };
      for (let c = 0; c < 3; c++) {
        let lo = 31;
        let hi = 0;
        for (const k of box) {
          lo = Math.min(lo, channel(k, c));
          hi = Math.max(hi, channel(k, c));
        }
        if (hi - lo > best.size) best = { size: hi - lo, c };
      }
      return best;
    };
    const boxes = [keys];
    while (boxes.length < maxColors) {
      let target = -1;
      let widest = 0;
      boxes.forEach((box, i) => {
        const r = range(box);
        if (box.length > 1 && r.size >= widest) {
          widest = r.size;
          target = i;
        }
      });
      if (target < 0) break;
      const box = boxes[target];
      const { c } = range(box);
      box.sort((a, b) => channel(a, c) - channel(b, c));
      let total = 0;
      for (const k of box) total += hist[k];
      let acc = 0;
      let cut = 1;
      for (let i = 0; i < box.length - 1; i++) {
        acc += hist[box[i]];
        cut = i + 1;
        if (acc >= total / 2) break;
      }
      boxes.splice(target, 1, box.slice(0, cut), box.slice(cut));
    }
    const palette = boxes.map((box) => {
      let n = 0;
      const sum = [0, 0, 0];
      for (const k of box) {
        n += hist[k];
        for (let c = 0; c < 3; c++) sum[c] += channel(k, c) * hist[k];
      }
      return sum.map((s) => {
        const v = Math.round(s / n);
        return (v << 3) | (v >> 2);
      });
    });
    return palette;
  }

  function lzwEncode(indices, minCode) {
    const clear = 1 << minCode;
    const eoi = clear + 1;
    const out = [];
    let cur = 0;
    let bits = 0;
    let size = minCode + 1;
    let next = eoi + 1;
    let dict = new Map();
    const emit = (code) => {
      cur |= code << bits;
      bits += size;
      while (bits >= 8) {
        out.push(cur & 255);
        cur >>>= 8;
        bits -= 8;
      }
    };
    emit(clear);
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = (prefix << 8) | k;
      const found = dict.get(key);
      if (found !== undefined) {
        prefix = found;
        continue;
      }
      emit(prefix);
      if (next === 4096) {
        emit(clear);
        next = eoi + 1;
        size = minCode + 1;
        dict = new Map();
      } else {
        if (next >= 1 << size) size++;
        dict.set(key, next++);
      }
      prefix = k;
    }
    emit(prefix);
    emit(eoi);
    if (bits > 0) out.push(cur & 255);
    return out;
  }

  function encodeGif(canvas) {
    const w = canvas.width;
    const h = canvas.height;
    if (w > 65535 || h > 65535) throw new Error("GIF は 65535 ピクセルまでです");
    const data = pixelsOf(canvas);
    let transparent = false;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 128) {
        transparent = true;
        break;
      }
    }
    // 透明を使うときは、パレットの 0 番を透明に取っておく
    const colors = quantize(data, transparent ? 255 : 256);
    const palette = transparent ? [[0, 0, 0], ...colors] : colors;
    const tableBits = Math.max(1, Math.ceil(Math.log2(Math.max(2, palette.length))));
    const offset = transparent ? 1 : 0;

    // 色(5 ビット)から、いちばん近いパレットの番号を引く表
    const lookup = new Int16Array(32768).fill(-1);
    const nearest = (key) => {
      const r = (((key >> 10) & 31) << 3) | (((key >> 10) & 31) >> 2);
      const g = (((key >> 5) & 31) << 3) | (((key >> 5) & 31) >> 2);
      const b = ((key & 31) << 3) | ((key & 31) >> 2);
      let best = offset;
      let bestDistance = Infinity;
      for (let i = offset; i < palette.length; i++) {
        const d = (palette[i][0] - r) ** 2 + (palette[i][1] - g) ** 2 + (palette[i][2] - b) ** 2;
        if (d < bestDistance) {
          bestDistance = d;
          best = i;
        }
      }
      return best;
    };
    const indices = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) {
      if (transparent && data[p * 4 + 3] < 128) continue; // 0 番(透明)のまま
      const key = ((data[p * 4] >> 3) << 10) | ((data[p * 4 + 1] >> 3) << 5) | (data[p * 4 + 2] >> 3);
      if (lookup[key] < 0) lookup[key] = nearest(key);
      indices[p] = lookup[key];
    }

    const minCode = Math.max(2, tableBits);
    const lzw = lzwEncode(indices, minCode);
    const bytes = new Bytes().text("GIF89a").u16(w).u16(h).u8(0x80 | 0x70 | (tableBits - 1), 0, 0);
    for (let i = 0; i < 1 << tableBits; i++) bytes.u8(...(palette[i] ?? [0, 0, 0]));
    if (transparent) bytes.u8(0x21, 0xf9, 4, 1, 0, 0, 0, 0);
    bytes.u8(0x2c).u16(0).u16(0).u16(w).u16(h).u8(0, minCode);
    for (let i = 0; i < lzw.length; i += 255) {
      const block = lzw.slice(i, i + 255);
      bytes.u8(block.length).raw(Uint8Array.from(block));
    }
    bytes.u8(0, 0x3b);
    return bytes.blob("image/gif");
  }

  // BMP / DIB(24 ビット。透明は白に重ねる)
  function encodeBmp(canvas, { ext }) {
    const w = canvas.width;
    const h = canvas.height;
    const data = flatPixels(canvas);
    const rowBytes = (w * 3 + 3) & ~3;
    const body = new Uint8Array(rowBytes * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = ((h - 1 - y) * w + x) * 4;
        const o = y * rowBytes + x * 3;
        body[o] = data[s + 2];
        body[o + 1] = data[s + 1];
        body[o + 2] = data[s];
      }
    }
    const bytes = new Bytes();
    if (ext !== "dib") bytes.text("BM").u32(14 + 40 + body.length).u32(0).u32(14 + 40);
    bytes.u32(40).u32(w).u32(h).u16(1).u16(24).u32(0).u32(body.length).u32(2835).u32(2835).u32(0).u32(0).raw(body);
    return bytes.blob("image/bmp");
  }

  // ICO / CUR(中身は PNG。256 ピクセルまで)
  async function encodeIco(canvas, { ext }) {
    const small = fitCanvas(canvas, 256);
    const png = new Uint8Array(await (await toBlob(small, "image/png")).arrayBuffer());
    return new Bytes()
      .u16(0).u16(ext === "cur" ? 2 : 1).u16(1)
      .u8(small.width === 256 ? 0 : small.width, small.height === 256 ? 0 : small.height, 0, 0)
      .u16(ext === "cur" ? 0 : 1).u16(ext === "cur" ? 0 : 32)
      .u32(png.length).u32(22).raw(png)
      .blob(ext === "cur" ? "image/x-icon" : "image/vnd.microsoft.icon");
  }

  async function encodeTiff(canvas) {
    await loadScript(LIBS.utif);
    const rgba = new Uint8Array(pixelsOf(canvas).buffer.slice(0));
    return new Blob([UTIF.encodeImage(rgba, canvas.width, canvas.height)], { type: "image/tiff" });
  }

  function encodeTga(canvas) {
    const w = canvas.width;
    const h = canvas.height;
    if (w > 65535 || h > 65535) throw new Error("TGA は 65535 ピクセルまでです");
    const data = pixelsOf(canvas);
    const body = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      body[i * 4] = data[i * 4 + 2];
      body[i * 4 + 1] = data[i * 4 + 1];
      body[i * 4 + 2] = data[i * 4];
      body[i * 4 + 3] = data[i * 4 + 3];
    }
    return new Bytes().u8(0, 0, 2).zeros(9).u16(w).u16(h).u8(32, 0x28).raw(body).blob("image/x-tga");
  }

  // PNM の仲間(ppm, pgm, pbm, pam)
  function encodePnm(kind) {
    return (canvas) => {
      const w = canvas.width;
      const h = canvas.height;
      const bytes = new Bytes();
      if (kind === "pam") {
        const data = pixelsOf(canvas);
        bytes.text(`P7\nWIDTH ${w}\nHEIGHT ${h}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`).raw(Uint8Array.from(data));
        return bytes.blob("image/x-portable-arbitrarymap");
      }
      const data = flatPixels(canvas);
      if (kind === "ppm") {
        const body = new Uint8Array(w * h * 3);
        for (let i = 0; i < w * h; i++) body.set(data.subarray(i * 4, i * 4 + 3), i * 3);
        return bytes.text(`P6\n${w} ${h}\n255\n`).raw(body).blob("image/x-portable-pixmap");
      }
      if (kind === "pgm") {
        const body = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) body[i] = gray(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
        return bytes.text(`P5\n${w} ${h}\n255\n`).raw(body).blob("image/x-portable-graymap");
      }
      const rowBytes = (w + 7) >> 3;
      const body = new Uint8Array(rowBytes * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (gray(data[i], data[i + 1], data[i + 2]) < 128) body[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
        }
      }
      return bytes.text(`P4\n${w} ${h}\n`).raw(body).blob("image/x-portable-bitmap");
    };
  }

  function encodeQoi(canvas) {
    const w = canvas.width;
    const h = canvas.height;
    const data = pixelsOf(canvas);
    const out = [];
    const index = new Uint8Array(64 * 4);
    let pr = 0;
    let pg = 0;
    let pb = 0;
    let pa = 255;
    let run = 0;
    const header = new Bytes().text("qoif").u32(w, false).u32(h, false).u8(4, 0);
    const total = w * h;
    for (let p = 0; p < total; p++) {
      const r = data[p * 4];
      const g = data[p * 4 + 1];
      const b = data[p * 4 + 2];
      const a = data[p * 4 + 3];
      if (r === pr && g === pg && b === pb && a === pa) {
        run++;
        if (run === 62 || p === total - 1) {
          out.push(0xc0 | (run - 1));
          run = 0;
        }
      } else {
        if (run > 0) {
          out.push(0xc0 | (run - 1));
          run = 0;
        }
        const hash = ((r * 3 + g * 5 + b * 7 + a * 11) % 64) * 4;
        if (index[hash] === r && index[hash + 1] === g && index[hash + 2] === b && index[hash + 3] === a) {
          out.push(hash / 4);
        } else {
          index[hash] = r;
          index[hash + 1] = g;
          index[hash + 2] = b;
          index[hash + 3] = a;
          if (a === pa) {
            const dr = ((r - pr) << 24) >> 24;
            const dg = ((g - pg) << 24) >> 24;
            const db = ((b - pb) << 24) >> 24;
            const drDg = dr - dg;
            const dbDg = db - dg;
            if (dr >= -2 && dr <= 1 && dg >= -2 && dg <= 1 && db >= -2 && db <= 1) {
              out.push(0x40 | ((dr + 2) << 4) | ((dg + 2) << 2) | (db + 2));
            } else if (dg >= -32 && dg <= 31 && drDg >= -8 && drDg <= 7 && dbDg >= -8 && dbDg <= 7) {
              out.push(0x80 | (dg + 32), ((drDg + 8) << 4) | (dbDg + 8));
            } else {
              out.push(0xfe, r, g, b);
            }
          } else {
            out.push(0xff, r, g, b, a);
          }
        }
      }
      pr = r;
      pg = g;
      pb = b;
      pa = a;
    }
    return header.raw(Uint8Array.from(out)).u8(0, 0, 0, 0, 0, 0, 0, 1).blob("image/qoi");
  }

  function encodeFarbfeld(canvas) {
    const w = canvas.width;
    const h = canvas.height;
    const data = pixelsOf(canvas);
    const body = new Uint8Array(w * h * 8);
    for (let i = 0; i < w * h * 4; i++) {
      body[i * 2] = data[i];
      body[i * 2 + 1] = data[i];
    }
    return new Bytes().text("farbfeld").u32(w, false).u32(h, false).raw(body).blob("image/x-farbfeld");
  }

  function encodePcx(canvas) {
    const w = canvas.width;
    const h = canvas.height;
    if (w > 65535 || h > 65535) throw new Error("PCX は 65535 ピクセルまでです");
    const data = flatPixels(canvas);
    const lineBytes = w + (w & 1);
    const body = [];
    for (let y = 0; y < h; y++) {
      for (let c = 0; c < 3; c++) {
        const line = new Uint8Array(lineBytes);
        for (let x = 0; x < w; x++) line[x] = data[(y * w + x) * 4 + c];
        for (let i = 0; i < lineBytes; ) {
          let n = 1;
          while (i + n < lineBytes && n < 63 && line[i + n] === line[i]) n++;
          if (n > 1 || line[i] >= 0xc0) body.push(0xc0 | n, line[i]);
          else body.push(line[i]);
          i += n;
        }
      }
    }
    return new Bytes()
      .u8(10, 5, 1, 8).u16(0).u16(0).u16(w - 1).u16(h - 1).u16(72).u16(72)
      .zeros(48).u8(0, 3).u16(lineBytes).u16(1).u16(0).u16(0).zeros(54)
      .raw(Uint8Array.from(body))
      .blob("image/x-pcx");
  }

  function encodeXbm(canvas) {
    const w = canvas.width;
    const h = canvas.height;
    const data = flatPixels(canvas);
    const rowBytes = (w + 7) >> 3;
    const values = [];
    for (let y = 0; y < h; y++) {
      for (let bx = 0; bx < rowBytes; bx++) {
        let v = 0;
        for (let bit = 0; bit < 8; bit++) {
          const x = bx * 8 + bit;
          if (x < w) {
            const i = (y * w + x) * 4;
            if (gray(data[i], data[i + 1], data[i + 2]) < 128) v |= 1 << bit;
          }
        }
        values.push("0x" + v.toString(16).padStart(2, "0"));
      }
    }
    const lines = [];
    for (let i = 0; i < values.length; i += 12) lines.push("   " + values.slice(i, i + 12).join(", "));
    const text = `#define image_width ${w}\n#define image_height ${h}\nstatic unsigned char image_bits[] = {\n${lines.join(",\n")} };\n`;
    return new Blob([text], { type: "image/x-xbitmap" });
  }

  function encodeWbmp(canvas) {
    const w = canvas.width;
    const h = canvas.height;
    const data = flatPixels(canvas);
    const multi = (v) => {
      const out = [v & 127];
      for (v >>= 7; v > 0; v >>= 7) out.unshift((v & 127) | 128);
      return out;
    };
    const rowBytes = (w + 7) >> 3;
    const body = new Uint8Array(rowBytes * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (gray(data[i], data[i + 1], data[i + 2]) >= 128) body[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    return new Bytes().u8(0, 0, ...multi(w), ...multi(h)).raw(body).blob("image/vnd.wap.wbmp");
  }

  // SGI(拡張子で、グレー・RGB・RGBA を書き分ける)
  function encodeSgi(canvas, { ext }) {
    const w = canvas.width;
    const h = canvas.height;
    if (w > 65535 || h > 65535) throw new Error("SGI は 65535 ピクセルまでです");
    const channels = ext === "bw" ? 1 : ext === "rgb" ? 3 : 4;
    const data = channels === 4 ? pixelsOf(canvas) : flatPixels(canvas);
    const bytes = new Bytes().u16(474, false).u8(0, 1).u16(channels === 1 ? 2 : 3, false).u16(w, false).u16(h, false).u16(channels, false);
    bytes.u32(0, false).u32(255, false).zeros(4).zeros(80).u32(0, false).zeros(404);
    const body = new Uint8Array(w * h * channels);
    for (let c = 0; c < channels; c++) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = ((h - 1 - y) * w + x) * 4; // 下の行から並べる
          body[(c * h + y) * w + x] = channels === 1 ? gray(data[i], data[i + 1], data[i + 2]) : data[i + c];
        }
      }
    }
    return bytes.raw(body).blob("image/sgi");
  }

  // Sun ラスター(24 ビット。透明は白に重ねる)
  function encodeRas(canvas) {
    const w = canvas.width;
    const h = canvas.height;
    const data = flatPixels(canvas);
    const rowBytes = (w * 3 + 1) & ~1;
    const body = new Uint8Array(rowBytes * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = (y * w + x) * 4;
        const o = y * rowBytes + x * 3;
        body[o] = data[s + 2];
        body[o + 1] = data[s + 1];
        body[o + 2] = data[s];
      }
    }
    return new Bytes().u32(0x59a66a95, false).u32(w, false).u32(h, false).u32(24, false).u32(body.length, false).u32(1, false).u32(0, false).u32(0, false).raw(body).blob("image/x-cmu-raster");
  }

  function encodeDds(canvas) {
    const w = canvas.width;
    const h = canvas.height;
    const data = pixelsOf(canvas);
    const body = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      body[i * 4] = data[i * 4 + 2];
      body[i * 4 + 1] = data[i * 4 + 1];
      body[i * 4 + 2] = data[i * 4];
      body[i * 4 + 3] = data[i * 4 + 3];
    }
    const bytes = new Bytes().text("DDS ").u32(124).u32(0x100f).u32(h).u32(w).u32(w * 4).u32(0).u32(0).zeros(44);
    bytes.u32(32).u32(0x41).u32(0).u32(32).u32(0xff0000).u32(0xff00).u32(0xff).u32(0xff000000);
    bytes.u32(0x1000).u32(0).u32(0).u32(0).u32(0).raw(body);
    return bytes.blob("image/vnd.ms-dds");
  }

  async function encodePsd(canvas) {
    await loadScript(LIBS.psd);
    return new Blob([agPsd.writePsd({ width: canvas.width, height: canvas.height, canvas })], { type: "image/vnd.adobe.photoshop" });
  }

  async function encodeIcns(canvas) {
    const icon = fitCanvas(canvas, 256, true);
    const png = new Uint8Array(await (await toBlob(icon, "image/png")).arrayBuffer());
    return new Bytes().text("icns").u32(8 + 8 + png.length, false).text("ic08").u32(8 + png.length, false).raw(png).blob("image/icns");
  }

  // Radiance HDR(RGBE)。8 ビットの値を、画面の明るさの関係(ガンマ 2.2)に合わせて光の量に直して書く
  function encodeHdr(canvas) {
    const w = canvas.width;
    const h = canvas.height;
    const data = flatPixels(canvas);
    const body = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const rgb = [0, 1, 2].map((c) => Math.pow(data[i * 4 + c] / 255, 2.2));
      const max = Math.max(...rgb);
      if (max < 1e-32) continue;
      const e = Math.floor(Math.log2(max)) + 1;
      const scale = 256 / Math.pow(2, e);
      body[i * 4] = Math.min(255, Math.floor(rgb[0] * scale));
      body[i * 4 + 1] = Math.min(255, Math.floor(rgb[1] * scale));
      body[i * 4 + 2] = Math.min(255, Math.floor(rgb[2] * scale));
      body[i * 4 + 3] = e + 128;
    }
    return new Bytes().text(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h} +X ${w}\n`).raw(body).blob("image/vnd.radiance");
  }

  // SVG / SVGZ: ベクター画像に変換するのではなく、画像(PNG)を SVG の中に埋め込む
  async function encodeSvg(canvas, { ext }) {
    const png = await toBlob(canvas, "image/png");
    const url = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(png);
    });
    const w = canvas.width;
    const h = canvas.height;
    const text = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n  <image width="${w}" height="${h}" href="${url}" xlink:href="${url}"/>\n</svg>\n`;
    if (ext !== "svgz") return new Blob([text], { type: "image/svg+xml" });
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Blob([await new Response(stream).arrayBuffer()], { type: "image/svg+xml" });
  }

  // ---------- 形式の一覧 ----------
  // quality: 画質を調整できる形式 / note: 選んだときに添える注意
  const FORMATS = [
    { id: "png", label: "PNG", exts: ["png"], encode: viaCanvas("image/png") },
    { id: "jpeg", label: "JPEG", exts: ["jpg", "jpeg", "jpe", "jfif", "jif", "jfi"], quality: true, defaultQuality: 85, encode: viaCanvas("image/jpeg", { flat: true }), note: "透明な部分は白になります" },
    { id: "webp", label: "WebP", exts: ["webp"], quality: true, defaultQuality: 85, encode: viaCanvas("image/webp") },
    { id: "avif", label: "AVIF", exts: ["avif"], quality: true, defaultQuality: 60, encode: encodeAvif, note: "初回は変換用のプログラム(約 3.5 MB)を読み込むため、時間がかかります" },
    { id: "jxl", label: "JPEG XL", exts: ["jxl"], quality: true, defaultQuality: 80, encode: encodeJxl, note: "初回は変換用のプログラム(約 1.4 MB)を読み込むため、時間がかかります。多くのブラウザでは表示できません" },
    { id: "gif", label: "GIF", exts: ["gif"], encode: encodeGif, note: "256 色に減らします(動きのない 1 枚の画像になります)" },
    { id: "bmp", label: "BMP", exts: ["bmp", "dib"], encode: encodeBmp, note: "透明な部分は白になります" },
    { id: "ico", label: "ICO(アイコン)", exts: ["ico", "cur"], encode: encodeIco, note: "256 ピクセルより大きいときは、縮小します" },
    { id: "tiff", label: "TIFF", exts: ["tif", "tiff"], encode: encodeTiff, note: "圧縮しないので、ファイルが大きくなります" },
    { id: "apng", label: "APNG", exts: ["apng"], encode: viaCanvas("image/apng"), note: "動きのない 1 枚の画像(PNG と同じ中身)です" },
    { id: "psd", label: "Photoshop (PSD)", exts: ["psd"], encode: encodePsd, note: "レイヤーのない 1 枚の画像になります" },
    { id: "tga", label: "TGA (Targa)", exts: ["tga", "targa", "icb", "vda", "vst"], encode: encodeTga },
    { id: "dds", label: "DDS", exts: ["dds"], encode: encodeDds, note: "圧縮しない形式(32 ビット)で書き出します" },
    { id: "qoi", label: "QOI", exts: ["qoi"], encode: encodeQoi },
    { id: "icns", label: "ICNS (Mac のアイコン)", exts: ["icns"], encode: encodeIcns, note: "256 × 256 ピクセルのアイコンにします" },
    { id: "svg", label: "SVG(画像を埋め込み)", exts: ["svg", "svgz"], encode: encodeSvg, note: "ベクター画像にはなりません。画像(PNG)を SVG の中に埋め込みます" },
    { id: "ppm", label: "PPM / PNM (カラー)", exts: ["ppm", "pnm"], encode: encodePnm("ppm"), note: "透明な部分は白になります" },
    { id: "pgm", label: "PGM (グレー)", exts: ["pgm"], encode: encodePnm("pgm"), note: "白黒(グレー)になります" },
    { id: "pbm", label: "PBM (白黒 2 値)", exts: ["pbm"], encode: encodePnm("pbm"), note: "白と黒の 2 色になります" },
    { id: "pam", label: "PAM (透明つき)", exts: ["pam"], encode: encodePnm("pam") },
    { id: "pcx", label: "PCX", exts: ["pcx"], encode: encodePcx, note: "透明な部分は白になります" },
    { id: "ff", label: "farbfeld", exts: ["ff"], encode: encodeFarbfeld },
    { id: "sgi", label: "SGI", exts: ["sgi", "rgba", "rgb", "bw"], encode: encodeSgi, note: "拡張子が .rgb なら透明なし、.bw ならグレーで書き出します" },
    { id: "ras", label: "Sun ラスター", exts: ["ras", "sun"], encode: encodeRas, note: "透明な部分は白になります" },
    { id: "hdr", label: "Radiance HDR", exts: ["hdr", "rgbe", "pic"], encode: encodeHdr, note: "透明な部分は白になります" },
    { id: "xbm", label: "XBM (白黒)", exts: ["xbm"], encode: encodeXbm, note: "白と黒の 2 色になります" },
    { id: "wbmp", label: "WBMP (白黒)", exts: ["wbmp", "wbm"], encode: encodeWbmp, note: "白と黒の 2 色になります" },
  ];

  // ---------- 変換先の検索 ----------
  // 「.jpg」「jpg」「JPEG」「ico」「フォトショップ」などから、形式と拡張子を探す
  const normalize = (s) => s.trim().toLowerCase().replace(/^\./, "");

  function search(query) {
    const q = normalize(query);
    if (!q) return FORMATS.map((format) => ({ format, ext: format.exts[0] }));
    const hits = [];
    for (const format of FORMATS) {
      let best = null;
      const consider = (score, ext) => {
        if (!best || score < best.score) best = { score, ext };
      };
      for (const ext of format.exts) {
        if (ext === q) consider(0, ext);
        else if (ext.startsWith(q)) consider(1, ext);
      }
      const label = format.label.toLowerCase();
      if (format.id === q || label.startsWith(q)) consider(2, format.exts[0]);
      else if (label.includes(q) || format.id.includes(q)) consider(3, format.exts[0]);
      for (const ext of format.exts) if (ext.includes(q)) consider(4, ext);
      if (best) hits.push({ format, ext: best.ext, score: best.score });
    }
    return hits.sort((a, b) => a.score - b.score);
  }

  // 一覧に出なかった拡張子について、理由を返す
  function whyNot(query) {
    const q = normalize(query);
    if (!q) return "";
    if (ImageIn.canRead(q)) return `「.${q}」は読み込みには対応していますが、変換先としては対応していません`;
    if (ImageIn.isImageExt(q)) return `「.${q}」は、変換先としては対応していません`;
    return `「${query.trim()}」に合う形式は見つかりません`;
  }

  async function encode(format, canvas, options) {
    return format.encode(canvas, options);
  }

  return { FORMATS, search, whyNot, encode };
})();
