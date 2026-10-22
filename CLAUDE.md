# CLAUDE.md

単位変換・ファイル変換の静的サイト。ビルドなし、依存パッケージなし(動作確認用サーバーの `http-server` だけ npx で使う)。利用者とのやり取りは日本語。コードのコメントも日本語で、周りの書き方に合わせる。

## 作業のルール

- **`main` は本番です。** GitHub Pages が `main` から公開しているので、`main` への push は公開になります。利用者が「公開して」と言うまで、`main` に push しない。作業は別ブランチで行い、push は `git push -u origin <ブランチ名>`。
- 公開するときは、push のあとで、公開ページが更新されたことを確かめる(`curl` で新しいファイルを取って、変更箇所が含まれているか見る。反映まで 30〜60 秒かかる)。
- 変更したら、実際にブラウザで動かして確かめる(下の「動作確認」)。動作確認していないものは、「未確認」と正直に伝える。
- 「公開して」の前に、変更の内容(何ができて、何が未検証か)を、利用者に報告する。

## 動かし方

```bash
npm start      # http://localhost:8123/
```

`file://` では動かない(Worker・相対パスのため)。サーバーはバックグラウンドで起動する。ブラウザ確認には、Claude のブラウザペイン(`mcp__Claude_Browser__*`)が使える。ページを再読み込みするときは、`?v=2` のように URL を変えないと、ハッシュだけの変更では再読み込みされない。

## 全体の作り

グローバルの `Tools`(`common.js`)に、共通の部品がある: `$`、`loadScript`、`setDownload`、`bindCopy`、`formatSize`、`readText`(文字コード判別つき)、`showTab`、`createCombo`(`combobox.js`)、`ffmpeg`(`ffmpeg.js`)。

### 形式を増やすときは

- **画像を読む**: `imagein.js` の `READERS`(拡張子 → 試す読み方の並び)に足す。読めない形式は `[]` にして、`REASONS` に理由を書く。自前のデコーダーは `DECODERS` に。
- **画像を書く**: `imageout.js` の `FORMATS` に 1 つ足す(`id`・`label`・`exts`・`encode`)。
- **音声を読む**: `audioin.js` の `READERS` と `REASONS`。生データの初期設定は `RAW_DEFAULTS`。
- **音声を書く**: `audioout.js` の `FORMATS`。`encode` があれば自前、なければ `codec`・`container` を指定して ffmpeg で。
- 「読める拡張子」は、`detect.js` の自動選択の振り分けにも使われる(画像の拡張子 → 音声の拡張子 → 中身の判定、の順)。`.raw` は画像(カメラの RAW)が優先。
- ファイル変換ページの種類のプルダウン(`files.html` の `#tab-select`)と、パネルの `id`(`tab-xxx`)は対応している。

### 外部の部品

重いものは、必要になったときだけ CDN(jsDelivr・cdnjs)から読み込む。バージョンは固定する。一覧は `common.js` の `LIBS` と、`audioin.js` の `LIBS`。ffmpeg(約 32 MB)は `ffmpeg-worker.js` の別スレッドで動かす。

## 落とし穴(経験したこと)

- **ffmpeg の libopus は、ステレオで異常終了する**(この WebAssembly ビルドの不具合)。Opus は、ffmpeg 内蔵の `opus -strict -2` を使っている。異常終了すると、そのワーカーはずっと壊れるので、`ffmpeg.js` が自動で作り直す。
- **ffmpeg に渡す `inputs` の `Uint8Array` は、転送されて空になる。** 渡したあとも使うなら、`.slice()` でコピーを渡す。
- **ワーカーの中では、WASM を Emscripten に取得させると空になる**ので、`fetch` して `wasmBinary` で渡している。
- **UTIF(TIFF)は、未対応の圧縮・色の形式で、エラーを出さずに空白の画像を返す。** `imagein.js` で、対応するものだけを許可している。JPEG 圧縮の TIFF は、色が RGB のままのものを、UTIF が誤って YCbCr 変換するので、パッチしてある。
- **`decodeAudioData` は、サンプルレートを再生用に変換してしまう。** 元のレートを、ファイルの先頭から読み取って、そのレートの `AudioContext` で読ませている(`probeRate`)。
- **ブラウザ標準の読み込みが、エラーにならず間違った結果を返す形式がある**(Matroska 音声)。その拡張子は、ffmpeg を先にしている。
- **タブが隠れると `setTimeout` が 1 秒に 1 回に間引かれる。** 長い処理で画面に処理を返すときは、`MessageChannel` を使う(`audioout.js` の `nextTurn`)。
- **lamejs(ブラウザ内の MP3 エンコーダー)は遅い**(実時間の 2〜7 倍の速さ)。30 秒を超える音声は ffmpeg の libmp3lame を使う。
- Claude のブラウザペインの `javascript_tool` は、45 秒でタイムアウトする。長い確認は、分けて実行する。

## 動作確認のやり方

画像と音声の形式は、**自分で書いたコードの答え合わせを、他のソフトが作ったファイルでする**。

```bash
npm run samples && npm run samples:serve   # http://localhost:8124/
```

ページ(8123)から `fetch('http://localhost:8124/...')` して、`ImageIn.decode(file)` や `AudioIn.decode(file)` に渡す。

- **画像**: Pillow の `hopper.*` は、同じ元画像を各形式で保存したもの。`hopper.ppm` / `hopper_8bit.ppm` と画素を比べる(2 系統の元画像がある)。TGA は、対応する PNG があり、画素まで一致する。
- **音声**: `luckynight-partial.{ape,shn,tak,tta,wv,mlp,wma}` は、同じ曲の別形式のロスレス。`luckynight_2ch_44kHz_s16.wav` と**1 サンプルも違わず**一致するはず。`*.pcm` は ffmpeg の基準出力(AC3・DTS・ATRAC などは、デコーダーの実装による小さな差が出る)。
- **自前の書き出し**: 書き出したファイルを、自前の読み込みと ffmpeg の両方で読み戻して、同じ結果になるか比べる(ffmpeg を「独立した読み手」として使う)。逆に、ffmpeg で書いたファイル(AIFF・AU・CAF・W64 など)を、自前の読み込みで読んで、ffmpeg の読み込みと比べる。
- 誤差の計算を書くときは、配列の長さの取り方に注意(オブジェクトの `.length` は `undefined` で、ループが回らず、誤差が 0 に見えてしまう)。

## 未検証のもの(実ファイルがなく、自作データでの確認にとどまる)

- 画像: 実際のカメラの RAW、Clip Studio・Affinity・Pixelmator などの独自形式、Illustrator の AI、Procreate・Krita・OpenRaster、ANI、MacPaint、HDR の圧縮形式。
- 音声: DSD(DSF・DFF)、生の GSM、XMI・MUS、Audible の暗号化ファイル。
- 読めない形式の一覧は、画面の「対応している形式の一覧」を見る。
