// ffmpeg(WebAssembly 版)を、画面を止めないよう別スレッドで動かす。
// 変換に必要なときだけ、ページ側 (audioin.js) が起動する。ffmpeg 本体は約 32 MB あるので、CDN から読み込む。
const CORE_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/";

let core = null;
let loading = null;
let logs = [];
let progress = () => {};

function load() {
  loading ??= (async () => {
    importScripts(CORE_BASE + "ffmpeg-core.js");
    // ワーカーの中では、本体 (WASM) を Emscripten に任せて読み込ませると空になることがあるので、こちらで取得して渡す
    const response = await fetch(CORE_BASE + "ffmpeg-core.wasm");
    if (!response.ok) throw new Error("ffmpeg を読み込めませんでした(HTTP " + response.status + ")");
    const wasmBinary = await response.arrayBuffer();
    core = await createFFmpegCore({ wasmBinary, locateFile: (path) => CORE_BASE + path });
    core.setLogger(({ message }) => logs.push(message));
    core.setProgress(({ progress: p }) => progress(p));
  })().catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

// 引数 args で ffmpeg を 1 回実行する。inputs のファイルを置いてから走らせ、outputs のファイルを読み出して返す
async function run({ args, inputs, outputs }) {
  await load();
  logs = [];
  for (const [name, data] of Object.entries(inputs)) core.FS.writeFile(name, data);
  let code;
  try {
    core.setTimeout(-1);
    core.exec(...args);
    code = core.ret;
  } finally {
    core.reset();
  }
  const files = {};
  const transfer = [];
  for (const name of outputs) {
    try {
      const data = core.FS.readFile(name);
      files[name] = data;
      transfer.push(data.buffer);
    } catch {
      // 出力されなかった(失敗した)
    }
    try {
      core.FS.unlink(name);
    } catch {}
  }
  for (const name of Object.keys(inputs)) {
    try {
      core.FS.unlink(name);
    } catch {}
  }
  return { code, files, logs, transfer };
}

self.onmessage = async (event) => {
  const { id, op, payload } = event.data;
  try {
    if (op === "load") {
      await load();
      self.postMessage({ id, ok: true, result: {} });
    } else if (op === "run") {
      progress = (p) => self.postMessage({ id, progress: p });
      const { transfer, ...result } = await run(payload);
      self.postMessage({ id, ok: true, result }, transfer);
    }
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e?.message ?? e) });
  }
};
