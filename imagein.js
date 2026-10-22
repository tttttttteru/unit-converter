// 画像の読み込み(デコード)。ブラウザが標準で読めない形式は、自前のコードか外部ライブラリで読む。
// どの拡張子をどう読むかは、下の READERS に並べてある。形式を増やすときは、ここに足す。
window.ImageIn = (() => {
  const { loadScript, LIBS } = Tools;
  const MAX_PIXELS = 150e6;

  // 利用者にそのまま見せてよい、日本語のメッセージ付きのエラー
  class UserError extends Error {}
  const fail = (message) => {
    throw new UserError(message);
  };

  const makeCanvas = (w, h) => {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    return canvas;
  };

  function checkSize(w, h) {
    if (!(w > 0 && h > 0)) fail("画像のサイズが正しくありません");
    if (w * h > MAX_PIXELS) fail("画像が大きすぎて読み込めません");
  }

  // RGBA の並び(1 画素 4 バイト)から、canvas を作る
  function canvasFromRGBA(w, h, data) {
    checkSize(w, h);
    const canvas = makeCanvas(w, h);
    const pixels = data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data.buffer, data.byteOffset, w * h * 4);
    canvas.getContext("2d").putImageData(new ImageData(pixels, w, h), 0, 0);
    return canvas;
  }

  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const be16 = (b, o) => (b[o] << 8) | b[o + 1];
  const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));
  const startsWith = (b, s, at = 0) => ascii(b, at, s.length) === s;
  const startsWithBytes = (b, values) => values.every((v, i) => b[i] === v);

  // ---------- ブラウザが標準で読める形式 ----------
  async function decodeNative(bytes, { mime } = {}) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(new Blob([bytes], mime ? { type: mime } : {}));
    } catch {
      fail("このブラウザでは読み込めない形式か、壊れたファイルです");
    }
    checkSize(bitmap.width, bitmap.height);
    const canvas = makeCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return { canvas };
  }

  // BMP のファイルヘッダーがない「DIB」に、ヘッダーを付けて読む
  function decodeDib(bytes) {
    const headerSize = u32(bytes, 0);
    const bpp = u16(bytes, 14);
    const compression = u32(bytes, 16);
    const used = u32(bytes, 32);
    const palette = (bpp <= 8 ? used || 1 << bpp : used) * 4;
    const masks = headerSize === 40 && (compression === 3 || compression === 6) ? (compression === 3 ? 12 : 16) : 0;
    const file = new Uint8Array(14 + bytes.length);
    file.set([0x42, 0x4d]);
    new DataView(file.buffer).setUint32(2, file.length, true);
    new DataView(file.buffer).setUint32(10, 14 + headerSize + masks + palette, true);
    file.set(bytes, 14);
    return decodeNative(file, { mime: "image/bmp" });
  }

  // アイコン・カーソルは、いろいろな大きさの画像が 1 つのファイルに入っている。いちばん大きいものだけを取り出して読む
  // (カーソル (.cur) は、アイコンと種類の番号が違うだけ)
  function decodeCur(bytes) {
    const count = u16(bytes, 4);
    let best = null;
    for (let i = 0; i < count; i++) {
      const at = 6 + i * 16;
      const side = (bytes[at] || 256) * (bytes[at + 1] || 256);
      if (!best || side > best.side) best = { side, at };
    }
    if (!best) fail("アイコンの中に画像が入っていません");
    const size = u32(bytes, best.at + 8);
    const offset = u32(bytes, best.at + 12);
    const single = new Uint8Array(22 + size);
    single.set([0, 0, 1, 0, 1, 0]);
    single.set(bytes.subarray(best.at, best.at + 16), 6);
    new DataView(single.buffer).setUint32(18, 22, true);
    single.set(bytes.subarray(offset, offset + size), 22);
    return decodeNative(single, { mime: "image/x-icon" });
  }

  // アニメーションカーソル (.ani): 中に入っているカーソルの最初の 1 枚を読む
  function decodeAni(bytes) {
    if (!startsWith(bytes, "RIFF") || !startsWith(bytes, "ACON", 8)) fail("ANI ファイルとして読み込めません");
    for (let i = 12; i + 8 < bytes.length; i++) {
      if (startsWith(bytes, "icon", i)) {
        const size = u32(bytes, i + 4);
        return decodeCur(bytes.subarray(i + 8, i + 8 + size));
      }
    }
    fail("ANI ファイルの中に画像が見つかりません");
  }

  // ICNS: 中の PNG 形式の画像のうち、いちばん大きいものを読む
  function decodeIcns(bytes) {
    if (!startsWith(bytes, "icns")) fail("ICNS ファイルとして読み込めません");
    let best = null;
    for (let pos = 8; pos + 8 <= bytes.length; ) {
      const size = be32(bytes, pos + 4);
      if (size < 8) break;
      const data = bytes.subarray(pos + 8, pos + size);
      if (startsWithBytes(data, [0x89, 0x50, 0x4e, 0x47]) && (!best || data.length > best.length)) best = data;
      pos += size;
    }
    if (!best) fail("この ICNS には、PNG 形式の画像が含まれていません");
    return decodeNative(best, { mime: "image/png" });
  }

  // ---------- SVG ----------
  async function gunzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function decodeSvg(bytes) {
    const notes = [];
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);
    const text = new TextDecoder().decode(bytes);
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    const svg = doc.documentElement;
    if (doc.querySelector("parsererror") || svg.nodeName.toLowerCase() !== "svg") fail("SVG として読み込めません");

    // 大きさは width / height、なければ viewBox から決める(% 指定は使わない)
    const length = (name) => (/^\s*[\d.]+(px)?\s*$/.test(svg.getAttribute(name) ?? "") ? parseFloat(svg.getAttribute(name)) : NaN);
    const box = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
    let w = length("width");
    let h = length("height");
    if (!(w > 0)) w = box.length === 4 && box[2] > 0 ? box[2] : 512;
    if (!(h > 0)) h = box.length === 4 && box[3] > 0 ? box[3] : 512;

    // SVG は拡大しても荒れないので、小さいときは長辺 1024px にそろえる
    if (Math.max(w, h) < 1024) {
      const k = 1024 / Math.max(w, h);
      w *= k;
      h *= k;
      notes.push("SVG はベクター画像なので、長辺 1024px の画像にしました");
    }
    w = Math.round(w);
    h = Math.round(h);
    checkSize(w, h);

    const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const canvas = makeCanvas(w, h);
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      return { canvas, notes };
    } catch {
      fail("SVG として読み込めません");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // ---------- 外部ライブラリを使う形式 ----------
  // UTIF は、JPEG 圧縮の TIFF を必ず YCbCr として色変換する。TIFF に「色は RGB のまま」と書かれているときは、その変換を止める
  let utifKeepRgb = false;
  function patchUtif() {
    const proto = UTIF.JpegDecoder.prototype;
    if (proto.keepRgbPatched) return;
    const original = proto.getData;
    proto.getData = function (width, height, forceRgb) {
      if (utifKeepRgb) this.B = 0; // B は、JPEG の色変換の有無(0 なら、変換しない)
      return original.call(this, width, height, forceRgb);
    };
    proto.keepRgbPatched = true;
  }

  // UTIF が扱える圧縮方式と、色の形式(それ以外は、エラーを出さずに空白の画像を返してしまうので、先に断る)
  const TIFF_COMPRESSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 32773, 32809, 32946, 34892];
  const TIFF_PHOTOMETRICS = [0, 1, 2, 3, 5, 6];

  // 2・4 ビットのグレー(UTIF が対応していないもの)を RGBA にする
  function lowBitGray(ifd) {
    const bits = ifd.t258?.[0];
    const photometric = ifd.t262?.[0];
    if (!(photometric === 0 || photometric === 1) || (bits !== 2 && bits !== 4) || (ifd.t277?.[0] ?? 1) !== 1) return null;
    const { width: w, height: h, data } = ifd;
    const perRow = Math.ceil((bits * w) / 8);
    const max = (1 << bits) - 1;
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const bit = x * bits;
        let v = (data[y * perRow + (bit >> 3)] >> (8 - bits - (bit & 7))) & max;
        if (photometric === 0) v = max - v; // 0 が白
        out.fill(Math.round((v * 255) / max), (y * w + x) * 4, (y * w + x) * 4 + 3);
        out[(y * w + x) * 4 + 3] = 255;
      }
    }
    return out;
  }

  async function decodeTiff(bytes) {
    await loadScript(LIBS.pako);
    await loadScript(LIBS.utif);
    patchUtif();
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    try {
      const ifds = UTIF.decode(buffer);
      if (!ifds.length) throw new Error();
      // 複数ページのときは、いちばん大きいページを使う
      const area = (ifd) => (ifd.t256?.[0] ?? 0) * (ifd.t257?.[0] ?? 0);
      ifds.sort((a, b) => area(b) - area(a));
      const ifd = ifds[0];
      if (!TIFF_COMPRESSIONS.includes(ifd.t259?.[0] ?? 1)) throw new UserError("この TIFF の圧縮方式には対応していません");
      if (!TIFF_PHOTOMETRICS.includes(ifd.t262?.[0] ?? 2)) throw new UserError("この TIFF の色の形式には対応していません");
      utifKeepRgb = [6, 7].includes(ifd.t259?.[0]) && ifd.t262?.[0] === 2;
      try {
        UTIF.decodeImage(buffer, ifd);
      } finally {
        utifKeepRgb = false;
      }
      const data = lowBitGray(ifd) ?? UTIF.toRGBA8(ifd);
      // どの画素も透明なら、読み取りに失敗している
      let visible = false;
      for (let i = 3; i < data.length && !visible; i += 4) visible = data[i] !== 0;
      if (!visible) throw new UserError("この TIFF の形式には対応していません");
      return { data, width: ifd.width, height: ifd.height };
    } catch (e) {
      if (e instanceof UserError) throw e;
      fail("TIFF として読み込めません(壊れているか、対応していない形式かもしれません)");
    }
  }

  async function decodePsd(bytes) {
    await loadScript(LIBS.psd);
    let psd;
    try {
      psd = agPsd.readPsd(bytes, { skipLayerImageData: true, skipThumbnail: true });
    } catch {
      fail("Photoshop ファイルとして読み込めません");
    }
    if (!psd.canvas) fail("合成画像が含まれていません(Photoshop で「互換性を優先」を有効にして保存してください)");
    return { canvas: psd.canvas };
  }

  async function decodeHeic(bytes) {
    await loadScript(LIBS.heic);
    try {
      const out = await heic2any({ blob: new Blob([bytes], { type: "image/heic" }), toType: "image/png" });
      const blob = Array.isArray(out) ? out[0] : out;
      return decodeNative(new Uint8Array(await blob.arrayBuffer()), { mime: "image/png" });
    } catch {
      fail("HEIC / HEIF として読み込めません");
    }
  }

  // JPEG XL(WebAssembly 版)。ブラウザ標準で読めないときに使う
  async function decodeJxl(bytes) {
    try {
      const decode = (await import(LIBS.jsquash + "jxl@1.3.0/decode.js")).default;
      const image = await decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      return { data: image.data, width: image.width, height: image.height };
    } catch {
      fail("JPEG XL として読み込めません");
    }
  }

  // ---------- 自前で読む形式 ----------
  // TGA(拡張子 .tga .targa .icb .vda .vst)
  function decodeTga(b) {
    const idLength = b[0];
    const mapType = b[1];
    const type = b[2];
    const mapFirst = u16(b, 3);
    const mapLength = u16(b, 5);
    const mapBits = b[7];
    const w = u16(b, 12);
    const h = u16(b, 14);
    const bpp = b[16];
    const descriptor = b[17];
    if (![1, 2, 3, 9, 10, 11].includes(type) || !w || !h) fail("TGA として読み込めません");
    checkSize(w, h);
    const rle = type >= 9;
    const kind = type & 7; // 1: パレット, 2: フルカラー, 3: グレー
    const perPixel = (bpp + 7) >> 3;
    const mapBytes = (mapBits + 7) >> 3;
    let pos = 18 + idLength;
    const palette = [];
    if (mapType === 1) {
      for (let i = 0; i < mapLength; i++, pos += mapBytes) palette.push(readColor(b, pos, mapBits));
    }

    // 1 画素ぶんを RGBA にする
    function readColor(src, at, bits) {
      if (bits === 8) return [src[at], src[at], src[at], 255];
      if (bits === 16 && kind === 3) return [src[at], src[at], src[at], src[at + 1]];
      if (bits === 15 || bits === 16) {
        const v = src[at] | (src[at + 1] << 8);
        const c = (n) => ((n << 3) | (n >> 2)) & 255;
        return [c((v >> 10) & 31), c((v >> 5) & 31), c(v & 31), bits === 16 && !(v & 0x8000) && (descriptor & 15) === 1 ? 0 : 255];
      }
      if (bits === 24) return [src[at + 2], src[at + 1], src[at], 255];
      return [src[at + 2], src[at + 1], src[at], (descriptor & 15) === 0 ? 255 : src[at + 3]];
    }
    const pixelAt = (src, at) => {
      if (kind === 1) {
        const index = (perPixel === 2 ? u16(src, at) : src[at]) - mapFirst;
        return palette[index] ?? [0, 0, 0, 255];
      }
      return readColor(src, at, bpp);
    };

    const pixels = [];
    if (rle) {
      while (pixels.length < w * h && pos < b.length) {
        const head = b[pos++];
        const count = (head & 127) + 1;
        if (head & 128) {
          const color = pixelAt(b, pos);
          pos += perPixel;
          for (let i = 0; i < count; i++) pixels.push(color);
        } else {
          for (let i = 0; i < count; i++, pos += perPixel) pixels.push(pixelAt(b, pos));
        }
      }
    } else {
      for (let i = 0; i < w * h && pos + perPixel <= b.length; i++, pos += perPixel) pixels.push(pixelAt(b, pos));
    }
    if (pixels.length < w * h) fail("TGA のデータが足りません(壊れているかもしれません)");

    const out = new Uint8ClampedArray(w * h * 4);
    const topFirst = descriptor & 0x20;
    const rightFirst = descriptor & 0x10;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = rightFirst ? w - 1 - x : x;
        const sy = topFirst ? y : h - 1 - y;
        out.set(pixels[sy * w + sx], (y * w + x) * 4);
      }
    }
    return { data: out, width: w, height: h };
  }

  // PBM / PGM / PPM / PNM / PAM / PFM
  function decodePnm(b) {
    let pos = 0;
    const token = () => {
      for (;;) {
        while (pos < b.length && b[pos] <= 32) pos++;
        if (b[pos] !== 0x23) break;
        while (pos < b.length && b[pos] !== 10) pos++; // # から行末までは注釈
      }
      let s = "";
      while (pos < b.length && b[pos] > 32) s += String.fromCharCode(b[pos++]);
      return s;
    };
    const magic = token();
    let w;
    let h;
    let maxval = 1;
    let depth;
    let alpha = false;
    let float = false;
    let littleEndian = false;
    if (magic === "P7") {
      // PAM: ENDHDR までがヘッダー
      for (;;) {
        const key = token();
        if (key === "ENDHDR" || !key) break;
        const value = token();
        if (key === "WIDTH") w = +value;
        else if (key === "HEIGHT") h = +value;
        else if (key === "DEPTH") depth = +value;
        else if (key === "MAXVAL") maxval = +value;
        else if (key === "TUPLTYPE") alpha ||= /ALPHA/.test(value);
      }
      pos++;
    } else if (/^P[1-6]$/.test(magic)) {
      w = +token();
      h = +token();
      if (!/^P[14]$/.test(magic)) maxval = +token();
      depth = { 1: 1, 2: 1, 3: 3, 4: 1, 5: 1, 6: 3 }[magic[1]];
      if (/^P[1-3]$/.test(magic)) pos += 0;
      else pos++; // バイナリ形式は、ヘッダーの後に空白 1 文字が入る
    } else if (magic === "PF" || magic === "Pf") {
      float = true;
      depth = magic === "PF" ? 3 : 1;
      w = +token();
      h = +token();
      littleEndian = +token() < 0;
      pos++;
    } else {
      fail("PNM として読み込めません");
    }
    if (!(w > 0 && h > 0) || !depth) fail("PNM のヘッダーが正しくありません");
    checkSize(w, h);
    const out = float ? new Float32Array(w * h * 4) : new Uint8ClampedArray(w * h * 4); // PFM は、255 を超える値も入るので、小数のまま持つ
    const isText = /^P[1-3]$/.test(magic);
    const bits = magic === "P4";
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const rowBytes = (w + 7) >> 3;
    const dataStart = pos;
    // P1 は 0 と 1 が空白なしで続くことがあるので、1 文字ずつ読む
    const bitChar = () => {
      while (pos < b.length && b[pos] <= 32) pos++;
      return b[pos++] === 0x31 ? 0 : 255;
    };

    for (let y = 0; y < h; y++) {
      const row = float ? h - 1 - y : y; // PFM は下の行から入っている
      for (let x = 0; x < w; x++) {
        const o = (row * w + x) * 4;
        const channels = [];
        for (let c = 0; c < depth; c++) {
          let v;
          if (float) {
            v = view.getFloat32(pos, littleEndian);
            pos += 4;
            v = Math.max(0, v);
          } else if (bits) {
            v = (b[dataStart + y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 0 : 255;
          } else if (magic === "P1") {
            v = bitChar();
          } else if (isText) {
            v = (+token() / maxval) * 255;
          } else if (maxval > 255) {
            v = (be16(b, pos) / maxval) * 255;
            pos += 2;
          } else {
            v = (b[pos++] / maxval) * 255;
          }
          channels.push(v);
        }
        if (depth >= 3) out.set([channels[0], channels[1], channels[2], alpha && depth >= 4 ? channels[3] : 255], o);
        else out.set([channels[0], channels[0], channels[0], alpha && depth === 2 ? channels[1] : 255], o);
      }
    }
    if (float) {
      // 0〜1 の光の量なら、画面用に明るさを直す。0〜255 の値で入っているもの(よくある)は、そのまま使う
      let max = 0;
      for (let i = 0; i < out.length; i += 4) for (let c = 0; c < 3; c++) max = Math.max(max, out[i + c]);
      const bytes = new Uint8ClampedArray(out.length);
      for (let i = 0; i < out.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          const v = out[i + c];
          bytes[i + c] = max <= 1 ? 255 * Math.pow(v, 1 / 2.2) : max <= 255.001 ? v : 255 * Math.pow(v / max, 1 / 2.2);
        }
        bytes[i + 3] = 255;
      }
      return { data: bytes, width: w, height: h };
    }
    return { data: out, width: w, height: h };
  }

  // PCX / DCX
  function decodePcx(b) {
    if (u32(b, 0) === 0x3ade68b1) b = b.subarray(u32(b, 4)); // DCX は、複数の PCX を束ねたもの。最初の 1 枚を使う
    if (b[0] !== 10) fail("PCX として読み込めません");
    const bpp = b[3];
    const w = u16(b, 8) - u16(b, 4) + 1;
    const h = u16(b, 10) - u16(b, 6) + 1;
    const planes = b[65];
    const lineBytes = u16(b, 66);
    checkSize(w, h);
    if (!planes || !lineBytes || lineBytes * 8 < w * bpp) fail("PCX のヘッダーが正しくありません(壊れているファイルかもしれません)");
    const total = planes * lineBytes;
    const out = new Uint8ClampedArray(w * h * 4);
    let pos = 128;

    let palette256 = null;
    if (bpp === 8 && planes === 1 && b.length - 769 >= 128 && b[b.length - 769] === 12) palette256 = b.subarray(b.length - 768);

    for (let y = 0; y < h; y++) {
      const line = new Uint8Array(total);
      for (let i = 0; i < total && pos < b.length; ) {
        let v = b[pos++];
        let count = 1;
        if (b[2] === 1 && (v & 0xc0) === 0xc0) {
          count = v & 0x3f;
          v = b[pos++];
        }
        for (let k = 0; k < count && i < total; k++) line[i++] = v;
      }
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        let rgb;
        if (bpp === 8 && planes >= 3) {
          rgb = [line[x], line[lineBytes + x], line[2 * lineBytes + x], planes === 4 ? line[3 * lineBytes + x] : 255];
        } else if (bpp === 8 && planes === 1) {
          const i = line[x];
          rgb = palette256 ? [palette256[i * 3], palette256[i * 3 + 1], palette256[i * 3 + 2], 255] : [i, i, i, 255];
        } else if (bpp === 1) {
          // 1 ビットずつ、各プレーンから集めて色番号にする(1 プレーンなら白黒)
          let index = 0;
          for (let p = 0; p < planes; p++) index |= ((line[p * lineBytes + (x >> 3)] >> (7 - (x & 7))) & 1) << p;
          if (planes === 1) rgb = index ? [255, 255, 255, 255] : [0, 0, 0, 255];
          else rgb = [b[16 + index * 3], b[17 + index * 3], b[18 + index * 3], 255];
        } else if (bpp === 4 && planes === 1) {
          const index = (line[x >> 1] >> (x & 1 ? 0 : 4)) & 15;
          rgb = [b[16 + index * 3], b[17 + index * 3], b[18 + index * 3], 255];
        } else {
          fail("この PCX の色の形式には対応していません");
        }
        out.set(rgb, o);
      }
    }
    return { data: out, width: w, height: h };
  }

  // QOI
  function decodeQoi(b) {
    if (!startsWith(b, "qoif")) fail("QOI として読み込めません");
    const w = be32(b, 4);
    const h = be32(b, 8);
    checkSize(w, h);
    const out = new Uint8ClampedArray(w * h * 4);
    const index = new Uint8Array(64 * 4);
    let r = 0;
    let g = 0;
    let bl = 0;
    let a = 255;
    let pos = 14;
    for (let p = 0; p < w * h; ) {
      let run = 0;
      if (pos >= b.length) fail("QOI のデータが足りません(壊れているかもしれません)");
      const op = b[pos++];
      if (op === 0xfe) {
        r = b[pos++];
        g = b[pos++];
        bl = b[pos++];
      } else if (op === 0xff) {
        r = b[pos++];
        g = b[pos++];
        bl = b[pos++];
        a = b[pos++];
      } else if ((op & 0xc0) === 0x00) {
        const i = (op & 63) * 4;
        [r, g, bl, a] = [index[i], index[i + 1], index[i + 2], index[i + 3]];
      } else if ((op & 0xc0) === 0x40) {
        r = (r + ((op >> 4) & 3) - 2) & 255;
        g = (g + ((op >> 2) & 3) - 2) & 255;
        bl = (bl + (op & 3) - 2) & 255;
      } else if ((op & 0xc0) === 0x80) {
        const next = b[pos++];
        const dg = (op & 63) - 32;
        r = (r + dg - 8 + ((next >> 4) & 15)) & 255;
        g = (g + dg) & 255;
        bl = (bl + dg - 8 + (next & 15)) & 255;
      } else {
        run = op & 63;
      }
      const hash = ((r * 3 + g * 5 + bl * 7 + a * 11) % 64) * 4;
      index[hash] = r;
      index[hash + 1] = g;
      index[hash + 2] = bl;
      index[hash + 3] = a;
      for (let k = 0; k <= run && p < w * h; k++, p++) out.set([r, g, bl, a], p * 4);
    }
    return { data: out, width: w, height: h };
  }

  // Radiance HDR(RGBE)。明るさの幅が広い画像なので、画面で見られる 8 ビットに丸める
  function decodeHdr(b) {
    let pos = 0;
    const readLine = () => {
      let s = "";
      while (pos < b.length && b[pos] !== 10) s += String.fromCharCode(b[pos++]);
      pos++;
      return s;
    };
    if (!/^#\?(RADIANCE|RGBE)/.test(readLine())) fail("HDR として読み込めません");
    while (pos < b.length && readLine().trim() !== "") {
      // 空行までがヘッダー
    }
    const m = /^([-+])Y\s+(\d+)\s+([-+])X\s+(\d+)/.exec(readLine().trim());
    if (!m) fail("HDR のサイズの記述が読み取れません");
    const h = +m[2];
    const w = +m[4];
    const flipY = m[1] === "+";
    const flipX = m[3] === "-";
    checkSize(w, h);
    const out = new Uint8ClampedArray(w * h * 4);
    const scan = new Uint8Array(w * 4);

    for (let y = 0; y < h; y++) {
      if (w >= 8 && w < 32768 && b[pos] === 2 && b[pos + 1] === 2 && ((b[pos + 2] << 8) | b[pos + 3]) === w) {
        pos += 4;
        for (let c = 0; c < 4; c++) {
          for (let x = 0; x < w; ) {
            let count = b[pos++];
            if (count > 128) {
              count -= 128;
              const v = b[pos++];
              for (let k = 0; k < count && x < w; k++) scan[(x++) * 4 + c] = v;
            } else {
              for (let k = 0; k < count && x < w; k++) scan[(x++) * 4 + c] = b[pos++];
            }
          }
        }
      } else {
        scan.set(b.subarray(pos, pos + w * 4));
        pos += w * 4;
      }
      const row = flipY ? h - 1 - y : y;
      for (let x = 0; x < w; x++) {
        const e = scan[x * 4 + 3];
        const f = e ? Math.pow(2, e - 136) : 0;
        const o = (row * w + (flipX ? w - 1 - x : x)) * 4;
        for (let c = 0; c < 3; c++) out[o + c] = 255 * Math.pow(Math.min(1, scan[x * 4 + c] * f), 1 / 2.2);
        out[o + 3] = 255;
      }
    }
    return { data: out, width: w, height: h };
  }

  // DDS(DXT1・DXT3・DXT5 = BC1・BC2・BC3 と、非圧縮の RGB・RGBA。DX10 形式のヘッダーにも対応)
  function decodeDds(b) {
    if (!startsWith(b, "DDS ")) fail("DDS として読み込めません");
    const h = u32(b, 12);
    const w = u32(b, 16);
    checkSize(w, h);
    const pfFlags = u32(b, 80);
    let fourcc = pfFlags & 4 ? ascii(b, 84, 4) : "";
    let bits = u32(b, 88);
    let masks = [u32(b, 92), u32(b, 96), u32(b, 100), pfFlags & 1 ? u32(b, 104) : 0];
    let data = 128;

    // DX10 形式: 追加のヘッダー(20 バイト)に、画素の形式の番号が入っている
    if (fourcc === "DX10") {
      const format = u32(b, 128);
      data = 148;
      const blocks = { 71: "DXT1", 72: "DXT1", 74: "DXT3", 75: "DXT3", 77: "DXT5", 78: "DXT5" };
      if (blocks[format]) fourcc = blocks[format];
      else if (format === 28 || format === 29) [fourcc, bits, masks] = ["", 32, [0xff, 0xff00, 0xff0000, 0xff000000]];
      else if (format === 87 || format === 91) [fourcc, bits, masks] = ["", 32, [0xff0000, 0xff00, 0xff, 0xff000000]];
      else fail(`この DDS の画素の形式 (DXGI ${format}) には対応していません`);
    }

    const out = new Uint8ClampedArray(w * h * 4);
    if (fourcc) {
      if (!["DXT1", "DXT3", "DXT5"].includes(fourcc)) fail(`この DDS の圧縮方式 (${fourcc.trim() || "不明"}) には対応していません`);
      const blockBytes = fourcc === "DXT1" ? 8 : 16;
      // 5・6 ビットの色を、上位ビットを複製して 8 ビットにする
      const c565 = (v) => [(((v >> 11) & 31) << 3) | ((v >> 13) & 7), (((v >> 5) & 63) << 2) | ((v >> 9) & 3), ((v & 31) << 3) | ((v >> 2) & 7)];
      for (let by = 0; by < Math.ceil(h / 4); by++) {
        for (let bx = 0; bx < Math.ceil(w / 4); bx++) {
          const at = data + (by * Math.ceil(w / 4) + bx) * blockBytes;
          const cAt = fourcc === "DXT1" ? at : at + 8;
          const c0 = u16(b, cAt);
          const c1 = u16(b, cAt + 2);
          const p0 = c565(c0);
          const p1 = c565(c1);
          const colors = [p0, p1];
          let transparentIndex3 = false;
          if (c0 > c1 || fourcc !== "DXT1") {
            colors.push(p0.map((v, i) => Math.floor((2 * v + p1[i]) / 3)), p0.map((v, i) => Math.floor((v + 2 * p1[i]) / 3)));
          } else {
            colors.push(p0.map((v, i) => (v + p1[i]) >> 1), [0, 0, 0]);
            transparentIndex3 = true;
          }
          // アルファ値
          const alphas = new Array(16).fill(255);
          if (fourcc === "DXT3") {
            for (let i = 0; i < 16; i++) alphas[i] = ((b[at + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
          } else if (fourcc === "DXT5") {
            const a0 = b[at];
            const a1 = b[at + 1];
            const table = [a0, a1];
            if (a0 > a1) for (let i = 1; i < 7; i++) table.push(Math.floor(((7 - i) * a0 + i * a1) / 7));
            else {
              for (let i = 1; i < 5; i++) table.push(Math.floor(((5 - i) * a0 + i * a1) / 5));
              table.push(0, 255);
            }
            let bitsValue = 0n;
            for (let i = 0; i < 6; i++) bitsValue |= BigInt(b[at + 2 + i]) << BigInt(8 * i);
            for (let i = 0; i < 16; i++) alphas[i] = table[Number((bitsValue >> BigInt(3 * i)) & 7n)];
          }
          const indices = u32(b, cAt + 4);
          for (let i = 0; i < 16; i++) {
            const x = bx * 4 + (i & 3);
            const y = by * 4 + (i >> 2);
            if (x >= w || y >= h) continue;
            const ci = (indices >> (2 * i)) & 3;
            const color = colors[ci];
            const alpha = transparentIndex3 && ci === 3 ? 0 : alphas[i];
            out.set([color[0], color[1], color[2], alpha], (y * w + x) * 4);
          }
        }
      }
    } else if (masks[0] || masks[1] || masks[2]) {
      const bytesPer = bits >> 3;
      const extract = (value, mask) => {
        if (!mask) return null;
        let shift = 0;
        while (!((mask >>> shift) & 1)) shift++;
        const max = mask >>> shift;
        return Math.round((((value & mask) >>> shift) * 255) / max);
      };
      for (let i = 0; i < w * h; i++) {
        let v = 0;
        for (let k = 0; k < bytesPer; k++) v |= b[data + i * bytesPer + k] << (8 * k);
        v >>>= 0;
        out.set([extract(v, masks[0]) ?? 0, extract(v, masks[1]) ?? 0, extract(v, masks[2]) ?? 0, extract(v, masks[3]) ?? 255], i * 4);
      }
    } else {
      fail("この DDS の形式には対応していません");
    }
    return { data: out, width: w, height: h };
  }

  // XBM(C 言語のソースの形をした白黒画像)
  function decodeXbm(b) {
    const text = new TextDecoder().decode(b);
    const w = +/_width\s+(\d+)/.exec(text)?.[1];
    const h = +/_height\s+(\d+)/.exec(text)?.[1];
    const body = text.slice(text.indexOf("{") + 1);
    const values = (body.match(/0x[0-9a-fA-F]+/g) ?? []).map((v) => parseInt(v, 16));
    if (!(w > 0 && h > 0) || !values.length) fail("XBM として読み込めません");
    checkSize(w, h);
    const rowBytes = (w + 7) >> 3;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const black = (values[y * rowBytes + (x >> 3)] >> (x & 7)) & 1;
        out.set(black ? [0, 0, 0, 255] : [255, 255, 255, 255], (y * w + x) * 4);
      }
    }
    return { data: out, width: w, height: h };
  }

  // XPM(文字で絵を描いたような、色つきの画像)
  function decodeXpm(b) {
    const text = new TextDecoder().decode(b);
    const strings = [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    const [w, h, count, cpp] = (strings[0] ?? "").trim().split(/\s+/).map(Number);
    if (!(w > 0 && h > 0 && count > 0 && cpp > 0)) fail("XPM として読み込めません");
    checkSize(w, h);
    const named = { black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00", cyan: "#00ffff", magenta: "#ff00ff", gray: "#bebebe", grey: "#bebebe" };
    const colors = new Map();
    for (let i = 1; i <= count; i++) {
      const line = strings[i] ?? "";
      const key = line.slice(0, cpp);
      const m = /\b[cs]\s+(\S+)/.exec(line.slice(cpp));
      let value = m?.[1] ?? "None";
      value = named[value.toLowerCase()] ?? value;
      if (/^none$/i.test(value)) colors.set(key, [0, 0, 0, 0]);
      else if (/^#([0-9a-f]{6}|[0-9a-f]{12})$/i.test(value)) {
        const hex = value.slice(1);
        const step = hex.length / 3;
        colors.set(key, [0, 1, 2].map((c) => parseInt(hex.slice(c * step, c * step + 2), 16)).concat(255));
      } else colors.set(key, [0, 0, 0, 255]);
    }
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const row = strings[count + 1 + y] ?? "";
      for (let x = 0; x < w; x++) out.set(colors.get(row.slice(x * cpp, x * cpp + cpp)) ?? [0, 0, 0, 0], (y * w + x) * 4);
    }
    return { data: out, width: w, height: h };
  }

  // WBMP(携帯電話向けの白黒画像)
  function decodeWbmp(b) {
    let pos = 2;
    const int = () => {
      let v = 0;
      let byte;
      do {
        byte = b[pos++];
        v = (v << 7) | (byte & 127);
      } while (byte & 128);
      return v;
    };
    if (b[0] !== 0) fail("WBMP として読み込めません");
    const w = int();
    const h = int();
    checkSize(w, h);
    const rowBytes = (w + 7) >> 3;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const white = (b[pos + y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        out.set(white ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * w + x) * 4);
      }
    }
    return { data: out, width: w, height: h };
  }

  // farbfeld(16 ビットの RGBA をそのまま並べた形式)
  function decodeFarbfeld(b) {
    if (!startsWith(b, "farbfeld")) fail("farbfeld として読み込めません");
    const w = be32(b, 8);
    const h = be32(b, 12);
    checkSize(w, h);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h * 4; i++) out[i] = b[16 + i * 2];
    return { data: out, width: w, height: h };
  }

  // Sun ラスター
  function decodeRas(b) {
    if (be32(b, 0) !== 0x59a66a95) fail("Sun ラスターとして読み込めません");
    const w = be32(b, 4);
    const h = be32(b, 8);
    const depth = be32(b, 12);
    const type = be32(b, 20);
    const mapLength = be32(b, 28);
    checkSize(w, h);
    let pos = 32;
    const map = b.subarray(pos, pos + mapLength);
    pos += mapLength;
    let data = b.subarray(pos);
    if (type === 2) {
      // ランレングス圧縮: 0x80 の次が 0 なら 0x80 そのもの、そうでなければ「回数-1, 値」
      const bytes = [];
      for (let i = 0; i < data.length; ) {
        const v = data[i++];
        if (v !== 0x80) bytes.push(v);
        else if (data[i] === 0) {
          bytes.push(0x80);
          i++;
        } else {
          const count = data[i++] + 1;
          const value = data[i++];
          for (let k = 0; k < count; k++) bytes.push(value);
        }
      }
      data = Uint8Array.from(bytes);
    }
    const rowBytes = (((w * depth + 15) >> 4) << 1) || 2;
    const third = mapLength / 3;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const at = y * rowBytes;
        let rgba;
        if (depth === 1) {
          const bit = (data[at + (x >> 3)] >> (7 - (x & 7))) & 1;
          rgba = bit ? [0, 0, 0, 255] : [255, 255, 255, 255];
        } else if (depth === 8) {
          const i = data[at + x];
          rgba = mapLength ? [map[i], map[third + i], map[2 * third + i], 255] : [i, i, i, 255];
        } else if (depth === 24) {
          const o = at + x * 3;
          rgba = type === 3 ? [data[o], data[o + 1], data[o + 2], 255] : [data[o + 2], data[o + 1], data[o], 255];
        } else if (depth === 32) {
          const o = at + x * 4;
          rgba = type === 3 ? [data[o + 1], data[o + 2], data[o + 3], 255] : [data[o + 3], data[o + 2], data[o + 1], 255];
        } else {
          fail("この Sun ラスターの色の深さには対応していません");
        }
        out.set(rgba, (y * w + x) * 4);
      }
    }
    return { data: out, width: w, height: h };
  }

  // SGI(.sgi .rgb .rgba .bw .int .inta)
  function decodeSgi(b) {
    if (be16(b, 0) !== 474) fail("SGI 画像として読み込めません");
    const rle = b[2] === 1;
    const bpc = b[3];
    const w = be16(b, 6);
    const h = be16(b, 8);
    const z = be16(b, 10) || 1;
    checkSize(w, h);
    if (bpc !== 1 && bpc !== 2) fail("この SGI 画像の形式には対応していません");
    const planes = [];
    for (let c = 0; c < z; c++) {
      const plane = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        if (!rle) {
          const start = 512 + (c * h + y) * w * bpc;
          for (let x = 0; x < w; x++) plane[y * w + x] = b[start + x * bpc];
        } else {
          let pos = be32(b, 512 + (c * h + y) * 4);
          for (let x = 0; x < w; ) {
            const count = bpc === 1 ? b[pos] : b[pos + 1];
            pos += bpc;
            if (!(count & 0x7f)) break;
            const run = count & 0x7f;
            if (count & 0x80) {
              for (let k = 0; k < run && x < w; k++, pos += bpc) plane[y * w + x++] = b[pos];
            } else {
              const v = b[pos];
              pos += bpc;
              for (let k = 0; k < run && x < w; k++) plane[y * w + x++] = v;
            }
          }
        }
      }
      planes.push(plane);
    }
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (h - 1 - y) * w + x; // 下の行から入っている
        const o = (y * w + x) * 4;
        if (z >= 3) out.set([planes[0][i], planes[1][i], planes[2][i], z >= 4 ? planes[3][i] : 255], o);
        else out.set([planes[0][i], planes[0][i], planes[0][i], z === 2 ? planes[1][i] : 255], o);
      }
    }
    return { data: out, width: w, height: h };
  }

  // MacPaint(576 × 720 の白黒画像)
  function decodeMac(b) {
    for (const start of [512, 640]) {
      const rows = [];
      let pos = start;
      try {
        for (let y = 0; y < 720; y++) {
          const row = [];
          while (row.length < 72) {
            const n = (b[pos++] << 24) >> 24;
            if (pos > b.length) throw new Error();
            if (n >= 0) for (let k = 0; k <= n; k++) row.push(b[pos++]);
            else if (n !== -128) {
              const v = b[pos++];
              for (let k = 0; k < 1 - n; k++) row.push(v);
            }
          }
          rows.push(row.slice(0, 72));
        }
      } catch {
        continue;
      }
      if (pos > b.length) continue;
      const out = new Uint8ClampedArray(576 * 720 * 4);
      for (let y = 0; y < 720; y++) {
        for (let x = 0; x < 576; x++) {
          const black = (rows[y][x >> 3] >> (7 - (x & 7))) & 1;
          out.set(black ? [0, 0, 0, 255] : [255, 255, 255, 255], (y * 576 + x) * 4);
        }
      }
      return { data: out, width: 576, height: 720 };
    }
    fail("MacPaint として読み込めません");
  }

  // GIMP のブラシ (.gbr) とパターン (.pat)
  function decodeGimp(b) {
    const headerSize = be32(b, 0);
    const w = be32(b, 8);
    const h = be32(b, 12);
    const bytes = be32(b, 16);
    const magic = ascii(b, 20, 4);
    if (magic !== "GIMP" && magic !== "GPAT") fail("GIMP のブラシ・パターンとして読み込めません");
    checkSize(w, h);
    if (bytes < 1 || bytes > 4) fail("この形式には対応していません");
    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const o = headerSize + i * bytes;
      const rgba = bytes >= 3 ? [b[o], b[o + 1], b[o + 2], bytes === 4 ? b[o + 3] : 255] : [b[o], b[o], b[o], bytes === 2 ? b[o + 1] : 255];
      out.set(rgba, i * 4);
    }
    return { data: out, width: w, height: h };
  }

  // ---------- 中にプレビュー画像を持っている形式 ----------
  // PDF 互換の Illustrator ファイル (.ai): PDF として最初のページを描く
  async function decodeAi(bytes) {
    if (!startsWith(bytes, "%PDF")) fail("PDF 互換のデータを含まない Illustrator ファイルは読み込めません");
    await loadScript(LIBS.pdf);
    pdfjsLib.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker;
    try {
      const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      const page = await pdf.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(4, Math.max(1, 2000 / Math.max(base.width, base.height)));
      const viewport = page.getViewport({ scale });
      const canvas = makeCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      return { canvas, notes: ["最初のページを画像にしました"] };
    } catch {
      fail("Illustrator ファイルとして読み込めません");
    }
  }

  // DOS 形式の EPS には、TIFF のプレビューが入っていることがある
  function decodeEps(bytes) {
    if (u32(bytes, 0) !== 0xc6d3d0c5) fail("EPS の本体(PostScript)は、ブラウザでは画像にできません");
    const offset = u32(bytes, 20);
    const length = u32(bytes, 24);
    if (!length) fail("この EPS には、プレビュー画像が含まれていません");
    return decodeTiff(bytes.subarray(offset, offset + length)).then((r) => ({ ...r, notes: ["EPS に入っているプレビュー画像を取り出しました"] }));
  }

  // ZIP の形をした形式 (ORA, KRA, ODG など): 中のプレビュー画像を取り出す
  async function decodeZip(bytes) {
    await loadScript(LIBS.zip);
    let zip;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch {
      fail("ZIP 形式のファイルとして読み込めません");
    }
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    const lower = (n) => n.toLowerCase();
    const preferred = ["mergedimage.png", "preview.png", "quicklook/thumbnail.png", "thumbnails/thumbnail.png", "metadata/thumbnails/thumbnail.png", "thumbnail.png"];
    let name = preferred.map((p) => names.find((n) => lower(n) === p)).find(Boolean);
    if (!name) {
      const matches = names.filter((n) => /(preview|thumbnail|merged)[^/]*\.(png|jpe?g|webp|bmp)$/i.test(n));
      let largest = -1;
      for (const n of matches) {
        const size = (await zip.file(n).async("uint8array")).length;
        if (size > largest) {
          largest = size;
          name = n;
        }
      }
    }
    if (!name) fail("このファイルの中に、プレビュー画像が見つかりませんでした");
    const result = await decodeNative(await zip.file(name).async("uint8array"));
    return { ...result, notes: ["ファイルに入っているプレビュー画像を取り出しました(元の大きさとは限りません)"] };
  }

  // JPEG の先頭 (FF D8) から、終わり (FF D9) までの位置を、区切りをたどって求める
  function jpegEnd(b, start) {
    let p = start + 2;
    while (p + 4 <= b.length) {
      if (b[p] !== 0xff) {
        p++;
        continue;
      }
      const marker = b[p + 1];
      if (marker === 0xd9) return p + 2;
      if (marker === 0xff) {
        p++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        p += 2;
        continue;
      }
      p += 2 + be16(b, p + 2);
      if (marker === 0xda) {
        // この後は圧縮されたデータ。次の区切り(FF 00 と FF D0〜D7 は除く)まで進む
        while (p + 1 < b.length && !(b[p] === 0xff && b[p + 1] !== 0 && !(b[p + 1] >= 0xd0 && b[p + 1] <= 0xd7))) p++;
      }
    }
    return b.length;
  }

  // ファイルの中から PNG と JPEG を探して、いちばん大きいものを使う
  // (RAW 写真や、独自形式のお絵かきソフトのファイルは、プレビュー画像を持っていることが多い)
  async function decodeEmbedded(bytes, { minSide, note }) {
    const candidates = [];
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let at = bytes.indexOf(0x89); at !== -1 && candidates.length < 60; at = bytes.indexOf(0x89, at + 1)) {
      if (!startsWithBytes(bytes.subarray(at), png)) continue;
      // チャンクをたどって IEND まで
      let pos = at + 8;
      while (pos + 12 <= bytes.length && ascii(bytes, pos + 4, 4) !== "IEND") pos += 12 + be32(bytes, pos);
      candidates.push({ start: at, end: Math.min(bytes.length, pos + 12), type: "image/png" });
    }
    for (let at = bytes.indexOf(0xff); at !== -1 && candidates.length < 60; ) {
      if (bytes[at + 1] === 0xd8 && bytes[at + 2] === 0xff) {
        const end = jpegEnd(bytes, at);
        candidates.push({ start: at, end, type: "image/jpeg" });
        at = bytes.indexOf(0xff, end);
      } else {
        at = bytes.indexOf(0xff, at + 1);
      }
    }
    let best = null;
    for (const c of candidates) {
      try {
        const bitmap = await createImageBitmap(new Blob([bytes.subarray(c.start, c.end)], { type: c.type }));
        const pixels = bitmap.width * bitmap.height;
        if (Math.min(bitmap.width, bitmap.height) >= minSide && (!best || pixels > best.pixels)) {
          best?.bitmap.close?.();
          best = { bitmap, pixels };
        } else bitmap.close?.();
      } catch {
        // 画像ではなかった(偶然同じバイト列があった)ので、次へ
      }
    }
    if (!best) fail("ファイルの中に、プレビュー画像を見つけられませんでした");
    const canvas = makeCanvas(best.bitmap.width, best.bitmap.height);
    canvas.getContext("2d").drawImage(best.bitmap, 0, 0);
    return { canvas, notes: [note] };
  }

  const decodeRaw = (bytes) => decodeEmbedded(bytes, { minSide: 160, note: "RAW に入っているプレビュー画像を取り出しました(現像した画像ではなく、縮小されている場合があります)" });
  const decodePreview = (bytes) => decodeEmbedded(bytes, { minSide: 32, note: "ファイルに入っているプレビュー画像を取り出しました(元の大きさとは限りません)" });

  const DECODERS = {
    native: decodeNative,
    dib: decodeDib,
    cur: decodeCur,
    ani: decodeAni,
    icns: decodeIcns,
    svg: decodeSvg,
    tiff: decodeTiff,
    psd: decodePsd,
    heic: decodeHeic,
    jxl: decodeJxl,
    tga: decodeTga,
    pnm: decodePnm,
    pcx: decodePcx,
    qoi: decodeQoi,
    hdr: decodeHdr,
    dds: decodeDds,
    xbm: decodeXbm,
    xpm: decodeXpm,
    wbmp: decodeWbmp,
    ff: decodeFarbfeld,
    ras: decodeRas,
    sgi: decodeSgi,
    mac: decodeMac,
    gimp: decodeGimp,
    ai: decodeAi,
    eps: decodeEps,
    zip: decodeZip,
    raw: decodeRaw,
    preview: decodePreview,
  };

  // ---------- 拡張子ごとの読み方 ----------
  // 前から順に試す。空の配列は「読み込めない形式」(理由は REASONS にある)
  const READERS = {};
  const add = (exts, decoders) => exts.split(" ").forEach((e) => (READERS[e] = decoders));

  add("jpg jpeg jpe jfif jif jfi png apng gif webp avif avifs bmp rle", ["native"]);
  add("ico", ["cur", "native"]);
  add("dib", ["dib"]);
  add("cur", ["cur"]);
  add("ani", ["ani"]);
  add("icns", ["icns"]);
  add("svg svgz", ["svg"]);
  add("heif heic hif heifs heics", ["native", "heic"]);
  add("tif tiff", ["native", "tiff"]);
  add("jp2 j2k j2c jpc jpf jpx jpm mj2", ["native"]);
  add("jxl", ["native", "jxl"]);
  add("psd psb pdd", ["psd"]);
  add("tga targa icb vda vst", ["tga"]);
  add("pbm pgm ppm pnm pam pfm", ["pnm"]);
  add("pcx dcx", ["pcx"]);
  add("qoi", ["qoi"]);
  add("hdr pic rgbe", ["hdr"]);
  add("dds", ["dds"]);
  add("xbm", ["xbm"]);
  add("xpm", ["xpm"]);
  add("wbmp wbm", ["wbmp"]);
  add("ff", ["ff"]);
  add("ras sun", ["ras"]);
  add("sgi rgb rgba bw int inta", ["sgi"]);
  add("mac pntg", ["mac"]);
  add("gbr pat", ["gimp"]);
  add("ai", ["ai"]);
  add("eps", ["eps"]);
  add("ora kra odg procreate", ["zip"]);
  add("cdr", ["zip", "preview"]);
  add("clip afphoto afdesign pxd pxm mdp pdn sai sai2", ["preview"]);
  add("dng crw cr2 cr3 nef nrw arw srf sr2 raf orf rw2 raw pef ptx srw x3f dcr kdc k25 mrw erf 3fr fff iiq mos mef r3d bay cap eip rwl rwz", ["raw"]);
  // 下の形式は、一覧には載っているが、ブラウザだけでは読めない
  add("ps cmx wmf emf cgm dxf xcf ase aseprite gal exr dpx cin ktx ktx2 pvr astc blp vtf wal pcd pict pct msp cut pix xwd flif bpg jng mng fits fit fts dcm dicom nrrd nhdr nii mha mhd jxr wdp hdp", []);

  const REASONS = {};
  const reason = (exts, text) => exts.split(" ").forEach((e) => (REASONS[e] = text));
  reason("ps", "PostScript は、ブラウザだけでは画像にできません");
  reason("cmx wmf emf cgm dxf cdr", "このベクター形式は、ブラウザだけでは画像にできません");
  reason("xcf", "GIMP の XCF は、ブラウザだけでは読み込めません(GIMP で PNG などに書き出してください)");
  reason("ase aseprite gal", "この形式は、ブラウザだけでは読み込めません");
  reason("exr dpx cin", "この HDR・フィルム向けの形式は、ブラウザだけでは読み込めません");
  reason("ktx ktx2 pvr astc blp vtf wal", "ゲーム用のテクスチャ形式は、ブラウザだけでは読み込めません(DDS には対応しています)");
  reason("pcd pict pct msp cut pix xwd", "この古い形式は、ブラウザだけでは読み込めません");
  reason("flif bpg jng mng", "この形式は、ブラウザだけでは読み込めません");
  reason("fits fit fts dcm dicom nrrd nhdr nii mha mhd", "科学・医療向けの画像形式は、ブラウザだけでは読み込めません");
  reason("jxr wdp hdp", "JPEG XR は、ブラウザだけでは読み込めません");
  reason("jp2 j2k j2c jpc jpf jpx jpm mj2", "JPEG 2000 は、お使いのブラウザでは読み込めません(Safari なら読めることがあります)");

  // ---------- ファイルの中身から形式を推測する ----------
  // 拡張子が付いていない・間違っているときに、中身から読み方を決める
  function sniff(b) {
    // ブラウザが標準で読める形式。拡張子が間違っていても、中身で見分ける
    if (startsWithBytes(b, [0x89, 0x50, 0x4e, 0x47]) || startsWithBytes(b, [0xff, 0xd8, 0xff]) || startsWith(b, "GIF8")) return ["native"];
    if (startsWith(b, "BM") && startsWithBytes(b.subarray(6), [0, 0, 0, 0])) return ["native"];
    if (startsWith(b, "8BPS")) return ["psd"];
    if (startsWith(b, "qoif")) return ["qoi"];
    if (startsWith(b, "farbfeld")) return ["ff"];
    if (startsWith(b, "DDS ")) return ["dds"];
    if (startsWith(b, "icns")) return ["icns"];
    if (startsWith(b, "#?RADIANCE") || startsWith(b, "#?RGBE")) return ["hdr"];
    if (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) return ["native", "tiff"];
    if (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a) return ["native", "tiff"];
    if (be32(b, 0) === 0x59a66a95) return ["ras"];
    if (be16(b, 0) === 474 && b[2] <= 1) return ["sgi"];
    if (startsWith(b, "RIFF") && startsWith(b, "ACON", 8)) return ["ani"];
    if (startsWith(b, "RIFF") && startsWith(b, "WEBP", 8)) return ["native"];
    if (b[0] === 0xff && b[1] === 0x0a) return ["jxl"];
    if (startsWithBytes(b, [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20])) return ["jxl"];
    if (b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0 && u16(b, 4) > 0 && u16(b, 4) < 256) return ["cur", "native"];
    if (/^P[1-7](\s|#)/.test(ascii(b, 0, 3)) || /^P[fF]\s/.test(ascii(b, 0, 3))) return ["pnm"];
    if (u32(b, 0) === 0x3ade68b1) return ["pcx"];
    const brand = startsWith(b, "ftyp", 4) ? ascii(b, 8, 4) : "";
    if (["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"].includes(brand)) return ["native", "heic"];
    return [];
  }

  const extOf = (name) => (name.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();

  async function decode(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ext = extOf(file.name);
    const known = READERS[ext];

    // 中身で分かるものを先に、次に拡張子で決まるものを試す。どちらでもなければ、ブラウザ標準の読み込みを試す
    let order = [...new Set([...sniff(bytes), ...(known ?? [])])];
    if (!order.length) {
      if (known && !known.length) fail(REASONS[ext] ?? "この形式は、ブラウザだけでは読み込めません");
      order = ["native"];
    }

    // 失敗したときは、専用の読み方のメッセージ(具体的)を、ブラウザ標準のもの(漠然としている)より優先する
    let nativeError = null;
    let specificError = null;
    for (const name of order) {
      try {
        const result = await DECODERS[name](bytes, { ext, mime: file.type });
        const canvas = result.canvas ?? canvasFromRGBA(result.width, result.height, result.data);
        return { canvas, width: canvas.width, height: canvas.height, notes: result.notes ?? [] };
      } catch (e) {
        if (!(e instanceof UserError)) console.error(e);
        const error = e instanceof UserError ? e : new UserError("画像として読み込めませんでした。壊れたファイルか、対応していない形式かもしれません");
        if (name === "native") nativeError ??= error;
        else specificError ??= error;
      }
    }
    throw specificError ?? (REASONS[ext] ? new UserError(REASONS[ext]) : nativeError);
  }

  // ファイル選択の accept に使う、読み込める拡張子の一覧
  const readable = Object.keys(READERS).filter((e) => READERS[e].length);
  const accept = ["image/*", ...Object.keys(READERS).map((e) => "." + e)].join(",");

  // 「全体を読める」か「中のプレビュー画像だけ取り出せる」かの区別
  const PREVIEW_ONLY = new Set(["raw", "preview", "zip", "eps"]);
  const kindOf = (ext) => {
    const decoders = READERS[ext];
    if (!decoders) return null;
    if (!decoders.length) return "none";
    if (decoders.length === 1 && decoders[0] === "native" && REASONS[ext]) return "browser"; // ブラウザ次第(JPEG 2000 など)
    return decoders.every((name) => PREVIEW_ONLY.has(name)) ? "preview" : "full";
  };

  return {
    decode,
    kindOf,
    canSniff: (bytes) => sniff(bytes).length > 0,
    extensions: Object.keys(READERS),
    accept,
    isImageExt: (ext) => ext in READERS,
    canRead: (ext) => Boolean(READERS[ext]?.length),
    readable,
    reasonFor: (ext) => REASONS[ext],
    canvasFromRGBA,
    UserError,
  };
})();
