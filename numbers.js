// 日時・進数のツール(単位変換ページ)。
(() => {
  const { $, renderRows } = Tools;

  // ---------- 日時・進数 ----------
  const dateFormat = (opts) => new Intl.DateTimeFormat("ja-JP", opts);

  function showTimestamp() {
    const input = $("n-ts").value.trim();
    const list = $("n-ts-out");
    const err = $("n-ts-err");
    err.textContent = "";
    list.replaceChildren();
    if (!input) return;

    let ms;
    if (/^-?\d+(\.\d+)?$/.test(input)) {
      const n = Number(input);
      ms = Math.abs(n) >= 1e11 ? n : n * 1000;
    } else {
      ms = Date.parse(input);
    }
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) {
      err.textContent = "日時として読めません";
      return;
    }
    renderRows(list, [
      ["UNIX時間 (秒)", String(Math.floor(ms / 1000))],
      ["UNIX時間 (ミリ秒)", String(Math.floor(ms))],
      ["UTC (ISO 8601)", date.toISOString()],
      ["日本時間", dateFormat({ timeZone: "Asia/Tokyo", dateStyle: "long", timeStyle: "medium" }).format(date)],
      ["この端末の時刻", dateFormat({ dateStyle: "long", timeStyle: "long" }).format(date)],
    ]);
  }

  $("n-ts").value = String(Math.floor(Date.now() / 1000));
  $("n-ts").addEventListener("input", showTimestamp);
  $("n-now").addEventListener("click", () => {
    $("n-ts").value = String(Math.floor(Date.now() / 1000));
    showTimestamp();
  });
  showTimestamp();

  // 大きな数も正確に扱うため BigInt を使う
  function parseBig(text, base) {
    let s = text.normalize("NFKC").replace(/[\s_,]/g, "").toLowerCase();
    let negative = false;
    if (s[0] === "-" || s[0] === "+") {
      negative = s[0] === "-";
      s = s.slice(1);
    }
    const prefix = { 2: "0b", 8: "0o", 16: "0x" }[base];
    if (prefix && s.startsWith(prefix)) s = s.slice(prefix.length);
    if (!s) throw new Error("数字がありません");
    let value = 0n;
    for (const ch of s) {
      const digit = parseInt(ch, 36);
      if (Number.isNaN(digit) || digit >= base) throw new Error(`「${ch}」は ${base} 進数には使えない文字です`);
      value = value * BigInt(base) + BigInt(digit);
    }
    return negative ? -value : value;
  }

  function showBases() {
    const text = $("n-num").value;
    const list = $("n-base-out");
    $("n-err").textContent = "";
    list.replaceChildren();
    if (!text.trim()) return;
    try {
      const value = parseBig(text, Number($("n-base").value));
      const sign = value < 0n ? "-" : "";
      const abs = value < 0n ? -value : value;
      renderRows(
        list,
        [2, 8, 10, 16, 36].map((b) => {
          let digits = abs.toString(b);
          if (b === 2) digits = digits.replace(/\B(?=(.{4})+$)/g, " ");
          return [b + "進数", sign + (b > 10 ? digits.toUpperCase() : digits)];
        })
      );
    } catch (e) {
      $("n-err").textContent = e.message;
    }
  }

  $("n-num").addEventListener("input", showBases);
  $("n-base").addEventListener("change", showBases);
  showBases();
})();
