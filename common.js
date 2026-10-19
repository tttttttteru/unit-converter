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
  // ページ内のタブ。URL の #名前 で開くタブを指定でき、指定がなければ先頭のタブを開く
  const tabButtons = [...document.querySelectorAll("#tabs button")];
  const tabNames = tabButtons.map((b) => b.dataset.tab);

  function showTab(name) {
    for (const button of tabButtons) {
      const on = button.dataset.tab === name;
      button.setAttribute("aria-selected", String(on));
      button.setAttribute("aria-controls", "tab-" + button.dataset.tab);
      $("tab-" + button.dataset.tab).hidden = !on;
    }
    try {
      history.replaceState(null, "", "#" + name);
    } catch {}
  }

  for (const button of tabButtons) {
    button.addEventListener("click", () => showTab(button.dataset.tab));
  }
  const hash = location.hash.slice(1);
  showTab(tabNames.includes(hash) ? hash : tabNames[0]);

  return { $, LIBS, loadScript, setDownload, saveText, bindCopy, renderRows, formatSize, baseName };
})();
