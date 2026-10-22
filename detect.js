// 自動選択: ドロップされたファイルの中身から種類を調べ、合う変換ツールを表示して渡す。
(() => {
  const { $, readText } = Tools;

  const TEXT_LIMIT = 5 * 1024 * 1024; // これより大きいテキストは、形式の判定をしない
  const ENCODE_LIMIT = 1024 * 1024; // エンコードのツールに渡せるテキストの大きさ
  const DATA_FORMATS = { json: "JSON", yaml: "YAML", csv: "CSV", xml: "XML" };

  // ---------- 先頭のバイト列による判定 ----------
  const bytesAt = (b, at, values) => values.every((v, i) => b[at + i] === v);
  const asciiAt = (b, at, s) => bytesAt(b, at, [...s].map((c) => c.charCodeAt(0)));
  const brandOf = (b) => (asciiAt(b, 4, "ftyp") ? String.fromCharCode(...b.slice(8, 12)) : null);
  const isRiff = (b, type) => asciiAt(b, 0, "RIFF") && asciiAt(b, 8, type);

  // kind: image / audio(動画も、音声を取り出せる) / pdf / other(このページでは変換できない)
  const SIGNATURES = [
    { label: "PNG 画像", kind: "image", test: (b) => bytesAt(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    { label: "JPEG 画像", kind: "image", test: (b) => bytesAt(b, 0, [0xff, 0xd8, 0xff]) },
    { label: "GIF 画像", kind: "image", test: (b) => asciiAt(b, 0, "GIF87a") || asciiAt(b, 0, "GIF89a") },
    { label: "WebP 画像", kind: "image", test: (b) => isRiff(b, "WEBP") },
    { label: "BMP 画像", kind: "image", test: (b) => asciiAt(b, 0, "BM") && bytesAt(b, 6, [0, 0, 0, 0]) },
    { label: "ICO アイコン", kind: "image", test: (b) => bytesAt(b, 0, [0, 0, 1, 0]) && b[4] > 0 },
    { label: "TIFF 画像", kind: "image", test: (b) => bytesAt(b, 0, [0x49, 0x49, 0x2a, 0x00]) || bytesAt(b, 0, [0x4d, 0x4d, 0x00, 0x2a]) },
    { label: "AVIF 画像", kind: "image", test: (b) => ["avif", "avis"].includes(brandOf(b)) },
    { label: "HEIC / HEIF 画像", kind: "image", test: (b) => ["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"].includes(brandOf(b)) },
    { label: "PDF", kind: "pdf", test: (b) => asciiAt(b, 0, "%PDF-") },
    { label: "WAV 音声", kind: "audio", test: (b) => isRiff(b, "WAVE") },
    { label: "AVI 動画", kind: "audio", test: (b) => isRiff(b, "AVI ") },
    { label: "AAC 音声", kind: "audio", test: (b) => b[0] === 0xff && (b[1] & 0xf6) === 0xf0 },
    { label: "MP3 音声", kind: "audio", test: (b) => asciiAt(b, 0, "ID3") || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0) },
    { label: "Ogg 音声", kind: "audio", test: (b) => asciiAt(b, 0, "OggS") },
    { label: "FLAC 音声", kind: "audio", test: (b) => asciiAt(b, 0, "fLaC") },
    { label: "MIDI 音楽データ", kind: "other", test: (b) => asciiAt(b, 0, "MThd") },
    { label: "M4A 音声", kind: "audio", test: (b) => ["M4A ", "M4B "].includes(brandOf(b)) },
    { label: "MP4・MOV 系の動画", kind: "audio", test: (b) => brandOf(b) !== null },
    { label: "WebM・MKV 動画", kind: "audio", test: (b) => bytesAt(b, 0, [0x1a, 0x45, 0xdf, 0xa3]) },
    { label: "ZIP 形式のファイル", kind: "other", test: (b) => bytesAt(b, 0, [0x50, 0x4b, 0x03, 0x04]) },
    { label: "GZIP 圧縮ファイル", kind: "other", test: (b) => bytesAt(b, 0, [0x1f, 0x8b]) },
    { label: "7-Zip 圧縮ファイル", kind: "other", test: (b) => bytesAt(b, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) },
    { label: "RAR 圧縮ファイル", kind: "other", test: (b) => asciiAt(b, 0, "Rar!") },
  ];

  // ---------- テキストの判定 ----------
  function looksLikeText(head) {
    if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)) return true;
    let control = 0;
    for (const b of head) {
      if (b === 0) return false;
      if (b < 9 || (b > 13 && b < 32)) control++;
    }
    return control / head.length < 0.02;
  }

  // カンマ区切りの列数が全行そろっているかを見る(引用符の中のカンマは数えない)
  function commaCounts(lines) {
    return lines.map((line) => {
      let quoted = false;
      let n = 0;
      for (const c of line) {
        if (c === '"') quoted = !quoted;
        else if (c === "," && !quoted) n++;
      }
      return n;
    });
  }

  // 戻り値は json / xml / csv / yaml / svg / text
  function classifyText(text) {
    const t = text.replace(/^﻿/, "").trim();
    if (/^[{[]/.test(t)) {
      try {
        JSON.parse(t);
        return "json";
      } catch {}
    }
    if (t.startsWith("<")) {
      const doc = new DOMParser().parseFromString(t, "application/xml");
      if (!doc.querySelector("parsererror")) return doc.documentElement.tagName.toLowerCase() === "svg" ? "svg" : "xml";
    }
    const lines = t.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length >= 2) {
      const counts = commaCounts(lines.slice(0, 100));
      if (counts[0] >= 1 && counts.every((n) => n === counts[0])) return "csv";
      const keyed = lines.filter((l) => /^\s*(-\s+)?[\w.\-"'぀-鿿]+\s*:(\s|$)/.test(l) || /^\s*-\s+\S/.test(l) || /^\s*#/.test(l));
      if (keyed.length / lines.length >= 0.6 && /:(\s|$)/.test(t)) return "yaml";
    }
    return "text";
  }

  // ---------- 変換ツールへの引き渡し ----------
  function handOff(file, input) {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    $(input).files = transfer.files;
    $(input).dispatchEvent(new Event("change", { bubbles: true }));
  }

  const TOOLS = {
    image: { tab: "image", open: (f) => handOff(f, "i-file") },
    audio: { tab: "audio", open: (f) => handOff(f, "a-file") },
    pdf: { tab: "pdf", open: (f) => handOff(f, "p-file") },
    // 拡張子が中身と違うこともあるので、判定した形式をそのまま指定して渡す
    data: {
      tab: "data",
      open: async (f, format) => {
        $("d-in").value = (await readText(f)).text;
        $("d-from").value = format;
        if ($("d-to").value === format) $("d-to").value = Object.keys(DATA_FORMATS).find((k) => k !== format);
        $("d-from").dispatchEvent(new Event("change"));
      },
    },
    encode: {
      tab: "encode",
      open: async (f) => {
        $("e-in").value = (await readText(f)).text;
        $("e-in").dispatchEvent(new Event("input"));
      },
    },
  };

  // ---------- 本体 ----------
  const extOf = (name) => (name.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
  const message = $("x-msg");
  let run = 0;

  // どのツールに渡すかを決める。渡せないときは、その理由を返す
  async function choose(file) {
    const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    // 画像の拡張子(.tga .psd .raw .ai など、中身では分かりにくいものを含む)は、画像ツールへ。読めない形式なら、画像ツールが理由を表示する
    if (ImageIn.isImageExt(extOf(file.name))) return { tool: TOOLS.image };
    // 音声の拡張子(.wma .ape .mid .mod など、中身では分かりにくいものを含む)は、音声ツールへ。読めない形式なら、音声ツールが理由を表示する
    if (AudioIn.isAudioExt(extOf(file.name))) return { tool: TOOLS.audio };
    const found = SIGNATURES.find((s) => s.test(head));
    if (found) {
      return found.kind === "other" ? { reason: `${found.label}は、このページでは変換できません` } : { tool: TOOLS[found.kind] };
    }
    if (ImageIn.canSniff(head)) return { tool: TOOLS.image };
    if (!looksLikeText(head)) return { reason: "種類を判別できないファイルです" };
    if (file.size > TEXT_LIMIT) return { reason: "テキストファイルが大きすぎます(5 MB まで)" };

    const kind = classifyText((await readText(file)).text);
    if (DATA_FORMATS[kind]) return { tool: TOOLS.data, kind };
    if (kind === "svg") return { tool: TOOLS.image, kind };
    if (file.size > ENCODE_LIMIT) return { reason: "テキストファイルが大きすぎます(1 MB まで)" };
    return { tool: TOOLS.encode };
  }

  // 渡せるツールがなかったときは、前のファイルのツールを出したままにしない
  function fail(text) {
    message.textContent = text;
    for (const t of Object.values(TOOLS)) $("tab-" + t.tab).hidden = true;
  }

  async function route(file) {
    const id = ++run;
    message.textContent = "";
    if (file.size === 0) return fail("空のファイルです");
    const { tool, kind, reason } = await choose(file);
    if (id !== run) return;
    if (!tool) return fail(reason);
    // プルダウンは「自動選択」のまま、判定したツールだけをドロップエリアの下に出す
    for (const t of Object.values(TOOLS)) {
      $("tab-" + t.tab).hidden = t !== tool;
      // 上のドロップエリアがあるので、ツール側のドロップエリアは隠す(重複して見えないように)
      $("tab-" + t.tab).classList.toggle("auto", t === tool);
    }
    await tool.open(file, kind);
  }

  $("x-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) route(file);
  });

  // プルダウンで別の種類を選んだら(「自動選択」に戻したときも)、前のファイルの表示は消す
  $("tab-select").addEventListener("change", () => {
    run++;
    message.textContent = "";
    for (const t of Object.values(TOOLS)) $("tab-" + t.tab).classList.remove("auto");
    $("x-file").value = "";
    $("x-file").closest(".dropzone").querySelector(".dz-file").textContent = "";
  });
})();
