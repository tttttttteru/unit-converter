// 音声の書き出し(エンコード)と、変換先の形式の一覧。
// 形式を増やすときは、FORMATS に 1 つ足す。exts の先頭が、標準の拡張子。
//   js … このファイルの中のコードで書き出す(すぐ終わる)
//   ffmpeg … ffmpeg (WebAssembly)で書き出す。約 32 MB を、必要なときだけ読み込む
window.AudioOut = (() => {
  const { loadScript, LIBS } = Tools;

  // ---------- 波形の加工(サンプルレート・チャンネル数) ----------
  // チャンネル数を変える。多チャンネルから 2 つにするときは、ITU の標準的な割合で混ぜる(低音専用チャンネルは使わない)
  function mixChannels(channels, count) {
    const n = channels.length;
    if (n === count) return channels;
    const frames = channels[0].length;
    if (count === 2 && n === 1) return [channels[0], channels[0]];
    if (count > n) return [...channels, ...Array.from({ length: count - n }, () => channels[n - 1])];
    const out = Array.from({ length: count }, () => new Float32Array(frames));
    if (count === 1) {
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < n; c++) sum += channels[c][i];
        out[0][i] = sum / n;
      }
    } else if (count === 2 && (n === 6 || n === 8)) {
      // 5.1 / 7.1: 左・右・中央・低音・サラウンド左・右(・後ろ左・右)の順
      const k = 0.7071;
      const norm = n === 6 ? 1 / (1 + 2 * k) : 1 / (1 + 3 * k);
      for (let i = 0; i < frames; i++) {
        const [fl, fr, fc, , sl, sr, bl = 0, br = 0] = channels.map((ch) => ch[i]);
        out[0][i] = (fl + k * fc + k * sl + (n === 8 ? k * bl : 0)) * norm;
        out[1][i] = (fr + k * fc + k * sr + (n === 8 ? k * br : 0)) * norm;
      }
    } else {
      // その他: 偶数番めを左、奇数番めを右として、それぞれ平均する
      for (let i = 0; i < frames; i++) {
        let l = 0;
        let r = 0;
        let nl = 0;
        let nr = 0;
        for (let c = 0; c < n; c++) {
          if (c % 2 === 0) ((l += channels[c][i]), nl++);
          else ((r += channels[c][i]), nr++);
        }
        out[0][i] = l / nl;
        out[1][i] = nr ? r / nr : l / nl;
      }
    }
    return out;
  }

  // 線形補間(ブラウザの機能が使えない、極端なサンプルレートのとき用)
  function resampleLinear(channels, from, to) {
    const frames = Math.max(1, Math.round((channels[0].length * to) / from));
    return channels.map((src) => {
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        const pos = (i * from) / to;
        const j = Math.floor(pos);
        const t = pos - j;
        out[i] = src[Math.min(j, src.length - 1)] * (1 - t) + src[Math.min(j + 1, src.length - 1)] * t;
      }
      return out;
    });
  }

  // サンプルレートを変える(ブラウザの OfflineAudioContext で、品質よく変換する)
  async function resample(channels, from, to) {
    if (from === to) return channels;
    if (from < 3000 || to < 3000 || from > 384000 || to > 384000) return resampleLinear(channels, from, to);
    const length = channels[0].length;
    const buffer = new AudioBuffer({ numberOfChannels: channels.length, length, sampleRate: from });
    channels.forEach((data, c) => buffer.copyToChannel(data, c));
    const context = new OfflineAudioContext(channels.length, Math.max(1, Math.round((length * to) / from)), to);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start();
    const rendered = await context.startRendering();
    return Array.from({ length: channels.length }, (_, c) => rendered.getChannelData(c).slice());
  }

  // 書き出す前の整え: 形式ごとの制約(チャンネル数の上限・使えるサンプルレート)と、利用者の指定を反映する
  async function prepare(pcm, format, options) {
    let { rate, channels } = pcm;
    const notes = [];
    let targetRate = format.forceRate || options.rate || rate;
    if (format.rates && !format.rates.includes(targetRate)) {
      // 使えないサンプルレートは、いちばん近い、使えるものにする
      const nearest = format.rates.reduce((best, r) => (Math.abs(r - targetRate) < Math.abs(best - targetRate) ? r : best));
      notes.push(`この形式では ${targetRate} Hz が使えないため、${nearest} Hz にしました`);
      targetRate = nearest;
    }
    let targetChannels = format.forceChannels || options.channels || channels.length;
    if (format.maxChannels && targetChannels > format.maxChannels) {
      notes.push(`この形式は ${format.maxChannels} チャンネルまでのため、${format.maxChannels === 1 ? "モノラル" : "ステレオ"}にしました`);
      targetChannels = format.maxChannels;
    }
    channels = mixChannels(channels, targetChannels);
    if (targetRate !== rate) channels = await resample(channels, rate, targetRate);
    return { rate: targetRate, channels, notes };
  }

  // ---------- バイト列を組み立てる部品 ----------
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
    u64(v, little = true) {
      const big = BigInt(v);
      const lo = Number(big & 0xffffffffn);
      const hi = Number(big >> 32n);
      return little ? this.u32(lo).u32(hi) : this.u32(hi, false).u32(lo, false);
    }
    text(s) {
      return this.u8(...[...s].map((c) => c.charCodeAt(0)));
    }
    raw(...parts) {
      this.parts.push(...parts);
      return this;
    }
    zeros(n) {
      this.parts.push(new Uint8Array(n));
      return this;
    }
    get length() {
      return this.parts.reduce((s, p) => s + p.length, 0);
    }
    blob(type) {
      return new Blob(this.parts, { type });
    }
  }

  // ---------- サンプルの書き出し ----------
  // G.711 の μ-law と A-law(16 ビットの整数から、8 ビットへ)
  function toMulaw(s) {
    let sign = (s >> 8) & 0x80;
    if (sign) s = -s;
    s = Math.min(s, 32635) + 0x84;
    let exponent = 7;
    for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
    return ~(sign | (exponent << 4) | ((s >> (exponent + 3)) & 15)) & 0xff;
  }
  const A_SEGMENTS = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];
  function toAlaw(s) {
    let v = s >> 3;
    let mask;
    if (v >= 0) mask = 0xd5;
    else {
      mask = 0x55;
      v = -v - 1;
    }
    const seg = A_SEGMENTS.findIndex((limit) => v <= limit);
    if (seg < 0) return 0x7f ^ mask;
    return ((seg << 4) | (seg < 2 ? (v >> 1) & 15 : (v >> seg) & 15)) ^ mask;
  }

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // 全チャンネルを交互に並べて、指定した形式のバイト列にする。bits: "8"(符号なし) "16" "24" "32" "32f" "64f" "mulaw" "alaw"
  function interleave(channels, bits, little = true) {
    const n = channels.length;
    const frames = channels[0].length;
    const float = bits.endsWith("f");
    const size = bits === "mulaw" || bits === "alaw" ? 1 : parseInt(bits, 10) / 8;
    const out = new Uint8Array(frames * n * size);
    const view = new DataView(out.buffer);
    let at = 0;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < n; c++) {
        const x = channels[c][i];
        if (bits === "mulaw") out[at] = toMulaw(clamp(Math.round(x * 32768), -32768, 32767));
        else if (bits === "alaw") out[at] = toAlaw(clamp(Math.round(x * 32768), -32768, 32767));
        else if (float) {
          if (size === 4) view.setFloat32(at, x, little);
          else view.setFloat64(at, x, little);
        } else if (size === 1) out[at] = clamp(Math.round(x * 128) + 128, 0, 255);
        else if (size === 2) view.setInt16(at, clamp(Math.round(x * 32768), -32768, 32767), little);
        else if (size === 3) {
          const v = clamp(Math.round(x * 8388608), -8388608, 8388607);
          if (little) ((out[at] = v & 255), (out[at + 1] = (v >> 8) & 255), (out[at + 2] = (v >> 16) & 255));
          else ((out[at] = (v >> 16) & 255), (out[at + 1] = (v >> 8) & 255), (out[at + 2] = v & 255));
        } else view.setInt32(at, clamp(Math.round(x * 2147483648), -2147483648, 2147483647), little);
        at += size;
      }
    }
    return out;
  }

  const PCM_GUID = [1, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71];
  const FLOAT_GUID = [3, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71];
  const CHANNEL_MASKS = { 1: 4, 2: 3, 3: 7, 4: 0x33, 5: 0x37, 6: 0x3f, 7: 0x13f, 8: 0x63f };

  // WAV(RIFF)・BWF・RF64
  function encodeWav(pcm, { bits, ext }) {
    const { rate, channels } = pcm;
    const n = channels.length;
    const isFloat = bits.endsWith("f");
    const isLaw = bits === "mulaw" || bits === "alaw";
    const depth = isLaw ? 8 : parseInt(bits, 10);
    const data = interleave(channels, bits);
    const rf64 = ext === "rf64";
    const extensible = !isLaw && (n > 2 || depth > 16) && !(isFloat && n <= 2);
    const tag = isLaw ? (bits === "alaw" ? 6 : 7) : isFloat ? 3 : 1;
    const fmt = new Bytes()
      .u16(extensible ? 0xfffe : tag)
      .u16(n)
      .u32(rate)
      .u32((rate * n * depth) / 8)
      .u16((n * depth) / 8)
      .u16(depth);
    if (extensible) fmt.u16(22).u16(depth).u32(CHANNEL_MASKS[n] ?? 0).u8(...(isFloat ? FLOAT_GUID : PCM_GUID));
    else if (tag !== 1) fmt.u16(0);
    const fmtSize = fmt.length;
    const needFact = tag !== 1 || extensible;
    const pad = data.length & 1;
    const chunks = new Bytes();
    if (rf64) chunks.text("ds64").u32(28).u64(0).u64(data.length).u64(Math.floor(data.length / ((n * depth) / 8))).u32(0);
    chunks.text("fmt ").u32(fmtSize).raw(...fmt.parts);
    if (needFact) chunks.text("fact").u32(4).u32(Math.floor(data.length / ((n * depth) / 8)));
    if (ext === "bwf") chunks.text("bext").u32(602).zeros(602); // 放送用 WAV の追加情報(中身は空)
    const total = 4 + chunks.length + 8 + data.length + pad;
    if (!rf64 && total > 0xffffffff) throw new Error("4 GB を超えるため、WAV にできません。RF64 を選んでください");
    const out = new Bytes().text(rf64 ? "RF64" : "RIFF").u32(rf64 ? 0xffffffff : total).text("WAVE");
    out.raw(...chunks.parts);
    out.text("data").u32(rf64 ? 0xffffffff : data.length).raw(data);
    if (pad) out.u8(0);
    return out.blob("audio/wav");
  }

  // Wave64(Sony): GUID で区切る、4 GB を超えられる WAV
  function encodeW64(pcm, { bits }) {
    const { rate, channels } = pcm;
    const n = channels.length;
    const isFloat = bits.endsWith("f");
    const depth = parseInt(bits, 10);
    const data = interleave(channels, bits);
    const guid = (id, tail) => [...[...id].map((c) => c.charCodeAt(0)), ...tail];
    const TAIL = [0xf3, 0xac, 0xd3, 0x11, 0x8c, 0xd1, 0x00, 0xc0, 0x4f, 0x8e, 0xdb, 0x8a];
    const fmtBody = new Bytes().u16(0xfffe).u16(n).u32(rate).u32((rate * n * depth) / 8).u16((n * depth) / 8).u16(depth).u16(22).u16(depth).u32(CHANNEL_MASKS[n] ?? 0).u8(...(isFloat ? FLOAT_GUID : PCM_GUID));
    const align = (v) => (v + 7) & ~7;
    const fmtSize = 24 + fmtBody.length;
    const dataSize = 24 + data.length;
    const total = 40 + align(fmtSize) + align(dataSize);
    const out = new Bytes().u8(...guid("riff", [0x2e, 0x91, 0xcf, 0x11, 0xa5, 0xd6, 0x28, 0xdb, 0x04, 0xc1, 0, 0])).u64(total);
    out.u8(...guid("wave", TAIL));
    out.u8(...guid("fmt ", TAIL)).u64(fmtSize).raw(...fmtBody.parts).zeros(align(fmtSize) - fmtSize);
    out.u8(...guid("data", TAIL)).u64(dataSize).raw(data).zeros(align(dataSize) - dataSize);
    return out.blob("audio/x-wav");
  }

  // AIFF / AIFF-C(Apple): 数は上位バイトから並べる。サンプルレートは 10 バイトの拡張倍精度
  function extended80(rate) {
    const e2 = Math.floor(Math.log2(rate));
    const mantissa = BigInt(Math.round(rate)) << BigInt(63 - e2);
    return new Bytes().u16(16383 + e2, false).u64(mantissa, false);
  }

  function encodeAiff(pcm, { bits, ext }) {
    const { rate, channels } = pcm;
    const n = channels.length;
    const depth = parseInt(bits, 10);
    const data = interleave(channels, bits, false);
    if (depth === 8) for (let i = 0; i < data.length; i++) data[i] = (data[i] + 128) & 255; // AIFF の 8 ビットは符号付き
    const aifc = ext === "aifc";
    const comm = new Bytes().u16(n, false).u32(channels[0].length, false).u16(depth, false).raw(...extended80(rate).parts);
    if (aifc) comm.text("NONE").u8(14).text("not compressed").u8(0);
    const ssndSize = 8 + data.length;
    const body = new Bytes().text(aifc ? "AIFC" : "AIFF");
    if (aifc) body.text("FVER").u32(4, false).u32(0xa2805140, false);
    body.text("COMM").u32(comm.length, false).raw(...comm.parts);
    body.text("SSND").u32(ssndSize, false).u32(0, false).u32(0, false).raw(data);
    if (ssndSize & 1) body.u8(0);
    return new Bytes().text("FORM").u32(body.length, false).raw(...body.parts).blob("audio/aiff");
  }

  // AU / SND(Sun・NeXT)
  function encodeAu(pcm, { bits }) {
    const { rate, channels } = pcm;
    const data = interleave(channels, bits, false);
    if (bits === "8") for (let i = 0; i < data.length; i++) data[i] = (data[i] + 128) & 255; // 符号付き
    const encoding = { mulaw: 1, alaw: 27, 8: 2, 16: 3, 24: 4, 32: 5, "32f": 6, "64f": 7 }[bits];
    return new Bytes().text(".snd").u32(24, false).u32(data.length, false).u32(encoding, false).u32(rate, false).u32(channels.length, false).raw(data).blob("audio/basic");
  }

  // CAF(Apple)
  function encodeCaf(pcm, { bits }) {
    const { rate, channels } = pcm;
    const n = channels.length;
    const isFloat = bits.endsWith("f");
    const depth = parseInt(bits, 10);
    const data = interleave(channels, bits);
    const rateBytes = new Uint8Array(8);
    new DataView(rateBytes.buffer).setFloat64(0, rate, false);
    return new Bytes()
      .text("caff").u16(1, false).u16(0, false)
      .text("desc").u64(32, false).raw(rateBytes).text("lpcm").u32(isFloat ? 3 : 2, false) // 1: 小数、2: 下位バイトから
      .u32((n * depth) / 8, false).u32(1, false).u32(n, false).u32(depth, false)
      .text("data").u64(4 + data.length, false).u32(0, false).raw(data)
      .blob("audio/x-caf");
  }

  // 生データ(ヘッダーなし)
  function encodeRaw(pcm, { bits }) {
    return new Blob([interleave(pcm.channels, bits)], { type: "application/octet-stream" });
  }

  // 8SVX(Amiga の IFF): 8 ビット符号付き、モノラル
  function encodeSvx(pcm) {
    const mono = pcm.channels[0];
    const body = new Uint8Array(mono.length);
    for (let i = 0; i < mono.length; i++) body[i] = clamp(Math.round(mono[i] * 127), -128, 127) & 255;
    const vhdr = new Bytes().u32(body.length, false).u32(0, false).u32(0, false).u16(pcm.rate, false).u8(1, 0).u32(0x10000, false);
    const content = new Bytes().text("8SVX").text("VHDR").u32(vhdr.length, false).raw(...vhdr.parts).text("BODY").u32(body.length, false).raw(body);
    if (body.length & 1) content.u8(0);
    return new Bytes().text("FORM").u32(content.length, false).raw(...content.parts).blob("audio/x-8svx");
  }

  // 長い処理の途中で、画面に処理を返す(進み具合の表示を更新するため)。
  // setTimeout は、タブが隠れていると 1 秒に 1 回に間引かれて極端に遅くなるので、MessageChannel を使う
  const nextTurn = () =>
    new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(0);
    });

  // MP3(lamejs)
  const MP3_BITRATES = {
    mpeg1: [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    mpeg2: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  };
  // 短い音声は、すぐ使えるブラウザ内のエンコーダー (lamejs) で。長い音声(30 秒超)は、約 4 倍速く、画面も止まらない ffmpeg で
  const MP3_VIA_FFMPEG = { codec: ["-c:a", "libmp3lame"], container: "mp3", mime: "audio/mpeg", exts: ["mp3"] };
  const MP3_FFMPEG_MIN_SECONDS = 30;

  async function encodeMp3(pcm, { bitrate }, report) {
    const stereo = pcm.channels.length > 1;
    const table = pcm.rate >= 32000 ? MP3_BITRATES.mpeg1 : MP3_BITRATES.mpeg2;
    const kbps = [...table].reverse().find((k) => k <= bitrate) ?? table[0];
    if (pcm.channels[0].length / pcm.rate > MP3_FFMPEG_MIN_SECONDS || Tools.ffmpeg.isLoaded()) {
      return encodeWithFfmpeg(pcm, MP3_VIA_FFMPEG, { bitrate: kbps }, report);
    }
    await loadScript(LIBS.lame);
    const encoder = new lamejs.Mp3Encoder(stereo ? 2 : 1, pcm.rate, kbps);
    const toInt16 = (f) => Int16Array.from(f, (v) => clamp(Math.round(v * 32768), -32768, 32767));
    const left = toInt16(pcm.channels[0]);
    const right = stereo ? toInt16(pcm.channels[1]) : null;
    const parts = [];
    const block = 1152 * 20;
    let lastTurn = performance.now();
    for (let i = 0; i < left.length; i += block) {
      const l = left.subarray(i, i + block);
      const chunk = right ? encoder.encodeBuffer(l, right.subarray(i, i + block)) : encoder.encodeBuffer(l);
      if (chunk.length) parts.push(chunk);
      if (performance.now() - lastTurn > 50) {
        report?.(i / left.length);
        await nextTurn();
        lastTurn = performance.now();
      }
    }
    const rest = encoder.flush();
    if (rest.length) parts.push(rest);
    return new Blob(parts, { type: "audio/mpeg" });
  }

  // ---------- ffmpeg で書き出す形式 ----------
  // 波形を WAV にして ffmpeg に渡し、指定の形式に変換してもらう
  async function encodeWithFfmpeg(pcm, format, options, report) {
    // ffmpeg に渡す WAV: 劣化させないよう、24 ビットにしておく(16 ビットで足りる形式は 16 ビット)
    const input = await encodeWav(pcm, { bits: format.lossless24 ? "24" : "16", ext: "wav" }).arrayBuffer();
    const bitrate = options.bitrate ? ["-b:a", options.bitrate + "k"] : [];
    const bits = format.ffmpegBits?.(options.bits) ?? [];
    const outName = "out." + (format.container === "ogg" ? "ogg" : format.exts[0]);
    const result = await Tools.ffmpeg.run({
      args: ["-hide_banner", "-nostdin", "-i", "in.wav", ...format.codec, ...bitrate, ...bits, ...(format.extra ?? []), "-f", format.container, outName],
      inputs: { "in.wav": new Uint8Array(input) },
      outputs: [outName],
      onProgress: report,
    });
    const file = result.files[outName];
    if (!file || !file.length) {
      const log = result.logs.join("\n");
      const message = /Unsupported sample rate|Invalid sample rate/i.test(log)
        ? "この形式では、このサンプルレートは使えません"
        : /Too many channels|channel layout|Unsupported channel/i.test(log)
          ? "この形式では、このチャンネル数は使えません"
          : "変換できませんでした";
      throw new Error(message);
    }
    return new Blob([file], { type: format.mime });
  }

  // ---------- 形式の一覧 ----------
  const BIT_CHOICES = {
    wav: [["16", "16 ビット"], ["24", "24 ビット"], ["32", "32 ビット"], ["32f", "32 ビット(小数)"], ["8", "8 ビット"]],
    aiff: [["16", "16 ビット"], ["24", "24 ビット"], ["32", "32 ビット"], ["8", "8 ビット"]],
    au: [["16", "16 ビット"], ["24", "24 ビット"], ["32", "32 ビット"], ["32f", "32 ビット(小数)"], ["8", "8 ビット"]],
    caf: [["16", "16 ビット"], ["24", "24 ビット"], ["32", "32 ビット"], ["32f", "32 ビット(小数)"]],
    raw: [["16", "16 ビット"], ["24", "24 ビット"], ["32", "32 ビット"], ["32f", "32 ビット(小数)"], ["8", "8 ビット"]],
  };
  const BITRATES = [64, 96, 128, 160, 192, 256, 320];
  const common = { rates: null };

  // js: 即座に書き出す形式 / lossless24: 24 ビットまで保持する形式 / maxChannels・rates: 形式の制約
  const FORMATS = [
    { id: "mp3", label: "MP3", exts: ["mp3"], bitrates: BITRATES, defaultBitrate: 192, maxChannels: 2, rates: [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000], encode: encodeMp3, note: "30 秒までの短い音声は、ブラウザ内の変換プログラムで書き出します。それより長いと、速く変換できる ffmpeg を使うため、初回は約 32 MB を読み込みます" },
    { id: "wav", label: "WAV", exts: ["wav", "wave"], bits: BIT_CHOICES.wav, defaultBits: "16", encode: encodeWav },
    { id: "flac", label: "FLAC (ロスレス)", exts: ["flac"], bits: [["16", "16 ビット"], ["24", "24 ビット"]], defaultBits: "16", lossless24: true, codec: ["-c:a", "flac"], container: "flac", mime: "audio/flac", ffmpegBits: (b) => ["-sample_fmt", b === "24" ? "s32" : "s16", ...(b === "24" ? ["-bits_per_raw_sample", "24"] : [])] },
    { id: "m4a", label: "AAC (M4A)", exts: ["m4a", "m4b", "m4r"], bitrates: BITRATES, defaultBitrate: 192, codec: ["-c:a", "aac"], container: "ipod", mime: "audio/mp4" },
    { id: "aac", label: "AAC (ADTS)", exts: ["aac", "adts"], bitrates: BITRATES, defaultBitrate: 192, codec: ["-c:a", "aac"], container: "adts", mime: "audio/aac" },
    { id: "ogg", label: "Ogg Vorbis", exts: ["ogg", "oga"], bitrates: BITRATES, defaultBitrate: 160, codec: ["-c:a", "libvorbis"], container: "ogg", mime: "audio/ogg" },
    // libopus は、この ffmpeg ではステレオで異常終了してしまうので、ffmpeg 内蔵のエンコーダーを使う
    { id: "opus", label: "Opus", exts: ["opus"], bitrates: [32, 48, 64, 96, 128, 160, 192, 256], defaultBitrate: 128, maxChannels: 2, codec: ["-c:a", "opus", "-strict", "-2"], extra: ["-ar", "48000"], container: "opus", mime: "audio/ogg", note: "Opus は 48 kHz に変換して書き出します(ffmpeg 内蔵の簡易的なエンコーダーを使います)" },
    { id: "alac", label: "ALAC (Apple Lossless)", exts: ["m4a"], lossless24: true, codec: ["-c:a", "alac"], container: "ipod", mime: "audio/mp4" },
    { id: "wma", label: "WMA", exts: ["wma"], bitrates: BITRATES, defaultBitrate: 128, maxChannels: 2, codec: ["-c:a", "wmav2"], container: "asf", mime: "audio/x-ms-wma" },
    { id: "ac3", label: "AC-3 (Dolby Digital)", exts: ["ac3"], bitrates: [96, 128, 192, 256, 384, 448, 640], defaultBitrate: 192, maxChannels: 6, rates: [32000, 44100, 48000], codec: ["-c:a", "ac3"], container: "ac3", mime: "audio/ac3" },
    { id: "eac3", label: "E-AC-3 (Dolby Digital Plus)", exts: ["eac3", "ec3"], bitrates: [96, 128, 192, 256, 384, 448, 640], defaultBitrate: 192, maxChannels: 6, rates: [32000, 44100, 48000], codec: ["-c:a", "eac3"], container: "eac3", mime: "audio/eac3" },
    { id: "mp2", label: "MP2 (MPEG Audio Layer II)", exts: ["mp2", "mpa"], bitrates: BITRATES, defaultBitrate: 192, maxChannels: 2, rates: [16000, 22050, 24000, 32000, 44100, 48000], codec: ["-c:a", "mp2"], container: "mp2", mime: "audio/mpeg" },
    { id: "wv", label: "WavPack", exts: ["wv"], lossless24: true, codec: ["-c:a", "wavpack"], container: "wv", mime: "audio/x-wavpack" },
    { id: "tta", label: "TTA (True Audio)", exts: ["tta"], lossless24: true, maxChannels: 8, codec: ["-c:a", "tta"], container: "tta", mime: "audio/x-tta" },
    { id: "mka", label: "Matroska 音声 (FLAC)", exts: ["mka"], lossless24: true, codec: ["-c:a", "flac"], container: "matroska", mime: "audio/x-matroska" },
    { id: "aiff", label: "AIFF / AIFF-C", exts: ["aif", "aiff", "aifc"], bits: BIT_CHOICES.aiff, defaultBits: "16", encode: encodeAiff },
    { id: "au", label: "AU / SND (Sun)", exts: ["au", "snd"], bits: BIT_CHOICES.au, defaultBits: "16", encode: encodeAu },
    { id: "caf", label: "CAF (Apple)", exts: ["caf"], bits: BIT_CHOICES.caf, defaultBits: "16", encode: encodeCaf },
    { id: "w64", label: "Wave64 (Sony)", exts: ["w64"], bits: BIT_CHOICES.caf, defaultBits: "16", encode: encodeW64 },
    { id: "rf64", label: "RF64 / BWF", exts: ["rf64", "bwf"], bits: BIT_CHOICES.wav, defaultBits: "24", encode: encodeWav, note: "BWF を選ぶと、放送用の追加情報つきの WAV になります" },
    { id: "voc", label: "VOC (Creative)", exts: ["voc"], bits: [["16", "16 ビット"], ["8", "8 ビット"]], defaultBits: "16", maxChannels: 2, codec: ["-c:a", "pcm_s16le"], container: "voc", mime: "audio/x-voc", ffmpegBits: (b) => ["-c:a", b === "8" ? "pcm_u8" : "pcm_s16le"] },
    { id: "wav-ima", label: "WAV (IMA ADPCM)", exts: ["wav"], codec: ["-c:a", "adpcm_ima_wav"], container: "wav", mime: "audio/wav", note: "音を圧縮した WAV です(音質は少し落ちます)" },
    { id: "wav-ms", label: "WAV (MS ADPCM)", exts: ["wav"], codec: ["-c:a", "adpcm_ms"], container: "wav", mime: "audio/wav", note: "音を圧縮した WAV です(音質は少し落ちます)" },
    { id: "wav-mulaw", label: "WAV (μ-law)", exts: ["wav"], forceBits: "mulaw", encode: (pcm, o) => encodeWav(pcm, { ...o, bits: "mulaw" }), note: "電話向けの 8 ビット圧縮です" },
    { id: "wav-alaw", label: "WAV (A-law)", exts: ["wav"], forceBits: "alaw", encode: (pcm, o) => encodeWav(pcm, { ...o, bits: "alaw" }), note: "電話向けの 8 ビット圧縮です" },
    { id: "pcm", label: "生データ (ヘッダーなし)", exts: ["pcm", "raw"], bits: BIT_CHOICES.raw, defaultBits: "16", encode: encodeRaw, note: "ヘッダーのない、波形だけのデータです。読み込むときは、サンプルレートなどを指定する必要があります" },
    { id: "sln", label: "SLN (Asterisk の 16 ビット)", exts: ["sln"], forceRate: 8000, forceChannels: 1, forceBits: "16", encode: encodeRaw, note: "8 kHz・モノラル・16 ビットの生データです" },
    { id: "ulaw", label: "μ-law (生データ)", exts: ["ulaw"], forceRate: 8000, forceChannels: 1, forceBits: "mulaw", encode: encodeRaw, note: "8 kHz・モノラルの生データです" },
    { id: "alaw", label: "A-law (生データ)", exts: ["alaw"], forceRate: 8000, forceChannels: 1, forceBits: "alaw", encode: encodeRaw, note: "8 kHz・モノラルの生データです" },
    { id: "8svx", label: "8SVX (Amiga IFF)", exts: ["8svx", "8sv", "iff"], forceChannels: 1, rates: [8000, 11025, 16000, 22050, 32000, 44100, 48000], encode: encodeSvx, note: "8 ビット・モノラルです" },
  ].map((f) => ({ ...common, ...f }));

  // ---------- 変換先の検索 ----------
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

  function whyNot(query) {
    const q = normalize(query);
    if (!q) return "";
    if (AudioIn.canRead(q)) return `「.${q}」は読み込みには対応していますが、変換先としては対応していません`;
    if (AudioIn.isAudioExt(q)) return `「.${q}」は、変換先としては対応していません`;
    return `「${query.trim()}」に合う形式は見つかりません`;
  }

  // ---------- 書き出し ----------
  // options: { ext, bits, bitrate, rate, channels }。戻り値: { blob, ext, notes, rate, channels }
  async function encode(format, pcm, options, { onStatus, onProgress } = {}) {
    const prepared = await prepare(pcm, format, options);
    const settings = { ...options, bits: format.forceBits ?? options.bits ?? format.defaultBits, bitrate: options.bitrate ?? format.defaultBitrate };
    let blob;
    if (format.encode) {
      onStatus?.("変換中…");
      blob = await format.encode(prepared, settings, onProgress);
    } else {
      onStatus?.("変換エンジン (ffmpeg) を読み込み中… 初回は約 32 MB かかります");
      blob = await encodeWithFfmpeg(prepared, format, settings, onProgress);
    }
    return { blob, notes: prepared.notes, rate: prepared.rate, channels: prepared.channels.length };
  }

  return { FORMATS, search, whyNot, encode };
})();
