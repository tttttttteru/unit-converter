// 2つのページで共通の部品(ダウンロード用リンク、コピー、タブ切り替えなど)。
// 重いライブラリは、必要になったときだけ読み込む。
window.Tools = (() => {
  const $ = (id) => document.getElementById(id);

  const LIBS = {
    yaml: "https://cdnjs.cloudflare.com/ajax/libs/js-yaml/4.1.0/js-yaml.min.js",
    lame: "https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js",
    zip: "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
    pdf: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
    pdfWorker: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  };

  const loading = {};
  function loadScript(url) {
    loading[url] ??= new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.onload = resolve;
      script.onerror = () => {
        delete loading[url];
        reject(new Error("必要なライブラリを読み込めませんでした。ネットワーク接続を確認してください"));
      };
      document.head.append(script);
    });
    return loading[url];
  }

  // ダウンロード用リンクに Blob を結びつける(前回の分は解放する)
  function setDownload(link, blob, filename) {
    if (link.dataset.url) URL.revokeObjectURL(link.dataset.url);
    link.dataset.url = URL.createObjectURL(blob);
    link.href = link.dataset.url;
    link.download = filename;
    link.hidden = false;
  }

  function saveText(text, filename, type) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([text], { type }));
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function bindCopy(button, getText) {
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(getText());
        button.textContent = "コピーしました";
      } catch {
        button.textContent = "コピーできませんでした";
      }
      setTimeout(() => (button.textContent = "コピー"), 1500);
    });
  }

  function renderRows(list, rows) {
    list.replaceChildren(
      ...rows.map(([name, value]) => {
        const li = document.createElement("li");
        const left = document.createElement("span");
        const right = document.createElement("span");
        left.className = "name";
        right.className = "num";
        left.textContent = name;
        right.textContent = value;
        li.append(left, right);
        return li;
      })
    );
  }

  const formatSize = (bytes) =>
    bytes >= 1048576 ? (bytes / 1048576).toFixed(2) + " MB" : Math.max(1, Math.round(bytes / 1024)) + " KB";

  const baseName = (file) => file.name.replace(/\.[^.]*$/, "") || "converted";

  // ---------- タブ ----------
  // ページ内の切り替え。タブ(#tabs のボタン)かプルダウン(#tab-select)のどちらでも使える。
  // URL の #名前 で開くものを指定でき、指定がなければ先頭を開く
  const tabButtons = [...document.querySelectorAll("#tabs button")];
  const tabSelect = $("tab-select");
  const tabNames = tabSelect ? [...tabSelect.options].map((o) => o.value) : tabButtons.map((b) => b.dataset.tab);

  function showTab(name) {
    for (const tab of tabNames) $("tab-" + tab).hidden = tab !== name;
    for (const button of tabButtons) {
      button.setAttribute("aria-selected", String(button.dataset.tab === name));
      button.setAttribute("aria-controls", "tab-" + button.dataset.tab);
    }
    if (tabSelect) tabSelect.value = name;
    try {
      history.replaceState(null, "", "#" + name);
    } catch {}
  }

  for (const button of tabButtons) {
    button.addEventListener("click", () => showTab(button.dataset.tab));
  }
  tabSelect?.addEventListener("change", () => showTab(tabSelect.value));
  window.addEventListener("hashchange", () => {
    const name = location.hash.slice(1);
    if (tabNames.includes(name)) showTab(name);
  });
  const hash = location.hash.slice(1);
  showTab(tabNames.includes(hash) ? hash : tabNames[0]);

  // ---------- ドロップエリア ----------
  // <label class="dropzone"> の中のファイル入力に、ドラッグ&ドロップでもファイルを渡せるようにする。
  // 入力の accept に合わないファイルは受け付けず、複数ドロップされたら最初の合うもの 1 つだけ使う
  function bindDropZone(zone) {
    const input = zone.querySelector('input[type="file"]');
    const label = zone.querySelector(".dz-file");
    const accepts = (input.accept || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const accepted = (file) =>
      !accepts.length ||
      accepts.some((a) =>
        a.startsWith(".") ? file.name.toLowerCase().endsWith(a) : a.endsWith("/*") ? file.type.startsWith(a.slice(0, -1)) : file.type === a
      );

    const show = (text, bad) => {
      label.textContent = text;
      label.classList.toggle("bad", Boolean(bad));
    };
    input.addEventListener("change", () => {
      const file = input.files[0];
      show(file ? `${file.name} (${formatSize(file.size)})` : "");
    });

    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("dragover");
    });
    for (const type of ["dragleave", "dragend"]) zone.addEventListener(type, () => zone.classList.remove("dragover"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("dragover");
      const dropped = [...e.dataTransfer.files];
      if (!dropped.length) return;
      const file = dropped.find(accepted);
      if (!file) {
        show("この形式のファイルは使えません", true);
        return;
      }
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      if (dropped.length > 1) label.textContent += "(複数のファイルのうち、最初の 1 つだけを使います)";
    });
  }

  document.querySelectorAll(".dropzone").forEach(bindDropZone);

  // ドロップエリアの外にファイルを落としても、ブラウザがそのファイルを開いてしまわないようにする
  for (const type of ["dragover", "drop"]) {
    window.addEventListener(type, (e) => {
      if (!e.dataTransfer?.types.includes("Files") || e.target.closest?.(".dropzone")) return;
      e.preventDefault();
      if (type === "dragover") e.dataTransfer.dropEffect = "none";
    });
  }

  // テキストファイルを読む。文字コードは BOM → UTF-8 → Shift_JIS の順に当てはめる
  // (日本語の CSV には Shift_JIS のものが多いため)
  async function readText(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const decode = (label, fatal) => new TextDecoder(label, { fatal }).decode(bytes);
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: decode("utf-16le", false), encoding: "UTF-16 LE" };
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: decode("utf-16be", false), encoding: "UTF-16 BE" };
    try {
      return { text: decode("utf-8", true), encoding: "UTF-8" };
    } catch {}
    try {
      return { text: decode("shift_jis", true), encoding: "Shift_JIS" };
    } catch {}
    return { text: decode("utf-8", false), encoding: "不明(UTF-8 として表示)" };
  }

  return { $, LIBS, loadScript, setDownload, saveText, bindCopy, renderRows, formatSize, baseName, showTab, readText };
})();
