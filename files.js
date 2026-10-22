// ファイル変換ページのツール: データ形式 / エンコード / 画像 / 音声 / PDF→Word。
(() => {
  const { $, setDownload, saveText, bindCopy, formatSize, baseName, readText, LIBS, loadScript } = Tools;

  // ---------- データ形式 (JSON / YAML / CSV / XML) ----------
  let autoType = true;

  // CSV や XML の値は文字列として読まれるので、数値・真偽値らしいものは型を直す
  function coerce(s) {
    if (!autoType) return s;
    if (s === "true") return true;
    if (s === "false") return false;
    if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(s) && s.length <= 15 && String(Number(s)) === s) return Number(s);
    return s;
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    text = text.replace(/^﻿/, "");
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            quoted = false;
          }
        } else {
          field += c;
        }
      } else if (c === '"') {
        quoted = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += c;
      }
    }
    if (quoted) throw new Error('CSV の引用符 (") が閉じていません');
    if (field !== "" || row.length) {
      row.push(field);
      rows.push(row);
    }
    const table = rows.filter((r) => !(r.length === 1 && r[0] === ""));
    if (!table.length) return [];
    const header = table[0].map((h, i) => h || "列" + (i + 1));
    return table.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, coerce(r[i] ?? "")])));
  }

  function dumpCsv(data) {
    // {"root": {"row": [...]}} のような包みは外して、行の配列を取り出す
    let d = data;
    while (d && typeof d === "object" && !Array.isArray(d)) {
      const keys = Object.keys(d);
      if (keys.length === 1 && d[keys[0]] !== null && typeof d[keys[0]] === "object") d = d[keys[0]];
      else break;
    }
    const rows = (Array.isArray(d) ? d : [d]).map((r) =>
      r !== null && typeof r === "object" && !Array.isArray(r) ? r : { value: r }
    );
    const header = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const cell = (v) => {
      const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
      return /[",\r\n]|^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [header, ...rows.map((r) => header.map((h) => r[h]))].map((r) => r.map(cell).join(",")).join("\n") + "\n";
  }

  function elementToObject(el) {
    const out = {};
    for (const a of el.attributes) out["@" + a.name] = a.value;
    const kids = [...el.children];
    const text = [...el.childNodes]
      .filter((n) => n.nodeType === 3 || n.nodeType === 4)
      .map((n) => n.nodeValue)
      .join("")
      .trim();
    if (!kids.length && !el.attributes.length) return coerce(text);
    for (const kid of kids) {
      const value = elementToObject(kid);
      const key = kid.tagName;
      if (key in out) {
        if (!Array.isArray(out[key])) out[key] = [out[key]];
        out[key].push(value);
      } else {
        out[key] = value;
      }
    }
    if (text) out["#text"] = coerce(text);
    return out;
  }

  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const problem = doc.querySelector("parsererror");
    if (problem) {
      // ブラウザが返す英語の定型文のうち、場所と原因の部分だけを見せる
      const detail = problem.textContent.replace(/^[^:]*errors?:/, "").split("Below is a rendering")[0].trim();
      throw new Error("XML を解釈できません(" + detail + ")");
    }
    return { [doc.documentElement.tagName]: elementToObject(doc.documentElement) };
  }

  const xmlText = (s, attr) => {
    const t = String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return attr ? t.replace(/"/g, "&quot;") : t;
  };

  // XML のタグ名に使えない文字は _ にする
  const xmlName = (s) => {
    const t = String(s).replace(/[^\p{L}\p{N}_.-]/gu, "_");
    return /^[\p{L}_]/u.test(t) ? t : "_" + t;
  };

  function xmlNode(name, value, depth) {
    const pad = "  ".repeat(depth);
    if (Array.isArray(value)) return value.map((v) => xmlNode(name, v, depth)).filter(Boolean).join("\n");
    if (value === null || value === undefined) return `${pad}<${name}/>`;
    if (typeof value !== "object") return `${pad}<${name}>${xmlText(value)}</${name}>`;
    let attrs = "";
    let text = "";
    const kids = [];
    for (const [k, v] of Object.entries(value)) {
      if (k[0] === "@") attrs += ` ${xmlName(k.slice(1))}="${xmlText(v, true)}"`;
      else if (k === "#text") text = xmlText(v);
      else kids.push(xmlNode(xmlName(k), v, depth + 1));
    }
    const inner = kids.filter(Boolean);
    if (!inner.length) return text ? `${pad}<${name}${attrs}>${text}</${name}>` : `${pad}<${name}${attrs}/>`;
    return `${pad}<${name}${attrs}>${text}\n${inner.join("\n")}\n${pad}</${name}>`;
  }

  function dumpXml(data) {
    let root = "root";
    let body = data;
    if (data !== null && typeof data === "object" && !Array.isArray(data) && Object.keys(data).length === 1) {
      root = xmlName(Object.keys(data)[0]);
      body = data[Object.keys(data)[0]];
    }
    if (Array.isArray(body)) body = { item: body };
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + xmlNode(root, body, 0) + "\n";
  }

  const FORMATS = {
    json: { ext: "json", type: "application/json", parse: (t) => JSON.parse(t), dump: (v) => JSON.stringify(v, null, 2) + "\n" },
    yaml: { ext: "yaml", type: "text/yaml", parse: (t) => jsyaml.load(t), dump: (v) => jsyaml.dump(v, { lineWidth: -1 }) },
    csv: { ext: "csv", type: "text/csv", parse: parseCsv, dump: dumpCsv },
    xml: { ext: "xml", type: "application/xml", parse: parseXml, dump: dumpXml },
  };

  const dFrom = $("d-from");
  const dTo = $("d-to");
  const dIn = $("d-in");
  const dOut = $("d-out");
  const dErr = $("d-err");
  let dRun = 0;

  async function convertData() {
    const run = ++dRun;
    const from = dFrom.value;
    const to = dTo.value;
    const text = dIn.value;
    let result = "";
    let error = "";
    if (text.trim()) {
      try {
        if (from === "yaml" || to === "yaml") await loadScript(LIBS.yaml);
        autoType = $("d-auto").checked;
        result = FORMATS[to].dump(FORMATS[from].parse(text));
      } catch (e) {
        error = "変換できません: " + e.message;
      }
    }
    if (run !== dRun) return;
    dOut.value = result;
    dErr.textContent = error;
  }

  dIn.value = '[\n  { "name": "田中", "age": 30 },\n  { "name": "鈴木", "age": 25 }\n]';
  let dTimer;
  dIn.addEventListener("input", () => {
    clearTimeout(dTimer);
    dTimer = setTimeout(convertData, 200);
  });
  for (const el of [dFrom, dTo, $("d-auto")]) el.addEventListener("change", convertData);
  $("d-swap").addEventListener("click", () => {
    [dFrom.value, dTo.value] = [dTo.value, dFrom.value];
    if (dOut.value) dIn.value = dOut.value;
    convertData();
  });
  // ファイルを読み込んだら入力欄に入れ、拡張子から変換元の形式を選ぶ
  const MAX_TEXT_BYTES = 5 * 1024 * 1024;
  $("d-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > MAX_TEXT_BYTES) {
      dErr.textContent = "ファイルが大きすぎます(5 MB まで)";
      return;
    }
    dIn.value = (await readText(file)).text;
    const ext = file.name.split(".").pop().toLowerCase();
    const format = { json: "json", yaml: "yaml", yml: "yaml", csv: "csv", xml: "xml" }[ext];
    if (format) {
      dFrom.value = format;
      if (dTo.value === format) dTo.value = Object.keys(FORMATS).find((f) => f !== format);
    }
    convertData();
  });
  bindCopy($("d-copy"), () => dOut.value);
  $("d-save").addEventListener("click", () => {
    if (dOut.value) saveText(dOut.value, "converted." + FORMATS[dTo.value].ext, FORMATS[dTo.value].type);
  });
  convertData();

  // ---------- エンコード ----------
  const utf8Bytes = (s) => new TextEncoder().encode(s);
  const utf8Text = (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

  const CODECS = {
    base64: {
      enc: (s) => btoa(Array.from(utf8Bytes(s), (b) => String.fromCharCode(b)).join("")),
      dec: (s) => {
        const normalized = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
        return utf8Text(Uint8Array.from(atob(normalized), (c) => c.charCodeAt(0)));
      },
    },
    url: { enc: encodeURIComponent, dec: decodeURIComponent },
    hex: {
      enc: (s) => Array.from(utf8Bytes(s), (b) => b.toString(16).padStart(2, "0")).join(" "),
      dec: (s) => {
        const hex = s.replace(/0x|[\s,]/gi, "");
        if (!/^([0-9a-f]{2})*$/i.test(hex)) throw new Error("16進数の文字列として読めません");
        return utf8Text(Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16)));
      },
    },
    html: {
      enc: (s) =>
        s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
      dec: (s) => {
        const box = document.createElement("textarea");
        box.innerHTML = s;
        return box.value;
      },
    },
    unicode: {
      enc: (s) => s.replace(/[^\x20-\x7e\n]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")),
      dec: (s) =>
        s.replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/g, (_, long, short) =>
          String.fromCodePoint(parseInt(long ?? short, 16))
        ),
    },
  };

  const eIn = $("e-in");
  const eOut = $("e-out");
  const eCodec = $("e-codec");
  const eDir = $("e-dir");

  function convertEncoding() {
    try {
      eOut.value = CODECS[eCodec.value][eDir.value](eIn.value);
      $("e-err").textContent = "";
    } catch (e) {
      eOut.value = "";
      // ブラウザの英語のエラー文は見せず、こちらで用意した日本語の文だけ見せる
      const known = /[぀-ヿ一-鿿]/.test(e.message);
      $("e-err").textContent = "変換できません: " + (known ? e.message : "この方式では読めない文字列です");
    }
  }

  eIn.addEventListener("input", convertEncoding);
  eCodec.addEventListener("change", convertEncoding);
  eDir.addEventListener("change", convertEncoding);
  $("e-swap").addEventListener("click", () => {
    eDir.value = eDir.value === "enc" ? "dec" : "enc";
    if (eOut.value) eIn.value = eOut.value;
    convertEncoding();
  });
  bindCopy($("e-copy"), () => eOut.value);
  convertEncoding();

  // ---------- 画像 ----------
  const iFile = $("i-file");
  const iQ = $("i-q");
  let iFormat = ImageOut.FORMATS.find((f) => f.id === "jpeg");
  let iExt = "jpg";
  let iDecoded = null; // 読み込んだ画像(形式や画質を変えるたびに、読み直さない)
  let iRun = 0;
  let iPreviewUrl = null;

  iFile.accept = ImageIn.accept;

  const frame = () => new Promise((resolve) => setTimeout(resolve, 30));
  const hasJapanese = (s) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(s);

  function syncQuality() {
    $("i-qwrap").hidden = !iFormat.quality;
    $("i-qv").textContent = iQ.value;
  }

  // ブラウザがそのまま表示できる形式なら変換後を、そうでなければ読み込んだ画像を、プレビューにする
  const DISPLAYABLE = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/avif", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon"];

  function showPreview(url, owned) {
    if (iPreviewUrl) URL.revokeObjectURL(iPreviewUrl);
    iPreviewUrl = owned ? url : null;
    $("i-prev").src = url;
    $("i-prev").hidden = false;
  }

  async function convertImage() {
    const file = iFile.files[0];
    syncQuality();
    if (!file) return;
    const run = ++iRun;
    const err = $("i-err");
    err.textContent = "";
    $("i-note").textContent = "";
    $("i-info").textContent = "変換中…";
    try {
      if (iDecoded?.file !== file) {
        if (iDecoded?.source) URL.revokeObjectURL(iDecoded.source);
        iDecoded = { file, result: await ImageIn.decode(file), source: null };
      }
      if (run !== iRun) return;
      const { canvas, notes } = iDecoded.result;
      await frame(); // AVIF などの重い変換の前に、「変換中…」を画面に出す
      const blob = await ImageOut.encode(iFormat, canvas, { quality: Number(iQ.value), ext: iExt });
      if (run !== iRun) return;

      // WebP などを書き出せないブラウザでは、PNG になってしまう
      let ext = iExt;
      let mismatch = "";
      if (iFormat.id === "webp" && blob.type !== "image/webp") {
        ext = "png";
        mismatch = "(このブラウザは WebP を書き出せないため、PNG になりました)";
      }
      setDownload($("i-dl"), blob, baseName(file) + "." + ext);

      const displayable = DISPLAYABLE.includes(blob.type);
      if (displayable) {
        showPreview(URL.createObjectURL(blob), true);
      } else {
        iDecoded.source ??= URL.createObjectURL(await new Promise((resolve) => canvas.toBlob(resolve, "image/png")));
        showPreview(iDecoded.source, false);
      }
      $("i-info").textContent = `${canvas.width} × ${canvas.height} px / ${formatSize(file.size)} → ${formatSize(blob.size)}${mismatch}`;
      $("i-note").textContent = [...notes, iFormat.note, displayable ? "" : "プレビューは、変換前の画像を表示しています"].filter(Boolean).join(" / ");
    } catch (e) {
      if (run !== iRun) return;
      if (!(e instanceof ImageIn.UserError)) console.error(e); // 利用者向けの案内は、画面に出すだけでよい
      err.textContent = e instanceof ImageIn.UserError || hasJapanese(e.message) ? e.message : "変換できませんでした。壊れたファイルか、対応していない形式かもしれません";
      $("i-dl").hidden = true;
      $("i-prev").hidden = true;
      $("i-info").textContent = "";
    }
  }

  // 変換先の形式(拡張子などで検索できるプルダウン)
  const iCombo = Tools.createCombo({
    input: $("i-fmt"),
    list: $("i-fmt-list"),
    search: ImageOut.search,
    whyNot: ImageOut.whyNot,
    label: ({ format, ext }) => `${format.label} (.${ext})`,
    hint: ({ format }) => format.exts.map((e) => "." + e).join(" "),
    onSelect: ({ format, ext }) => {
      iFormat = format;
      iExt = ext;
      if (format.defaultQuality) iQ.value = format.defaultQuality;
      convertImage();
    },
  });
  iCombo.set({ format: iFormat, ext: iExt });

  // 読み込める・書き出せる形式の一覧(開いて確認できる)
  (() => {
    const group = (title, exts) => (exts.length ? `<p><strong>${title}</strong><br>${exts.map((e) => "." + e).join(" ")}</p>` : "");
    const kinds = { full: [], browser: [], preview: [], none: [] };
    for (const ext of ImageIn.extensions) kinds[ImageIn.kindOf(ext)].push(ext);
    const outputs = ImageOut.FORMATS.flatMap((f) => f.exts);
    $("i-formats").innerHTML =
      group("読み込める形式", kinds.full) +
      group("お使いのブラウザによって読める形式(Safari など)", kinds.browser) +
      group("中のプレビュー画像だけ取り出せる形式(RAW 写真・お絵かきソフトのファイルなど)", kinds.preview) +
      group("読み込めない形式", kinds.none) +
      group("変換先にできる形式", outputs);
  })();

  let iTimer;
  iFile.addEventListener("change", convertImage);
  iQ.addEventListener("input", () => {
    syncQuality();
    clearTimeout(iTimer);
    iTimer = setTimeout(convertImage, 250);
  });
  syncQuality();

  // ---------- 音声 ----------
  const aFile = $("a-file");
  let aFormat = AudioOut.FORMATS.find((f) => f.id === "mp3");
  let aExt = "mp3";
  let aDecoded = null; // 読み込んだ音(形式を変えるたびに、読み直さない)
  let aRunning = false;

  aFile.accept = AudioIn.accept;

  const extOf = (name) => (name.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
  const hasJapaneseText = (s) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(s);
  const clock = (seconds) => {
    const s = Math.round(seconds);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  // 形式に合わせて、音質・ビット深度の選択肢を作り直す
  function syncAudioOptions() {
    const rate = $("a-bitrate");
    $("a-bwrap").hidden = !aFormat.bitrates;
    if (aFormat.bitrates) {
      rate.replaceChildren(...aFormat.bitrates.map((k) => new Option(`${k} kbps`, k)));
      rate.value = aFormat.defaultBitrate;
    }
    const bits = $("a-bits");
    $("a-bitswrap").hidden = !aFormat.bits;
    if (aFormat.bits) {
      bits.replaceChildren(...aFormat.bits.map(([v, label]) => new Option(label, v)));
      bits.value = aFormat.defaultBits;
    }
    $("a-fmt-note").textContent = aFormat.note ?? "";
  }

  // 拡張子が生データ(ヘッダーなし)のときだけ、サンプルレートなどの指定欄を出す
  function syncRawSettings() {
    const file = aFile.files[0];
    const raw = file && AudioIn.isRaw(extOf(file.name));
    $("a-rawbox").hidden = !raw;
    if (raw) {
      const d = AudioIn.rawDefaults(extOf(file.name));
      $("a-rawenc").value = d.encoding;
      $("a-rawrate").value = d.rate;
      $("a-rawch").value = d.channels;
      $("a-adv").open = true;
    }
  }

  const rawSettings = () => ($("a-rawbox").hidden ? undefined : { encoding: $("a-rawenc").value, rate: Number($("a-rawrate").value), channels: Number($("a-rawch").value) });

  async function convertAudio() {
    const file = aFile.files[0];
    const err = $("a-err");
    const info = $("a-info");
    err.textContent = "";
    $("a-note").textContent = "";
    $("a-dl").hidden = true;
    $("a-prev").hidden = true;
    if (!file) {
      err.textContent = "ファイルを選んでください";
      return;
    }
    if (aRunning) return;
    aRunning = true;
    $("a-go").disabled = true;
    try {
      info.textContent = "読み込み中…";
      const raw = rawSettings();
      const key = JSON.stringify(raw ?? null);
      if (aDecoded?.file !== file || aDecoded.key !== key) {
        aDecoded = null;
        aDecoded = { file, key, pcm: await AudioIn.decode(file, { raw, onStatus: (t) => (info.textContent = t) }) };
      }
      const pcm = aDecoded.pcm;
      const result = await AudioOut.encode(
        aFormat,
        pcm,
        {
          ext: aExt,
          bitrate: aFormat.bitrates ? Number($("a-bitrate").value) : undefined,
          bits: aFormat.bits ? $("a-bits").value : undefined,
          rate: Number($("a-rate").value) || undefined,
          channels: Number($("a-ch").value) || undefined,
        },
        {
          onStatus: (t) => (info.textContent = t),
          onProgress: (p) => (info.textContent = `変換中… ${Math.min(100, Math.round(p * 100))}%`),
        }
      );
      setDownload($("a-dl"), result.blob, baseName(file) + "." + aExt);
      info.textContent = `${clock(pcm.duration)} / ${result.rate.toLocaleString("ja-JP")} Hz / ${result.channels === 1 ? "モノラル" : result.channels === 2 ? "ステレオ" : result.channels + " ch"}  ${formatSize(file.size)} → ${formatSize(result.blob.size)}`;
      $("a-note").textContent = [...pcm.notes, ...result.notes, aFormat.note].filter(Boolean).join(" / ");
      // ブラウザで再生できるなら、聞いて確かめられるようにする
      const player = $("a-prev");
      if (player.canPlayType(result.blob.type)) {
        if (player.dataset.url) URL.revokeObjectURL(player.dataset.url);
        player.dataset.url = URL.createObjectURL(result.blob);
        player.src = player.dataset.url;
        player.hidden = false;
      }
    } catch (e) {
      console.error(e);
      info.textContent = "";
      const known = e instanceof AudioIn.UserError || hasJapaneseText(e.message);
      err.textContent = "変換できません: " + (known ? e.message : "壊れたファイルか、対応していない形式かもしれません");
    } finally {
      aRunning = false;
      $("a-go").disabled = false;
    }
  }

  // 変換先の形式(拡張子などで検索できるプルダウン)
  const aCombo = Tools.createCombo({
    input: $("a-fmt"),
    list: $("a-fmt-list"),
    search: AudioOut.search,
    whyNot: AudioOut.whyNot,
    label: ({ format, ext }) => `${format.label} (.${ext})`,
    hint: ({ format }) => format.exts.map((e) => "." + e).join(" "),
    onSelect: ({ format, ext }) => {
      aFormat = format;
      aExt = ext;
      syncAudioOptions();
    },
  });
  aCombo.set({ format: aFormat, ext: aExt });
  syncAudioOptions();

  // 読み込める・書き出せる形式の一覧(開いて確認できる)
  (() => {
    const group = (title, exts) => (exts.length ? `<p><strong>${title}</strong><br>${exts.map((e) => "." + e).join(" ")}</p>` : "");
    const direct = [];
    const video = [];
    const music = [];
    const none = [];
    for (const ext of AudioIn.extensions) {
      const readers = AudioIn.readers[ext];
      if (!readers.length) none.push(ext);
      else if (AudioIn.videoExts.includes(ext)) video.push(ext);
      else if (readers.includes("midi") || readers.includes("tracker") || readers.includes("sid")) music.push(ext);
      else direct.push(ext);
    }
    $("a-formats").innerHTML =
      group("読み込める形式", direct) +
      group("動画ファイル(音声だけを取り出します)", video) +
      group("楽譜・演奏データ(MIDI は簡易音源で、トラッカー音楽・SID は専用プログラムで音にします)", music) +
      group("読み込めない形式", none) +
      group("変換先にできる形式", [...new Set(AudioOut.FORMATS.flatMap((f) => f.exts))]);
  })();

  aFile.addEventListener("change", () => {
    $("a-err").textContent = "";
    syncRawSettings();
  });
  $("a-go").addEventListener("click", convertAudio);

  // ---------- PDF → Word ----------
  const CJK = /[　-鿿＀-￯]/;

  // PDF の文字の断片を、縦位置が近いものどうしでまとめて「行」にする
  function groupLines(items) {
    const lines = [];
    let cur = null;
    for (const item of items) {
      if (!("str" in item)) continue;
      const [, , , d, x, y] = item.transform;
      const h = Math.abs(d) || item.height || 10;
      if (!cur && !item.str) continue;
      if (cur && Math.abs(y - cur.y) <= h * 0.5) {
        const gap = x - cur.end;
        const needSpace =
          gap > h * 0.25 && !CJK.test(cur.text.slice(-1)) && !CJK.test(item.str[0] ?? "") && !/\s$/.test(cur.text) && !/^\s/.test(item.str);
        cur.text += (needSpace ? " " : "") + item.str;
        cur.end = x + item.width;
        cur.h = Math.max(cur.h, h);
      } else {
        if (cur) lines.push(cur);
        cur = { text: item.str, y, end: x + item.width, h };
      }
    }
    if (cur) lines.push(cur);
    return lines.map((l) => ({ ...l, text: l.text.trim() })).filter((l) => l.text);
  }

  // 行の間隔が普通なら同じ段落とみなして、つなげる
  function mergeLines(lines) {
    const paragraphs = [];
    let prev = null;
    for (const line of lines) {
      if (prev && prev.y > line.y && prev.y - line.y <= prev.h * 1.6) {
        const joiner = CJK.test(paragraphs.at(-1).slice(-1)) || CJK.test(line.text[0]) ? "" : " ";
        paragraphs[paragraphs.length - 1] += joiner + line.text;
      } else {
        paragraphs.push(line.text);
      }
      prev = line;
    }
    return paragraphs;
  }

  const wordText = (s) =>
    s
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

  async function buildDocx(pages) {
    await loadScript(LIBS.zip);
    const body = pages
      .flatMap((paragraphs, pageIndex) =>
        paragraphs.map((text, i) => {
          const breakBefore = pageIndex > 0 && i === 0 ? "<w:pPr><w:pageBreakBefore/></w:pPr>" : "";
          return `<w:p>${breakBefore}<w:r><w:t xml:space="preserve">${wordText(text)}</w:t></w:r></w:p>`;
        })
      )
      .join("");
    const zip = new JSZip();
    // フォルダ用の項目は作らない(docx の中身はファイルだけでよい)
    const add = (name, content) => zip.file(name, content, { createFolders: false });
    add(
      "[Content_Types].xml",
      XML_HEAD +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        "</Types>"
    );
    add(
      "_rels/.rels",
      XML_HEAD +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        "</Relationships>"
    );
    add(
      "word/document.xml",
      XML_HEAD +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        body +
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>' +
        "</w:body></w:document>"
    );
    return zip.generateAsync({
      type: "blob",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      compression: "DEFLATE",
    });
  }

  async function convertPdf() {
    const file = $("p-file").files[0];
    const err = $("p-err");
    const info = $("p-info");
    err.textContent = "";
    $("p-dl").hidden = true;
    if (!file) {
      err.textContent = "PDF ファイルを選んでください";
      return;
    }
    $("p-go").disabled = true;
    try {
      info.textContent = "PDF を読み込み中…";
      await loadScript(LIBS.pdf);
      pdfjsLib.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker;
      let pdf;
      try {
        pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      } catch (e) {
        throw new Error(e.name === "PasswordException" ? "パスワード付きの PDF は変換できません" : "PDF として読み込めません");
      }
      const pages = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        info.textContent = `文字を取り出し中… ${n} / ${pdf.numPages} ページ`;
        const content = await (await pdf.getPage(n)).getTextContent();
        const lines = groupLines(content.items);
        pages.push($("p-merge").checked ? mergeLines(lines) : lines.map((l) => l.text));
      }
      const count = pages.reduce((sum, p) => sum + p.length, 0);
      if (!count) throw new Error("文字を取り出せませんでした。スキャンした画像だけの PDF かもしれません");
      info.textContent = "Word ファイルを作成中…";
      const blob = await buildDocx(pages);
      setDownload($("p-dl"), blob, baseName(file) + ".docx");
      info.textContent = `完了: ${pdf.numPages} ページ / ${count} 段落 (${formatSize(blob.size)})`;
    } catch (e) {
      info.textContent = "";
      err.textContent = "変換できません: " + e.message;
    } finally {
      $("p-go").disabled = false;
    }
  }

  $("p-go").addEventListener("click", convertPdf);
})();
