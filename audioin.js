// 音声の読み込み(デコード)。ファイルを、波形のデータ(PCM)にする。
// どの拡張子をどう読むかは、下の READERS に並べてある。形式を増やすときは、ここに足す。
//   wav / aiff / au / caf / raw … 自前のコード(すぐ終わる)
//   native … ブラウザの標準機能(MP3・AAC・Ogg・FLAC など)
//   ffmpeg … ffmpeg (WebAssembly)。約 32 MB を、必要なときだけ読み込む
//   tracker / midi … MOD・XM・IT など / MIDI(簡易音源)
window.AudioIn = (() => {
  const { loadScript } = Tools;

  const LIBS = {
    tracker: "https://cdn.jsdelivr.net/npm/@audio/decode-mod@1.0.0/decode-mod.js",
    sid: "https://cdn.jsdelivr.net/npm/libsidplayfp-wasm@1.1.0/dist/index.js",
  };

  // 利用者にそのまま見せてよい、日本語のメッセージ付きのエラー
  class UserError extends Error {}
  const fail = (message) => {
    throw new UserError(message);
  };
  // 「この読み方では読めないので、次の読み方を試す」という合図
  class Fallback extends Error {}

  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const be16 = (b, o) => (b[o] << 8) | b[o + 1];
  const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));
  const extOf = (name) => (name.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();

  // ---------- 1 サンプルずつの変換 ----------
  // G.711 の μ-law と A-law(電話の音声で使われる、8 ビットの圧縮)
  function mulaw(v) {
    v = ~v & 0xff;
    const t = (((v & 15) << 3) + 0x84) << ((v >> 4) & 7);
    return (v & 0x80 ? 0x84 - t : t - 0x84) / 32768;
  }
  function alaw(v) {
    v ^= 0x55;
    const seg = (v >> 4) & 7;
    let t = (v & 15) << 4;
    t = seg === 0 ? t + 8 : (t + 0x108) << (seg - 1);
    return (v & 0x80 ? t : -t) / 32768;
  }
  const MULAW_TABLE = Float32Array.from({ length: 256 }, (_, i) => mulaw(i));
  const ALAW_TABLE = Float32Array.from({ length: 256 }, (_, i) => alaw(i));

  // 交互に並んだサンプル(1 フレームに channels 個)を、チャンネルごとに分ける
  // read(i) は、先頭から i 番目のサンプルを -1〜1 の小数で返す
  function deinterleave(count, channels, read) {
    const frames = Math.floor(count / channels);
    const out = Array.from({ length: channels }, () => new Float32Array(frames));
    let i = 0;
    for (let f = 0; f < frames; f++) for (let c = 0; c < channels; c++) out[c][f] = read(i++);
    return out;
  }

  // 並んだバイト列を、指定した形式のサンプルとして読む。encoding の書き方: s8 u8 s16le s16be s24le s24be s32le s32be f32le f32be f64le f64be mulaw alaw
  function readSamples(bytes, encoding, channels) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const m = /^([suf])(\d+)(le|be)?$/.exec(encoding);
    if (encoding === "mulaw") return deinterleave(bytes.length, channels, (i) => MULAW_TABLE[bytes[i]]);
    if (encoding === "alaw") return deinterleave(bytes.length, channels, (i) => ALAW_TABLE[bytes[i]]);
    if (!m) fail("この音声のデータの形式には対応していません");
    const [, type, bitsText, order] = m;
    const bits = Number(bitsText);
    const little = order !== "be";
    const size = bits / 8;
    const count = Math.floor(bytes.length / size);
    if (type === "f") {
      if (bits === 32) return deinterleave(count, channels, (i) => dv.getFloat32(i * 4, little));
      return deinterleave(count, channels, (i) => dv.getFloat64(i * 8, little));
    }
    if (type === "u" && bits === 8) return deinterleave(count, channels, (i) => (bytes[i] - 128) / 128);
    if (bits === 8) return deinterleave(count, channels, (i) => ((bytes[i] << 24) >> 24) / 128);
    if (bits === 16) return deinterleave(count, channels, (i) => dv.getInt16(i * 2, little) / 32768);
    if (bits === 24) {
      return deinterleave(count, channels, (i) => {
        const o = i * 3;
        const v = little ? bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) : (bytes[o] << 16) | (bytes[o + 1] << 8) | bytes[o + 2];
        return ((v << 8) >> 8) / 8388608;
      });
    }
    if (bits === 32) return deinterleave(count, channels, (i) => dv.getInt32(i * 4, little) / 2147483648);
    fail("この音声のデータの形式には対応していません");
  }

  // ---------- WAV(RIFF・RF64・BWF・Wave64) ----------
  function parseWav(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const tag = (o) => ascii(b, o, 4);
    const readFmt = (o, size) => {
      let format = u16(b, o);
      if (format === 0xfffe && size >= 40) format = u16(b, o + 24); // WAVE_FORMAT_EXTENSIBLE: 本当の形式は、サブ形式の先頭に入っている
      return { format, channels: u16(b, o + 2), rate: u32(b, o + 4), blockAlign: u16(b, o + 12), bits: u16(b, o + 14) };
    };
    let fmt = null;
    let data = null;

    if (["RIFF", "RF64", "BW64"].includes(tag(0)) && tag(8) === "WAVE") {
      let dataSize64 = null;
      for (let p = 12; p + 8 <= b.length; ) {
        const id = tag(p);
        let size = u32(b, p + 4);
        const body = p + 8;
        if (id === "ds64" && body + 16 <= b.length) dataSize64 = Number(dv.getBigUint64(body + 8, true));
        else if (id === "fmt ") fmt = readFmt(body, size);
        else if (id === "data") {
          if (size === 0xffffffff && dataSize64 !== null) size = dataSize64;
          data = b.subarray(body, Math.min(b.length, body + size));
          break;
        }
        p = body + size + (size & 1);
      }
    } else if (tag(0) === "riff" && tag(24) === "wave") {
      // Wave64: 各チャンクは 16 バイトの GUID + 8 バイトの大きさ(この見出しの分を含む)で、8 バイトの境界にそろえる
      for (let p = 40; p + 24 <= b.length; ) {
        const id = tag(p);
        const size = Number(dv.getBigUint64(b.byteOffset + p + 16 - b.byteOffset, true));
        const body = p + 24;
        if (id === "fmt ") fmt = readFmt(body, size - 24);
        else if (id === "data") {
          data = b.subarray(body, Math.min(b.length, p + size));
          break;
        }
        if (size < 24) break;
        p += (size + 7) & ~7;
      }
    } else {
      throw new Fallback();
    }
    if (!fmt || !data) fail("WAV の中身(形式の情報か、音のデータ)が見つかりません");
    return { fmt, data };
  }

  function decodeWav(bytes) {
    const { fmt, data } = parseWav(bytes);
    const { format, channels, bits } = fmt;
    if (!channels) fail("WAV のチャンネル数が正しくありません");
    let encoding;
    if (format === 1) encoding = { 8: "u8", 16: "s16le", 24: "s24le", 32: "s32le" }[bits];
    else if (format === 3) encoding = { 32: "f32le", 64: "f64le" }[bits];
    else if (format === 6 && bits === 8) encoding = "alaw";
    else if (format === 7 && bits === 8) encoding = "mulaw";
    if (!encoding) throw new Fallback(); // ADPCM・MP3 入りの WAV など。ffmpeg に任せる
    return { rate: fmt.rate, channels: readSamples(data, encoding, channels) };
  }

  // ---------- AIFF / AIFF-C ----------
  function decodeAiff(b) {
    const kind = ascii(b, 8, 4);
    if (ascii(b, 0, 4) !== "FORM" || (kind !== "AIFF" && kind !== "AIFC")) throw new Fallback();
    let comm = null;
    let data = null;
    for (let p = 12; p + 8 <= b.length; ) {
      const id = ascii(b, p, 4);
      const size = be32(b, p + 4);
      const body = p + 8;
      if (id === "COMM") {
        const exponent = ((b[body + 8] & 0x7f) << 8) | b[body + 9];
        const mantissa = be32(b, body + 10) * 2 ** 32 + be32(b, body + 14);
        comm = {
          channels: be16(b, body),
          bits: be16(b, body + 6),
          rate: Math.round(mantissa * 2 ** (exponent - 16383 - 63)), // 10 バイトの拡張倍精度の小数
          compression: kind === "AIFC" ? ascii(b, body + 18, 4) : "NONE",
        };
      } else if (id === "SSND") {
        const offset = be32(b, body);
        data = b.subarray(body + 8 + offset, Math.min(b.length, body + size));
      }
      p = body + size + (size & 1);
    }
    if (!comm || !data) fail("AIFF の中身(形式の情報か、音のデータ)が見つかりません");
    const c = comm.compression;
    let encoding;
    if (c === "NONE") encoding = { 8: "s8", 16: "s16be", 24: "s24be", 32: "s32be" }[comm.bits];
    else if (c === "sowt") encoding = "s16le";
    else if (c === "twos") encoding = { 8: "s8", 16: "s16be", 24: "s24be", 32: "s32be" }[comm.bits];
    else if (c === "in24") encoding = "s24be";
    else if (c === "in32") encoding = "s32be";
    else if (c === "fl32" || c === "FL32") encoding = "f32be";
    else if (c === "fl64" || c === "FL64") encoding = "f64be";
    else if (c === "ulaw" || c === "ULAW") encoding = "mulaw";
    else if (c === "alaw" || c === "ALAW") encoding = "alaw";
    if (!encoding) throw new Fallback();
    return { rate: comm.rate, channels: readSamples(data, encoding, comm.channels) };
  }

  // ---------- AU / SND(Sun・NeXT) ----------
  function decodeAu(b) {
    if (ascii(b, 0, 4) !== ".snd") throw new Fallback();
    const offset = be32(b, 4);
    let size = be32(b, 8);
    const encoding = { 1: "mulaw", 2: "s8", 3: "s16be", 4: "s24be", 5: "s32be", 6: "f32be", 7: "f64be", 27: "alaw" }[be32(b, 12)];
    if (!encoding) throw new Fallback();
    if (size === 0xffffffff || offset + size > b.length) size = b.length - offset;
    const channels = be32(b, 20);
    if (!channels) fail("AU のチャンネル数が正しくありません");
    return { rate: be32(b, 16), channels: readSamples(b.subarray(offset, offset + size), encoding, channels) };
  }

  // ---------- CAF(Apple) ----------
  function decodeCaf(b) {
    if (ascii(b, 0, 4) !== "caff") throw new Fallback();
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let desc = null;
    let data = null;
    for (let p = 8; p + 12 <= b.length; ) {
      const id = ascii(b, p, 4);
      const sizeBig = dv.getBigInt64(p + 4, false);
      const body = p + 12;
      const size = sizeBig < 0n ? b.length - body : Number(sizeBig);
      if (id === "desc") {
        desc = {
          rate: dv.getFloat64(body, false),
          format: ascii(b, body + 8, 4),
          flags: be32(b, body + 12),
          channels: be32(b, body + 24),
          bits: be32(b, body + 28),
        };
      } else if (id === "data") {
        data = b.subarray(body + 4, Math.min(b.length, body + size));
        break;
      }
      p = body + size;
    }
    if (!desc || !data) fail("CAF の中身(形式の情報か、音のデータ)が見つかりません");
    if (desc.format !== "lpcm") throw new Fallback(); // AAC・ALAC・Opus 入りなどは、ffmpeg に任せる
    const float = desc.flags & 1;
    const little = desc.flags & 2;
    const encoding = float ? `f${desc.bits}${little ? "le" : "be"}` : desc.bits === 8 ? "s8" : `s${desc.bits}${little ? "le" : "be"}`;
    return { rate: Math.round(desc.rate), channels: readSamples(data, encoding, desc.channels) };
  }

  // ---------- 生データ(ヘッダーなし) ----------
  // 形式の情報がないので、利用者に指定してもらう。拡張子で、よくある設定を初期値にする
  const RAW_DEFAULTS = {
    pcm: { encoding: "s16le", rate: 44100, channels: 2 },
    raw: { encoding: "s16le", rate: 44100, channels: 2 },
    sln: { encoding: "s16le", rate: 8000, channels: 1 }, // Asterisk の「Signed Linear」
    ulaw: { encoding: "mulaw", rate: 8000, channels: 1 },
    alaw: { encoding: "alaw", rate: 8000, channels: 1 },
    vox: { encoding: "oki", rate: 8000, channels: 1 }, // Dialogic の OKI ADPCM
  };

  // OKI(Dialogic)ADPCM: 1 サンプル 4 ビットの、電話向けの圧縮
  const OKI_STEPS = [16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552];
  const OKI_ADJUST = [-1, -1, -1, -1, 2, 4, 6, 8];
  function decodeOki(bytes) {
    const out = new Float32Array(bytes.length * 2);
    let signal = 0;
    let index = 0;
    let n = 0;
    for (const byte of bytes) {
      for (const nibble of [byte >> 4, byte & 15]) {
        const step = OKI_STEPS[index];
        // 差分は、まとめて 1 回だけ丸める(ステップごとに丸めると、誤差が積み重なって、音が大きくずれていく)
        const diff = ((2 * (nibble & 7) + 1) * step) >> 3;
        signal += nibble & 8 ? -diff : diff;
        signal = Math.max(-2048, Math.min(2047, signal)); // 12 ビット
        index = Math.max(0, Math.min(48, index + OKI_ADJUST[nibble & 7]));
        out[n++] = signal / 2048;
      }
    }
    return [out];
  }

  function decodeRaw(bytes, { ext, raw }) {
    const settings = { ...(RAW_DEFAULTS[ext] ?? RAW_DEFAULTS.pcm), ...raw };
    if (settings.encoding === "oki") return { rate: settings.rate, channels: decodeOki(bytes) };
    if (!(settings.rate > 0) || !(settings.channels > 0)) fail("生データの設定(サンプルレート・チャンネル数)が正しくありません");
    return { rate: settings.rate, channels: readSamples(bytes, settings.encoding, settings.channels) };
  }

  // ---------- ブラウザ標準(MP3・AAC・Ogg・FLAC など) ----------
  // decodeAudioData は、音を端末の再生用のサンプルレートに変換してしまうので、
  // ファイルの先頭から元のサンプルレートを読み取り、そのレートで読み込ませる
  const MPEG_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

  function probeRate(b) {
    let p = 0;
    if (ascii(b, 0, 3) === "ID3") p = 10 + (((b[6] & 127) << 21) | ((b[7] & 127) << 14) | ((b[8] & 127) << 7) | (b[9] & 127)); // 先頭のタグを読み飛ばす
    if (ascii(b, 0, 4) === "fLaC") return (b[18] << 12) | (b[19] << 4) | (b[20] >> 4);
    if (ascii(b, 0, 4) === "OggS") {
      const head = b.subarray(0, 512);
      for (let i = 0; i < head.length - 16; i++) {
        if (ascii(head, i, 7) === "\x01vorbis") return u32(head, i + 12);
        if (ascii(head, i, 8) === "OpusHead") return 48000;
      }
      return null;
    }
    if (ascii(b, 4, 4) === "ftyp") {
      // MP4・M4A: 音の情報の箱 (mp4a) に、サンプルレートが 16.16 の固定小数で入っている
      const limit = Math.min(b.length - 40, 1 << 20);
      for (let i = 0; i < limit; i++) {
        if (b[i] === 0x6d && ascii(b, i, 4) === "mp4a") return be32(b, i + 28) >>> 16;
      }
      return null;
    }
    for (let i = p; i < Math.min(b.length - 4, p + 4096); i++) {
      if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
      if ((b[i + 1] & 0xf6) === 0xf0) return ADTS_RATES[(b[i + 2] >> 2) & 15] ?? null; // AAC (ADTS)
      const version = (b[i + 1] >> 3) & 3; // MPEG-1 / 2 / 2.5 の MP3・MP2・MP1
      const index = (b[i + 2] >> 2) & 3;
      if (version !== 1 && index !== 3 && (b[i + 1] >> 1) & 3) return MPEG_RATES[version][index];
    }
    return null;
  }

  async function decodeNative(bytes) {
    const Context = window.AudioContext || window.webkitAudioContext;
    const rate = probeRate(bytes);
    let context;
    try {
      context = rate ? new Context({ sampleRate: rate }) : new Context();
    } catch {
      context = new Context();
    }
    try {
      const buffer = await context.decodeAudioData(bytes.slice().buffer);
      return { rate: buffer.sampleRate, channels: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice()) };
    } catch {
      throw new Fallback();
    } finally {
      context.close();
    }
  }

  // ---------- ffmpeg ----------
  // ffmpeg の出力(ログ)から、利用者に見せる理由を取り出す
  function ffmpegReason(logs) {
    const text = logs.join("\n");
    const codec = /Stream #\d+:\d+[^:]*: Audio: ([\w.]+)/.exec(text)?.[1];
    if (/Decoder \((\w+)\) not found|Unknown decoder '(\w+)'/.test(text)) {
      const name = /Decoder \((\w+)\) not found/.exec(text)?.[1] ?? codec;
      return `この音声の圧縮方式${name ? ` (${name})` : ""}には対応していません`;
    }
    if (/Invalid data found when processing input|Invalid argument|moov atom not found/.test(text)) {
      return "この形式のファイルとして読み込めませんでした(壊れているか、対応していない形式かもしれません)";
    }
    if (/Stream map '0:a:0' matches no streams|does not contain any stream/.test(text)) return "このファイルには、音声が含まれていません";
    if (/DRM|encrypted|activation_bytes|Invalid key/i.test(text)) return "暗号化(著作権保護)されたファイルは、読み込めません";
    return "このファイルの音声を読み込めませんでした";
  }

  // 拡張子によっては、ffmpeg に「こういう形式です」と教える必要がある(中身から判別できないため)
  const FFMPEG_INPUT_OPTIONS = {
    gsm: ["-f", "gsm", "-ar", "8000"],
    ilbc: ["-f", "ilbc"],
    evrc: ["-f", "qcp"],
  };

  async function decodeFfmpeg(bytes, { ext, onStatus }) {
    onStatus?.("変換エンジン (ffmpeg) を読み込み中… 初回は約 32 MB かかります");
    const name = "in." + (/^[a-z0-9]{1,8}$/.test(ext) ? ext : "bin");
    const result = await Tools.ffmpeg.run({
      args: ["-hide_banner", "-nostdin", ...(FFMPEG_INPUT_OPTIONS[ext] ?? []), "-i", name, "-vn", "-map", "0:a:0", "-f", "wav", "-acodec", "pcm_f32le", "out.wav"],
      inputs: { [name]: bytes.slice() },
      outputs: ["out.wav"],
      onProgress: () => onStatus?.("読み込み中…"),
    });
    const wav = result.files["out.wav"];
    if (!wav || wav.length < 44) fail(ffmpegReason(result.logs));
    const { fmt, data } = parseWav(wav);
    return { rate: fmt.rate, channels: readSamples(data, "f32le", fmt.channels), notes: ["ffmpeg で読み込みました"] };
  }

  // DSDIFF (.dff) を、ffmpeg が読める DSF の形に組み替える(音は同じ。入れ物の形だけを変える)
  function dffToDsf(b) {
    if (ascii(b, 0, 4) !== "FRM8") throw new Fallback();
    let channels = 2;
    let rate = 2822400;
    let data = null;
    for (let p = 16; p + 12 <= b.length; ) {
      const id = ascii(b, p, 4);
      const size = Number(new DataView(b.buffer, b.byteOffset).getBigUint64(p + 4, false));
      const body = p + 12;
      if (id === "PROP") {
        for (let q = body + 4; q + 12 <= body + size; ) {
          const sub = ascii(b, q, 4);
          const subSize = Number(new DataView(b.buffer, b.byteOffset).getBigUint64(q + 4, false));
          if (sub === "FS  ") rate = be32(b, q + 12);
          if (sub === "CHNL") channels = be16(b, q + 12);
          q += 12 + subSize + (subSize & 1);
        }
      } else if (id === "DSD ") {
        data = b.subarray(body, Math.min(b.length, body + size));
      }
      p = body + size + (size & 1);
    }
    if (!data) fail("DSDIFF の中に、音のデータが見つかりません");
    // DFF は、チャンネルが 1 バイトずつ交互に並び、各バイトは上位ビットから。DSF は、チャンネルごとに 4096 バイトの塊で、各バイトは下位ビットから
    const block = 4096;
    const perChannel = Math.floor(data.length / channels);
    const blocks = Math.ceil(perChannel / block);
    const reverse = (v) => {
      let r = 0;
      for (let i = 0; i < 8; i++) r |= ((v >> i) & 1) << (7 - i);
      return r;
    };
    const body = new Uint8Array(blocks * block * channels);
    for (let blk = 0; blk < blocks; blk++) {
      for (let c = 0; c < channels; c++) {
        for (let i = 0; i < block; i++) {
          const at = blk * block + i;
          if (at < perChannel) body[(blk * channels + c) * block + i] = reverse(data[at * channels + c]);
        }
      }
    }
    const header = new DataView(new ArrayBuffer(28 + 52 + 12));
    const text = (o, s) => [...s].forEach((ch, i) => header.setUint8(o + i, ch.charCodeAt(0)));
    text(0, "DSD ");
    header.setBigUint64(4, 28n, true);
    header.setBigUint64(12, BigInt(92 + body.length), true);
    header.setBigUint64(20, 0n, true);
    text(28, "fmt ");
    header.setBigUint64(32, 52n, true);
    header.setUint32(40, 1, true);
    header.setUint32(44, 0, true);
    header.setUint32(48, channels === 1 ? 1 : 2, true);
    header.setUint32(52, channels, true);
    header.setUint32(56, rate, true);
    header.setUint32(60, 1, true);
    header.setBigUint64(64, BigInt(perChannel * 8), true);
    header.setUint32(72, block, true);
    header.setUint32(76, 0, true);
    text(80, "data");
    header.setBigUint64(84, BigInt(12 + body.length), true);
    const dsf = new Uint8Array(92 + body.length);
    dsf.set(new Uint8Array(header.buffer));
    dsf.set(body, 92);
    return dsf;
  }

  // ---------- トラッカー音楽(MOD・XM・IT・S3M など) ----------
  async function decodeTracker(bytes, { onStatus }) {
    onStatus?.("トラッカー音楽用のプログラムを読み込み中…");
    let render;
    try {
      render = (await import(LIBS.tracker)).default;
    } catch {
      fail("トラッカー音楽用のプログラムを読み込めませんでした。ネットワーク接続を確認してください");
    }
    onStatus?.("演奏を音にしています…");
    let result;
    try {
      result = await render(bytes, { sampleRate: 44100, channels: 2 });
    } catch (e) {
      fail("このファイルを、トラッカー音楽として読み込めませんでした" + (e.message ? `(${String(e.message).replace(/^MOD: /, "")})` : ""));
    }
    if (!result.channelData.length) fail("演奏する内容が見つかりませんでした");
    return { rate: result.sampleRate, channels: result.channelData, notes: ["曲の長さが決まらないときは、最長 10 分で切ります"] };
  }

  // ---------- SID(コモドール 64 の音楽) ----------
  // SID は、曲のデータではなく「C64 で動かすプログラム」なので、C64 を模したエミュレーターで実際に動かして、音を録る。
  // 曲の長さが決まっていない(ずっと繰り返す)ものが多いので、決まった長さで切る
  const SID_SECONDS = 180;
  async function decodeSid(bytes, { onStatus }) {
    onStatus?.("SID 用のプログラムを読み込み中…");
    let SidAudioEngine;
    try {
      ({ SidAudioEngine } = await import(LIBS.sid));
    } catch {
      fail("SID 用のプログラムを読み込めませんでした。ネットワーク接続を確認してください");
    }
    const engine = new SidAudioEngine({ sampleRate: 44100, stereo: true });
    try {
      try {
        await engine.loadSidBuffer(bytes.slice());
      } catch {
        fail("SID ファイルとして読み込めません");
      }
      onStatus?.("C64 を動かして、音にしています…");
      const pcm = await engine.renderSeconds(SID_SECONDS);
      if (!pcm.length) fail("音が出ませんでした");
      const frames = pcm.length >> 1;
      const channels = [new Float32Array(frames), new Float32Array(frames)];
      for (let i = 0; i < frames; i++) {
        channels[0][i] = pcm[i * 2] / 32768;
        channels[1][i] = pcm[i * 2 + 1] / 32768;
      }
      return { rate: 44100, channels, notes: [`SID は曲の長さが決まっていないため、最初の ${SID_SECONDS / 60} 分を録りました`] };
    } finally {
      engine.dispose();
    }
  }

  // ---------- MIDI(簡易音源) ----------
  // MIDI は、音ではなく「演奏の指示」なので、音にするには音源が要る。ここでは、ごく簡単な音源で鳴らす
  // (楽器ごとの音色は、大まかな種類にしか分けていません)
  function parseMidi(b) {
    // RIFF で包んだ MIDI (.rmi) は、中から MIDI を取り出す
    let start = 0;
    if (ascii(b, 0, 4) === "RIFF") {
      start = -1;
      for (let i = 0; i + 4 < b.length; i++) {
        if (ascii(b, i, 4) === "MThd") {
          start = i;
          break;
        }
      }
      if (start < 0) fail("MIDI のデータが見つかりません");
    }
    b = b.subarray(start);
    if (ascii(b, 0, 4) !== "MThd") fail("MIDI として読み込めません");
    const tracksCount = be16(b, 10);
    const division = be16(b, 12);
    if (division & 0x8000) fail("この MIDI の時間の表し方 (SMPTE) には対応していません");
    const events = [];
    let p = 8 + be32(b, 4);
    for (let t = 0; t < tracksCount && p + 8 <= b.length; t++) {
      if (ascii(b, p, 4) !== "MTrk") break;
      const end = Math.min(b.length, p + 8 + be32(b, p + 4));
      let q = p + 8;
      let tick = 0;
      let status = 0;
      const vlq = () => {
        let v = 0;
        for (;;) {
          const byte = b[q++];
          v = (v << 7) | (byte & 127);
          if (!(byte & 128) || q >= end) return v;
        }
      };
      while (q < end) {
        tick += vlq();
        let first = b[q];
        if (first === 0xff) {
          const type = b[q + 1];
          q += 2;
          const len = vlq();
          if (type === 0x51) events.push({ tick, type: "tempo", value: (b[q] << 16) | (b[q + 1] << 8) | b[q + 2] });
          q += len;
          if (type === 0x2f) break;
          continue;
        }
        if (first === 0xf0 || first === 0xf7) {
          q++;
          q += vlq();
          continue;
        }
        if (first & 0x80) {
          status = first;
          q++;
        } else first = status; // 直前と同じ種類の指示は、種類を省略できる(ランニングステータス)
        const kind = status & 0xf0;
        const channel = status & 15;
        if (kind === 0xc0 || kind === 0xd0) events.push({ tick, type: kind === 0xc0 ? "program" : "ignore", channel, a: b[q++] });
        else {
          const a = b[q++];
          const d = b[q++];
          if (kind === 0x90) events.push({ tick, type: d ? "on" : "off", channel, a, b: d });
          else if (kind === 0x80) events.push({ tick, type: "off", channel, a, b: d });
          else if (kind === 0xb0) events.push({ tick, type: "control", channel, a, b: d });
          else if (kind === 0xe0) events.push({ tick, type: "bend", channel, a: (d << 7) | a });
        }
      }
      p = end;
    }
    events.sort((x, y) => x.tick - y.tick);
    // 拍の長さ(テンポ)の変化をたどって、ティックを秒にする
    let tempo = 500000;
    let seconds = 0;
    let lastTick = 0;
    for (const e of events) {
      seconds += ((e.tick - lastTick) * tempo) / division / 1e6;
      lastTick = e.tick;
      e.time = seconds;
      if (e.type === "tempo") tempo = e.value;
    }
    return events;
  }

  // 楽器の番号 (0〜127) を、大まかな音色に分ける
  function timbreOf(program) {
    if (program < 8) return "piano";
    if (program < 16 || (program >= 112 && program < 120)) return "bell";
    if (program < 24) return "organ";
    if (program < 32) return "pluck";
    if (program < 40) return "bass";
    if (program < 56) return "strings";
    if (program < 80) return "reed";
    if (program < 96) return "lead";
    if (program < 104) return "pad";
    return "pluck";
  }
  const ENVELOPES = {
    // [立ち上がり, 減衰の速さ(1/秒), 残る大きさ, 余韻]
    piano: [0.003, 2.2, 0.0, 0.25],
    bell: [0.002, 1.6, 0.0, 0.5],
    organ: [0.012, 0, 1.0, 0.06],
    pluck: [0.002, 3.0, 0.0, 0.15],
    bass: [0.004, 1.6, 0.35, 0.12],
    strings: [0.09, 0, 0.9, 0.3],
    reed: [0.04, 0.5, 0.7, 0.12],
    lead: [0.012, 0.3, 0.8, 0.1],
    pad: [0.18, 0, 0.9, 0.5],
  };
  const HARMONICS = {
    piano: [1, 0.5, 0.25, 0.12, 0.06],
    bell: [1, 0, 0.6, 0, 0.3],
    organ: [1, 0.8, 0.5, 0.4, 0.2],
    pluck: [1, 0.6, 0.35, 0.2, 0.1],
    bass: [1, 0.55, 0.2, 0.08],
    strings: [1, 0.45, 0.4, 0.3, 0.2, 0.12],
    reed: [1, 0.2, 0.55, 0.1, 0.35],
    lead: [1, 0.5, 0.33, 0.25, 0.2, 0.16],
    pad: [1, 0.3, 0.2, 0.1],
  };

  const WAVETABLE_SIZE = 2048;
  const WAVETABLES = Object.fromEntries(
    Object.entries(HARMONICS).map(([name, harmonics]) => [
      name,
      Float32Array.from({ length: WAVETABLE_SIZE }, (_, i) => harmonics.reduce((sum, amplitude, h) => sum + amplitude * Math.sin((2 * Math.PI * (h + 1) * i) / WAVETABLE_SIZE), 0)),
    ])
  );

  function renderMidi(events, rate = 44100) {
    const notes = [];
    const programs = new Array(16).fill(0);
    const volume = new Array(16).fill(100);
    const expression = new Array(16).fill(127);
    const pan = new Array(16).fill(64);
    const sustain = new Array(16).fill(false);
    const open = new Map();
    const released = [];
    let end = 0;
    const closeNote = (note, time) => {
      note.end = time;
      end = Math.max(end, time + 1.5);
    };
    for (const e of events) {
      if (e.type === "program") programs[e.channel] = e.a;
      else if (e.type === "control") {
        if (e.a === 7) volume[e.channel] = e.b;
        else if (e.a === 11) expression[e.channel] = e.b;
        else if (e.a === 10) pan[e.channel] = e.b;
        else if (e.a === 64) {
          sustain[e.channel] = e.b >= 64;
          if (!sustain[e.channel]) {
            for (const note of released.filter((n) => n.channel === e.channel)) closeNote(note, e.time);
            for (let i = released.length - 1; i >= 0; i--) if (released[i].channel === e.channel) released.splice(i, 1);
          }
        } else if (e.a === 123 || e.a === 120) {
          for (const [key, note] of open) if (note.channel === e.channel) (open.delete(key), closeNote(note, e.time));
        }
      } else if (e.type === "on") {
        const key = e.channel * 128 + e.a;
        if (open.has(key)) closeNote(open.get(key), e.time);
        const note = {
          channel: e.channel,
          key: e.a,
          velocity: e.b,
          start: e.time,
          end: null,
          drum: e.channel === 9,
          timbre: timbreOf(programs[e.channel]),
          level: (volume[e.channel] / 127) * (expression[e.channel] / 127),
          pan: pan[e.channel] / 127,
        };
        notes.push(note);
        open.set(key, note);
      } else if (e.type === "off") {
        const key = e.channel * 128 + e.a;
        const note = open.get(key);
        if (!note) continue;
        open.delete(key);
        if (sustain[e.channel] && !note.drum) released.push(note);
        else closeNote(note, e.time);
      }
    }
    for (const note of notes) if (note.end === null) closeNote(note, end || note.start + 1);
    if (!notes.length) fail("演奏する音(ノート)が見つかりませんでした");

    const total = Math.min(15 * 60, Math.max(...notes.map((n) => n.end)) + 1);
    const frames = Math.ceil(total * rate);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    let noise = 12345;
    const random = () => ((noise = (noise * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;

    for (const note of notes) {
      const gain = 0.16 * (note.velocity / 127) ** 1.3 * note.level;
      const from = Math.floor(note.start * rate);
      const panL = Math.cos(note.pan * (Math.PI / 2));
      const panR = Math.sin(note.pan * (Math.PI / 2));
      if (note.drum) {
        // ドラム: 低い音はキック(音程が下がる正弦波)、それ以外は雑音の短いかたまり
        const kick = note.key === 35 || note.key === 36;
        const length = Math.floor((kick ? 0.28 : note.key === 46 || note.key === 49 || note.key === 51 ? 0.35 : 0.14) * rate);
        let phase = 0;
        for (let i = 0; i < length && from + i < frames; i++) {
          const t = i / rate;
          const decay = Math.exp(-t * (kick ? 14 : 28));
          let v;
          if (kick) {
            phase += (2 * Math.PI * (45 + 110 * Math.exp(-t * 28))) / rate;
            v = Math.sin(phase);
          } else v = random() * 0.8;
          left[from + i] += v * decay * gain * 2.2 * panL;
          right[from + i] += v * decay * gain * 2.2 * panR;
        }
        continue;
      }
      const [attack, decayRate, sustainLevel, release] = ENVELOPES[note.timbre];
      const table = WAVETABLES[note.timbre];
      const frequency = 440 * 2 ** ((note.key - 69) / 12);
      const step = (frequency / rate) * WAVETABLE_SIZE;
      // 高い音は、倍音が可聴域を超えて雑音(折り返し)になるので、その分だけ音量を下げる
      const brightness = frequency > 1500 ? Math.max(0.35, 1500 / frequency) : 1;
      const length = Math.min(Math.floor((note.end - note.start + release * 4) * rate), frames - from);
      const heldSamples = (note.end - note.start) * rate;
      for (let i = 0; i < length; i++) {
        const t = i / rate;
        let envelope = Math.min(1, t / attack) * (sustainLevel + (1 - sustainLevel) * Math.exp(-t * decayRate));
        if (i > heldSamples) envelope *= Math.exp(-(i - heldSamples) / rate / (release / 4));
        if (envelope < 0.0005 && i > heldSamples) break;
        const position = (i * step) % WAVETABLE_SIZE;
        const index = position | 0;
        const next = table[(index + 1) % WAVETABLE_SIZE];
        const v = (table[index] + (next - table[index]) * (position - index)) * envelope * gain * brightness;
        left[from + i] += v * panL;
        right[from + i] += v * panR;
      }
    }
    // 音が重なって割れないよう、全体の大きさをそろえる
    let peak = 0;
    for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
    const scale = peak > 0.95 ? 0.95 / peak : 1;
    if (scale !== 1) for (let i = 0; i < frames; i++) ((left[i] *= scale), (right[i] *= scale));
    return { rate, channels: [left, right] };
  }

  // Doom の MUS 形式を、MIDI に直す
  function musToMidi(b) {
    if (ascii(b, 0, 3) !== "MUS" || b[3] !== 0x1a) throw new Fallback();
    const start = u16(b, 6);
    const track = [];
    const vlq = (v) => {
      const out = [v & 127];
      for (v >>= 7; v > 0; v >>= 7) out.unshift((v & 127) | 128);
      return out;
    };
    const lastVolume = new Array(16).fill(100);
    const channelMap = new Map();
    let nextChannel = 0;
    const mapChannel = (c) => {
      if (c === 15) return 9; // MUS のチャンネル 15 は、打楽器
      if (!channelMap.has(c)) {
        if (nextChannel === 9) nextChannel++;
        channelMap.set(c, nextChannel++);
      }
      return channelMap.get(c);
    };
    let delay = 0;
    const push = (...bytes) => {
      track.push(...vlq(delay), ...bytes);
      delay = 0;
    };
    const controllers = { 0: -1, 1: 0, 2: 1, 3: 7, 4: 10, 5: 11, 6: 91, 7: 93, 8: 64, 9: 67, 10: 120, 11: 123, 12: 126, 13: 127, 14: 121 };
    for (let p = start; p < b.length; ) {
      const head = b[p++];
      const type = (head >> 4) & 7;
      const channel = mapChannel(head & 15);
      if (type === 0) push(0x80 | channel, b[p++] & 127, 0);
      else if (type === 1) {
        const n = b[p++];
        if (n & 128) lastVolume[channel] = b[p++] & 127;
        push(0x90 | channel, n & 127, lastVolume[channel]);
      } else if (type === 2) {
        const v = b[p++];
        push(0xe0 | channel, (v << 6) & 127, v >> 1);
      } else if (type === 3) {
        const c = controllers[b[p++]];
        push(0xb0 | channel, c, 0);
      } else if (type === 4) {
        const c = b[p++];
        const v = b[p++];
        if (c === 0) push(0xc0 | channel, v);
        else if (controllers[c] > 0) push(0xb0 | channel, controllers[c], v);
      } else if (type === 6) break;
      if (head & 128) {
        let d = 0;
        let byte;
        do {
          byte = b[p++];
          d = d * 128 + (byte & 127);
        } while (byte & 128 && p < b.length);
        delay += d;
      }
    }
    track.push(...vlq(delay), 0xff, 0x2f, 0);
    // MUS の 1 ティックは 1/140 秒。1 拍 = 0.5 秒、70 ティック/拍にそろえる
    const out = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 70, 0x4d, 0x54, 0x72, 0x6b, (track.length >>> 24) & 255, (track.length >>> 16) & 255, (track.length >>> 8) & 255, track.length & 255, ...track];
    return Uint8Array.from(out);
  }

  // Miles の XMI 形式を、MIDI に直す(音符の長さが、音符の指示の直後に入っている)
  function xmiToMidi(b) {
    if (ascii(b, 0, 4) !== "FORM") throw new Fallback();
    let evnt = null;
    for (let i = 0; i + 8 < b.length; i++) {
      if (ascii(b, i, 4) === "EVNT") {
        evnt = b.subarray(i + 8, i + 8 + be32(b, i + 4));
        break;
      }
    }
    if (!evnt) fail("XMI の中に、演奏の指示が見つかりません");
    const events = [];
    let time = 0;
    for (let p = 0; p < evnt.length; ) {
      const byte = evnt[p];
      if (byte < 0x80) {
        time += byte; // 待ち時間
        p++;
        continue;
      }
      const kind = byte & 0xf0;
      if (byte === 0xff) {
        const type = evnt[p + 1];
        let q = p + 2;
        let len = 0;
        let b2;
        do {
          b2 = evnt[q++];
          len = (len << 7) | (b2 & 127);
        } while (b2 & 128);
        events.push({ time, bytes: [0xff, type, ...encodeVlq(len), ...evnt.subarray(q, q + len)] });
        p = q + len;
        if (type === 0x2f) break;
      } else if (kind === 0x90) {
        let q = p + 3;
        let duration = 0;
        let b2;
        do {
          b2 = evnt[q++];
          duration = (duration << 7) | (b2 & 127);
        } while (b2 & 128);
        events.push({ time, bytes: [byte, evnt[p + 1], evnt[p + 2]] }, { time: time + duration, bytes: [0x80 | (byte & 15), evnt[p + 1], 0] });
        p = q;
      } else if (kind === 0xc0 || kind === 0xd0) {
        events.push({ time, bytes: [byte, evnt[p + 1]] });
        p += 2;
      } else {
        events.push({ time, bytes: [byte, evnt[p + 1], evnt[p + 2]] });
        p += 3;
      }
    }
    function encodeVlq(v) {
      const out = [v & 127];
      for (v >>= 7; v > 0; v >>= 7) out.unshift((v & 127) | 128);
      return out;
    }
    events.sort((x, y) => x.time - y.time);
    const track = [];
    let last = 0;
    for (const e of events) {
      track.push(...encodeVlq(e.time - last), ...e.bytes);
      last = e.time;
    }
    track.push(0, 0xff, 0x2f, 0);
    // XMI は、1 秒 120 ティック。1 拍 = 0.5 秒、60 ティック/拍にそろえる
    return Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 60, 0x4d, 0x54, 0x72, 0x6b, (track.length >>> 24) & 255, (track.length >>> 16) & 255, (track.length >>> 8) & 255, track.length & 255, ...track]);
  }

  function decodeMidi(bytes, { ext, onStatus }) {
    onStatus?.("簡易音源で演奏しています…");
    let midi = bytes;
    if (ext === "mus") midi = musToMidi(bytes);
    else if (ext === "xmi") midi = xmiToMidi(bytes);
    const result = renderMidi(parseMidi(midi));
    return { ...result, notes: ["MIDI は「演奏の指示」なので、簡易的な音源で鳴らしています(実際の音色とは違います)"] };
  }

  // ---------- 拡張子ごとの読み方 ----------
  // 前から順に試す。空の配列は「読み込めない形式」(理由は REASONS にある)
  const READERS = {};
  const add = (exts, decoders) => exts.split(" ").forEach((e) => (READERS[e] = decoders));

  add("mp3 mp2 mp1 mpa aac adts m4a m4b m4p m4r flac ogg oga opus", ["native", "ffmpeg"]);
  add("mka", ["ffmpeg", "native"]); // Matroska は、ブラウザ標準だと、間違ったサンプルレートで読んでしまうことがある
  add("wav wave bwf w64 rf64", ["wav", "ffmpeg"]);
  add("aif aiff aifc aifff", ["aiff", "ffmpeg"]);
  add("au snd", ["au", "ffmpeg"]);
  add("caf", ["caf", "ffmpeg"]);
  add("pcm raw sln ulaw alaw vox", ["raw"]);
  add("spx wma ape wv tta shn tak mpc mpp mp+ alac ac3 eac3 ec3 dts dtshd mlp thd dsf amr awb gsm ilbc voc dss ds2 sph nist 8svx 8sv iff sds sf ircam wve avr pvf ra aa aax aaxc oma omg at3 at9 aa3 qcp evrc vqf", ["ffmpeg"]);
  add("dff dsd", ["dsd", "ffmpeg"]);
  // 動画ファイル: 最初の音声だけを取り出す(映像は使わない)
  add("mp4 m4v mov 3gp 3g2 webm", ["native", "ffmpeg"]);
  add("mkv avi wmv asf flv mpg mpeg ogv rm rmvb", ["ffmpeg"]);
  add("mid midi kar rmi xmi mus", ["midi"]);
  add("mod xm it s3m stm mtm 669 amf okt med far ult mt2 psm umx", ["tracker"]);
  add("sid", ["sid"]);
  // 下の形式は、一覧には載っているが、ブラウザだけでは読めない
  add("ram wvc ofr ofs vce dvf msv sd2 htk smp smpc smv celt bonk la pac rka rkau sap nsf spc vgm vgz gym ay gbs hes kss", []);

  const REASONS = {};
  const reason = (exts, text) => exts.split(" ").forEach((e) => (REASONS[e] = text));
  reason("ram", "RAM は、RealAudio の曲の場所を書いただけのテキストで、音は入っていません(.ra / .rm を指定してください)");
  reason("wvc", "WavPack の補正ファイルです。本体の .wv ファイルのほうを指定してください");
  reason("ofr ofs", "OptimFROG は、ブラウザだけでは読み込めません");
  reason("dvf msv", "ソニーのボイスレコーダー形式は、ブラウザだけでは読み込めません");
  reason("vce sd2 htk smp smpc smv", "この形式は、ブラウザだけでは読み込めません");
  reason("celt bonk la pac rka rkau", "この音声の圧縮方式は、ブラウザだけでは読み込めません");
  reason("sap nsf spc vgm vgz gym ay gbs hes kss", "ゲーム機の音楽(エミュレーターで鳴らす形式)は、ブラウザだけでは読み込めません");

  // ---------- 本体 ----------
  async function decode(file, { raw, onStatus } = {}) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ext = extOf(file.name);
    const known = READERS[ext];
    let order = known ?? ["native", "wav", "aiff", "au", "caf", "ffmpeg"]; // 拡張子から分からないときは、順に試す
    if (known && !known.length) fail(REASONS[ext] ?? "この形式は、ブラウザだけでは読み込めません");
    // 拡張子が間違っていても、中身で分かるものは、先にそちらで読む
    const head = ascii(bytes, 0, 4);
    if (head === "RIFF" || head === "RF64" || head === "BW64" || head === "riff") order = ["wav", ...order];
    else if (head === "FORM" && ascii(bytes, 8, 4).startsWith("AIF")) order = ["aiff", ...order];
    else if (head === ".snd") order = ["au", ...order];
    else if (head === "caff") order = ["caf", ...order];
    order = [...new Set(order)];

    let result = null;
    let lastError = null;
    for (const name of order) {
      try {
        if (name === "wav") result = decodeWav(bytes);
        else if (name === "aiff") result = decodeAiff(bytes);
        else if (name === "au") result = decodeAu(bytes);
        else if (name === "caf") result = decodeCaf(bytes);
        else if (name === "raw") result = decodeRaw(bytes, { ext, raw });
        else if (name === "native") result = await decodeNative(bytes);
        else if (name === "tracker") result = await decodeTracker(bytes, { onStatus });
        else if (name === "midi") result = decodeMidi(bytes, { ext, onStatus });
        else if (name === "sid") result = await decodeSid(bytes, { onStatus });
        else if (name === "dsd") {
          const dsf = ascii(bytes, 0, 4) === "FRM8" ? dffToDsf(bytes) : bytes;
          result = await decodeFfmpeg(dsf, { ext: "dsf", onStatus });
        } else if (name === "ffmpeg") result = await decodeFfmpeg(bytes, { ext, onStatus });
        break;
      } catch (e) {
        if (e instanceof Fallback) continue;
        lastError = e instanceof UserError ? e : new UserError("音声として読み込めませんでした。壊れたファイルか、対応していない形式かもしれません");
        if (!(e instanceof UserError)) console.error(e);
        // 専用の読み方で「読めない」と分かったら、そこで止める(ffmpeg でも読めないことが多い)
        if (name !== "native") break;
      }
    }
    if (!result) throw lastError ?? new UserError("この音声の形式には対応していません");
    if (!result.channels.length || !result.channels[0].length) fail("音声のデータが空です");
    return { rate: result.rate, channels: result.channels, frames: result.channels[0].length, duration: result.channels[0].length / result.rate, notes: result.notes ?? [] };
  }

  const rawFormats = Object.keys(RAW_DEFAULTS);
  return {
    decode,
    extensions: Object.keys(READERS),
    isAudioExt: (ext) => ext in READERS,
    videoExts: "mp4 m4v mov 3gp 3g2 webm mkv avi wmv asf flv mpg mpeg ogv rm rmvb".split(" "),
    canRead: (ext) => Boolean(READERS[ext]?.length),
    isRaw: (ext) => rawFormats.includes(ext),
    rawDefaults: (ext) => RAW_DEFAULTS[ext] ?? RAW_DEFAULTS.pcm,
    reasonFor: (ext) => REASONS[ext],
    accept: ["audio/*", ...Object.keys(READERS).map((e) => "." + e)].join(","),
    readers: READERS,
    UserError,
  };
})();
