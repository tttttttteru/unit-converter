// ファイル変換ページのツール: データ形式 / エンコード / 画像 / 音声 / PDF→Word。
(() => {
  const { $, LIBS, loadScript, setDownload, saveText, bindCopy, formatSize, baseName } = Tools;

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
    dIn.value = await file.text();
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
  const iFmt = $("i-fmt");
  const iQ = $("i-q");
  let iRun = 0;

  async function convertImage() {
    const file = iFile.files[0];
    $("i-qwrap").hidden = iFmt.value === "image/png";
    $("i-qv").textContent = iQ.value;
    if (!file) return;
    const run = ++iRun;
    const err = $("i-err");
    err.textContent = "";
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      if (!canvas.width || !canvas.height) throw new Error("size");
      const ctx = canvas.getContext("2d");
      if (iFmt.value === "image/jpeg") {
        // JPEG は透明を持てないので、白で塗りつぶしてから描く
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(img, 0, 0);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, iFmt.value, iQ.value / 100));
      if (run !== iRun) return;
      if (!blob) throw new Error("encode");
      const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[blob.type] ?? "png";
      setDownload($("i-dl"), blob, baseName(file) + "." + ext);
      $("i-prev").src = $("i-dl").href;
      $("i-prev").hidden = false;
      let info = `${canvas.width} × ${canvas.height} px / ${formatSize(file.size)} → ${formatSize(blob.size)}`;
      if (blob.type !== iFmt.value) info += `(このブラウザは選んだ形式で書き出せないため、${ext.toUpperCase()} になりました)`;
      $("i-info").textContent = info;
    } catch {
      if (run !== iRun) return;
      err.textContent = "この画像は変換できません。画像として読み込めない形式かもしれません";
      $("i-dl").hidden = true;
      $("i-prev").hidden = true;
      $("i-info").textContent = "";
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  iFile.addEventListener("change", convertImage);
  iFmt.addEventListener("change", convertImage);
  iQ.addEventListener("input", convertImage);
  $("i-qwrap").hidden = iFmt.value === "image/png";

  // ---------- 音声 ----------
  const aFile = $("a-file");
  const aFmt = $("a-fmt");

  function toInt16(float) {
    const out = new Int16Array(float.length);
    for (let i = 0; i < float.length; i++) {
      const s = Math.max(-1, Math.min(1, float[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function encodeWav(buffer) {
    const channels = buffer.numberOfChannels;
    const frames = buffer.length;
    const size = 44 + frames * channels * 2;
    const view = new DataView(new ArrayBuffer(size));
    const text = (offset, s) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
    text(0, "RIFF");
    view.setUint32(4, size - 8, true);
    text(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, frames * channels * 2, true);
    const data = Array.from({ length: channels }, (_, c) => toInt16(buffer.getChannelData(c)));
    let offset = 44;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) {
        view.setInt16(offset, data[c][i], true);
        offset += 2;
      }
    }
    return new Blob([view], { type: "audio/wav" });
  }

  async function encodeMp3(buffer, kbps, onProgress) {
    await loadScript(LIBS.lame);
    const stereo = buffer.numberOfChannels > 1;
    const encoder = new lamejs.Mp3Encoder(stereo ? 2 : 1, buffer.sampleRate, kbps);
    const left = toInt16(buffer.getChannelData(0));
    const right = stereo ? toInt16(buffer.getChannelData(1)) : null;
    const parts = [];
    const block = 1152 * 20;
    for (let i = 0; i < left.length; i += block) {
      const l = left.subarray(i, i + block);
      const chunk = right ? encoder.encodeBuffer(l, right.subarray(i, i + block)) : encoder.encodeBuffer(l);
      if (chunk.length) parts.push(chunk);
      if ((i / block) % 20 === 0) {
        onProgress(i / left.length);
        await new Promise((resolve) => setTimeout(resolve));
      }
    }
    const rest = encoder.flush();
    if (rest.length) parts.push(rest);
    return new Blob(parts, { type: "audio/mpeg" });
  }

  async function convertAudio() {
    const file = aFile.files[0];
    const err = $("a-err");
    const info = $("a-info");
    err.textContent = "";
    $("a-dl").hidden = true;
    if (!file) {
      err.textContent = "ファイルを選んでください";
      return;
    }
    $("a-go").disabled = true;
    try {
      info.textContent = "読み込み中…";
      const context = new (window.AudioContext || window.webkitAudioContext)();
      let buffer;
      try {
        buffer = await context.decodeAudioData(await file.arrayBuffer());
      } catch {
        throw new Error("このファイルは読み込めません。ブラウザが対応していない形式かもしれません");
      } finally {
        context.close();
      }
      let blob;
      if (aFmt.value === "wav") {
        info.textContent = "WAV に変換中…";
        blob = encodeWav(buffer);
      } else {
        blob = await encodeMp3(buffer, Number($("a-bitrate").value), (p) => {
          info.textContent = `MP3 に変換中… ${Math.round(p * 100)}%`;
        });
      }
      setDownload($("a-dl"), blob, baseName(file) + "." + aFmt.value);
      info.textContent = `完了: ${buffer.duration.toFixed(1)} 秒 / ${formatSize(file.size)} → ${formatSize(blob.size)}`;
    } catch (e) {
      info.textContent = "";
      err.textContent = "変換できません: " + e.message;
    } finally {
      $("a-go").disabled = false;
    }
  }

  const syncAudioUi = () => ($("a-bwrap").hidden = aFmt.value === "wav");
  aFmt.addEventListener("change", syncAudioUi);
  $("a-go").addEventListener("click", convertAudio);
  syncAudioUi();

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
