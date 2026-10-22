# 変換ツール

単位の換算と、画像・音声・PDF・データ形式の変換ができる Web ページです。ビルドは不要で、HTML・CSS・JavaScript だけでできています。ファイルは、利用者の端末のブラウザ内だけで処理され、外部には送信されません。

- 公開ページ: https://tttttttteru.github.io/unit-converter/
- 単位変換: `index.html`(単位 15 種類・日時・進数)
- ファイル変換: `files.html`(画像約 170 種類・音声約 150 種類・PDF→Word・JSON/CSV/YAML/XML・エンコード)

## 手元で動かす

[Node.js](https://nodejs.org/) が入っていれば、次のコマンドで動かせます。

```bash
npm start          # http://localhost:8123/ で開く
```

ブラウザで `index.html` を直接開く(`file://`)と、読み込むファイルの関係でうまく動かないので、必ずサーバー経由で開いてください。

## 動作確認用のサンプル

画像・音声の形式を直すときは、他のソフトが作った本物のファイルで答え合わせをします。

```bash
npm run samples         # .samples/ に、約 26 MB をダウンロード
npm run samples:serve   # http://localhost:8124/ で配信(CORS あり)
```

入手元は、Pillow のテスト画像、FFmpeg の FATE サンプル集、libxmp のテストデータです。詳しい確かめ方は `CLAUDE.md` に書いてあります。

## 構成

| ファイル | 役割 |
|---|---|
| `index.html` `units.js` `numbers.js` | 単位変換ページ |
| `files.html` `files.js` | ファイル変換ページ(画像・音声・PDF・データ形式・エンコードの画面) |
| `detect.js` | 「自動選択」: ドロップされたファイルの中身から、合うツールに振り分ける |
| `common.js` `combobox.js` `style.css` | 共通の部品(タブ・ドロップエリア・検索できるプルダウン・見た目) |
| `imagein.js` `imageout.js` | 画像の読み込み(約 170 拡張子)と書き出し(27 形式) |
| `audioin.js` `audioout.js` | 音声の読み込み(約 150 拡張子)と書き出し(30 形式) |
| `ffmpeg.js` `ffmpeg-worker.js` | ffmpeg(WebAssembly 版)を別スレッドで動かす |
| `tools/fetch-samples.mjs` | 動作確認用サンプルのダウンロード |

ブラウザが標準で扱えない形式は、外部の部品(ffmpeg・UTIF・ag-psd・heic2any・libopenmpt・libsidplayfp など)を、必要になったときだけ CDN から読み込みます。

## 公開

`main` ブランチが、GitHub Pages としてそのまま公開されます。`main` に push すると、公開ページが更新されます。作業中の変更は、別のブランチで行ってください。

## ライセンスについて

読み込む外部の部品には、GPL(ffmpeg・libsidplayfp)や LGPL(lamejs)のものが含まれます。商用で運営する場合などは、それぞれの条件を確認してください。
