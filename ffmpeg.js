// ffmpeg(WebAssembly 版)を使うための窓口。ffmpeg-worker.js を、使うときに初めて起動する。
// ffmpeg 本体は約 32 MB あるので、ブラウザが標準で扱えない形式のときだけ呼ぶこと。
Tools.ffmpeg = (() => {
  let worker = null;
  let nextId = 1;
  const pending = new Map();
  let loaded = null;

  function start() {
    if (worker) return worker;
    worker = new Worker("ffmpeg-worker.js");
    worker.onmessage = ({ data }) => {
      const job = pending.get(data.id);
      if (!job) return;
      if (data.progress !== undefined) {
        job.onProgress?.(data.progress);
        return;
      }
      pending.delete(data.id);
      if (data.ok) job.resolve(data.result);
      else {
        if (/memory access|unreachable|abort|out of memory/i.test(data.error)) restart();
        job.reject(new Error(data.error));
      }
    };
    worker.onerror = (e) => {
      const error = new Error("ffmpeg を起動できませんでした: " + (e.message || "不明なエラー"));
      for (const job of pending.values()) job.reject(error);
      pending.clear();
      worker = null;
      loaded = null;
      ready = false;
    };
    return worker;
  }

  // ffmpeg の内部で異常が起きると、その後はずっと失敗し続けるので、作り直す
  function restart() {
    worker?.terminate();
    worker = null;
    loaded = null;
    ready = false;
    for (const job of pending.values()) job.reject(new Error("ffmpeg を作り直しました"));
    pending.clear();
  }

  function call(op, payload, transfer = [], onProgress) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject, onProgress });
      start().postMessage({ id, op, payload }, transfer);
    });
  }

  // 初回は約 32 MB を読み込む(2 回目以降は、すぐ終わる)
  let ready = false;
  function load() {
    loaded ??= call("load")
      .then(() => {
        ready = true;
      })
      .catch((e) => {
        loaded = null;
        throw e;
      });
    return loaded;
  }

  // ffmpeg を 1 回実行する。inputs は { ファイル名: Uint8Array }、outputs は読み出したいファイル名の配列
  // 戻り値: { code, files: { ファイル名: Uint8Array }, logs }
  async function run({ args, inputs = {}, outputs = [], onProgress }) {
    await load();
    const transfer = Object.values(inputs).map((data) => data.buffer);
    return call("run", { args, inputs, outputs }, transfer, onProgress);
  }

  return { run, load, restart, isLoaded: () => ready };
})();
