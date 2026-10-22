// 動作確認用の、本物のサンプルファイルを `.samples/` にダウンロードする(リポジトリには入れない)。
//   npm run samples          … ダウンロード
//   npm run samples:serve    … http://localhost:8124/ で配信(CORS あり)。ブラウザのページから fetch して試す
// 入手元は、他のソフトが作った・独立して検証されたファイルなので、自分で書いたコードの答え合わせに使える。
//   画像 … Pillow のテスト画像 (同じ元画像 hopper を、各形式で保存したものが多い)
//   音声 … FFmpeg の FATE サンプル集 (同じ曲を各形式で保存したものがある)
//   トラッカー音楽 … libxmp のテストデータ
import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../.samples/", import.meta.url));

const SOURCES = [
  {
    base: "https://raw.githubusercontent.com/python-pillow/Pillow/main/Tests/images/",
    dir: "images",
    files: [
      "hopper.ppm", "hopper_8bit.ppm", "hopper.pnm", "hopper.dcx", "hopper.ras", "hopper.rgb", "hopper.sgi", "hopper.bw",
      "hopper.qoi", "hopper.psd", "hopper.dds", "hopper.tif", "hopper_lzw.tif", "hopper_jpg.tif", "hopper_g4.tif",
      "hopper.xpm", "hopper.xbm", "hopper_1bit.pbm", "hopper_16bit.pgm", "hopper.pfm", "hopper.ico", "hopper_256x256.ico",
      "hopper_rle8.bmp", "clipboard.dib", "pillow.icns", "gbr.gbr", "odd_stride.pcx", "pil184.pcx", "transparent.sgi",
      "tga/common/200x32_rgb_tl_rle.tga", "tga/common/200x32_rgb.png", "tga/common/200x32_p_bl_raw.tga", "tga/common/200x32_p.png",
      "dxt1-rgb-4bbp-noalpha_MipMaps-1.dds", "dxt1-rgb-4bbp-noalpha_MipMaps-1.png",
      "dxt5-argb-8bbp-interpolatedalpha_MipMaps-1.dds", "dxt5-argb-8bbp-interpolatedalpha_MipMaps-1.png",
      "eps/binary_preview_map.eps", "avif/hopper.heif", "avif/hopper.avif",
    ],
  },
  {
    base: "https://fate-suite.ffmpeg.org/",
    dir: "audio",
    files: [
      "audio-reference/luckynight_2ch_44kHz_s16.wav", "audio-reference/chorusnoise_2ch_44kHz_s16.wav",
      "lossless-audio/luckynight-partial.ape", "lossless-audio/luckynight-partial.shn", "lossless-audio/luckynight-partial.tak",
      "lossless-audio/luckynight-partial.tta", "lossless-audio/luckynight-partial.wv", "lossless-audio/luckynight-partial.mlp",
      "lossless-audio/luckynight-partial.wma", "lossless-audio/inside.m4a",
      "musepack/inside-mp7.mpc", "musepack/inside-mp7.pcm", "creative/BBC_4BIT.VOC", "iff/8svx_fib.iff", "caf/caf-pcm16.caf",
      "w64/w64-pcm16.w64", "nistsphere/nist-ulaw.nist", "qcp/evrc.qcp", "qcp/evrc.pcm", "real/ra_cook.rm", "real/ra_cook.pcm",
      "oma/01-Untitled-partial.oma", "atrac3p/sonateno14op27-2-cut.aa3", "atrac3p/sonateno14op27-2-cut.pcm", "vqf/achterba.vqf",
      "dts/dts_es.dts", "ac3/monsters_inc_2.0_192_small.ac3", "eac3/matrix2_commentary1_stereo_192_small.eac3", "truehd/atmos.thd",
      "amrnb/12.2k.amr", "amrnb/12.2k.pcm", "amrwb/seed-12k65.awb", "amrwb/seed-12k65.pcm", "oki/test.wav", "dss/lp.dss",
      "aa/bush.aa", "ogg-vorbis/tos.ogg", "wmapro/Beethovens_9th-1_small.wma", "wmapro/Beethovens_9th-1_small.pcm", "xwma/ergon.xwma",
    ],
  },
  {
    base: "https://raw.githubusercontent.com/libxmp/libxmp/master/test-dev/",
    dir: "audio/trackers",
    files: [
      "data/m/sundance.mod", "openmpt/xm/TremoloWaveforms.xm", "openmpt/it/swaptest.it", "data/p/data_jack.s3m", "data/m/jimmy.stm",
      "data/m/fall1.mtm", "data/m/sonic_boom.669", "data/m/Jarre-Like.MED", "data/m/silver-song0.psm", "data/m/cybocult.ult",
      "data/far_effects.far", "data/m/Indian_Summer.amf",
    ],
  },
];

let downloaded = 0;
let skipped = 0;
for (const { base, dir, files } of SOURCES) {
  for (const file of files) {
    const target = join(ROOT, dir, file.split("/").pop());
    try {
      await stat(target);
      skipped++;
      continue;
    } catch {}
    const response = await fetch(base + file.split("/").map(encodeURIComponent).join("/"));
    if (!response.ok) {
      console.warn(`取得できませんでした (${response.status}): ${base}${file}`);
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(await response.arrayBuffer()));
    downloaded++;
  }
}
console.log(`完了: ${downloaded} 個をダウンロード、${skipped} 個は取得済み → ${ROOT}`);
