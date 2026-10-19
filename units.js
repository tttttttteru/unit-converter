// 単位の定義。
// factor は「その単位 1 つぶんが、カテゴリの基準単位でいくつか」を表す。
// 例: 長さの基準はメートルなので、km の factor は 1000。
// 単位を増やしたいときは、ここに 1 行足すだけでよい。
const CATEGORIES = [
  {
    name: "長さ",
    default: "cm",
    units: [
      { id: "nm", label: "ナノメートル (nm)", factor: 1e-9 },
      { id: "um", label: "マイクロメートル (μm)", factor: 1e-6 },
      { id: "mm", label: "ミリメートル (mm)", factor: 1e-3 },
      { id: "cm", label: "センチメートル (cm)", factor: 1e-2 },
      { id: "m", label: "メートル (m)", factor: 1 },
      { id: "km", label: "キロメートル (km)", factor: 1e3 },
      { id: "in", label: "インチ (in)", factor: 0.0254 },
      { id: "ft", label: "フィート (ft)", factor: 0.3048 },
      { id: "yd", label: "ヤード (yd)", factor: 0.9144 },
      { id: "mi", label: "マイル (mi)", factor: 1609.344 },
      { id: "nmi", label: "海里", factor: 1852 },
      { id: "sun", label: "寸", factor: 1 / 33 },
      { id: "shaku", label: "尺", factor: 10 / 33 },
      { id: "ken", label: "間", factor: 60 / 33 },
      { id: "ri", label: "里", factor: 12960 / 33 },
    ],
  },
  {
    name: "重さ",
    default: "kg",
    units: [
      { id: "mg", label: "ミリグラム (mg)", factor: 1e-6 },
      { id: "g", label: "グラム (g)", factor: 1e-3 },
      { id: "kg", label: "キログラム (kg)", factor: 1 },
      { id: "t", label: "トン (t)", factor: 1e3 },
      { id: "oz", label: "オンス (oz)", factor: 0.028349523125 },
      { id: "lb", label: "ポンド (lb)", factor: 0.45359237 },
      { id: "monme", label: "匁", factor: 0.00375 },
      { id: "kan", label: "貫", factor: 3.75 },
    ],
  },
  {
    // 温度は掛け算だけでは変換できないので、基準(摂氏)との相互変換を関数で持つ
    name: "温度",
    default: "c",
    units: [
      { id: "c", label: "摂氏 (℃)", toBase: (v) => v, fromBase: (v) => v },
      { id: "f", label: "華氏 (℉)", toBase: (v) => (v - 32) / 1.8, fromBase: (v) => v * 1.8 + 32 },
      { id: "k", label: "ケルビン (K)", toBase: (v) => v - 273.15, fromBase: (v) => v + 273.15 },
    ],
  },
  {
    name: "面積",
    default: "m2",
    units: [
      { id: "mm2", label: "平方ミリメートル (mm²)", factor: 1e-6 },
      { id: "cm2", label: "平方センチメートル (cm²)", factor: 1e-4 },
      { id: "m2", label: "平方メートル (m²)", factor: 1 },
      { id: "a", label: "アール (a)", factor: 100 },
      { id: "ha", label: "ヘクタール (ha)", factor: 1e4 },
      { id: "km2", label: "平方キロメートル (km²)", factor: 1e6 },
      { id: "in2", label: "平方インチ (in²)", factor: 0.00064516 },
      { id: "ft2", label: "平方フィート (ft²)", factor: 0.09290304 },
      { id: "acre", label: "エーカー", factor: 4046.8564224 },
      { id: "tsubo", label: "坪", factor: 400 / 121 },
    ],
  },
  {
    name: "体積",
    default: "l",
    units: [
      { id: "ml", label: "ミリリットル (mL)", factor: 1e-3 },
      { id: "l", label: "リットル (L)", factor: 1 },
      { id: "m3", label: "立方メートル (m³)", factor: 1e3 },
      { id: "tsp", label: "小さじ", factor: 0.005 },
      { id: "tbsp", label: "大さじ", factor: 0.015 },
      { id: "cup", label: "カップ (日本)", factor: 0.2 },
      { id: "floz", label: "液量オンス (米)", factor: 0.0295735295625 },
      { id: "gal", label: "ガロン (米)", factor: 3.785411784 },
      { id: "go", label: "合", factor: 2401 / 13310 },
      { id: "sho", label: "升", factor: 2401 / 1331 },
    ],
  },
  {
    name: "速度",
    default: "kmh",
    units: [
      { id: "ms", label: "メートル毎秒 (m/s)", factor: 1 },
      { id: "kmh", label: "キロメートル毎時 (km/h)", factor: 1 / 3.6 },
      { id: "mph", label: "マイル毎時 (mph)", factor: 0.44704 },
      { id: "kn", label: "ノット (kn)", factor: 1852 / 3600 },
      { id: "fts", label: "フィート毎秒 (ft/s)", factor: 0.3048 },
    ],
  },
  {
    name: "時間",
    default: "h",
    units: [
      { id: "ms", label: "ミリ秒", factor: 1e-3 },
      { id: "s", label: "秒", factor: 1 },
      { id: "min", label: "分", factor: 60 },
      { id: "h", label: "時間", factor: 3600 },
      { id: "d", label: "日", factor: 86400 },
      { id: "w", label: "週", factor: 604800 },
      { id: "y", label: "年 (365日)", factor: 31536000 },
    ],
  },
  {
    name: "データ量・通信量",
    default: "gb",
    units: [
      { id: "bit", label: "ビット (bit)", factor: 1 / 8 },
      { id: "b", label: "バイト (B)", factor: 1 },
      { id: "kb", label: "キロバイト (kB)", factor: 1e3 },
      { id: "mb", label: "メガバイト (MB)", factor: 1e6 },
      { id: "gb", label: "ギガバイト (GB)", factor: 1e9 },
      { id: "tb", label: "テラバイト (TB)", factor: 1e12 },
      { id: "kib", label: "キビバイト (KiB)", factor: 2 ** 10 },
      { id: "mib", label: "メビバイト (MiB)", factor: 2 ** 20 },
      { id: "gib", label: "ギビバイト (GiB)", factor: 2 ** 30 },
      { id: "tib", label: "テビバイト (TiB)", factor: 2 ** 40 },
    ],
  },
  {
    // 回線の速度は bit/s 、ダウンロード表示などは B/s で書かれることが多い (1 B = 8 bit)
    name: "通信速度",
    default: "mbps",
    units: [
      { id: "bps", label: "ビット毎秒 (bps)", factor: 1 },
      { id: "kbps", label: "キロビット毎秒 (kbps)", factor: 1e3 },
      { id: "mbps", label: "メガビット毎秒 (Mbps)", factor: 1e6 },
      { id: "gbps", label: "ギガビット毎秒 (Gbps)", factor: 1e9 },
      { id: "tbps", label: "テラビット毎秒 (Tbps)", factor: 1e12 },
      { id: "bs", label: "バイト毎秒 (B/s)", factor: 8 },
      { id: "kbs", label: "キロバイト毎秒 (kB/s)", factor: 8e3 },
      { id: "mbs", label: "メガバイト毎秒 (MB/s)", factor: 8e6 },
      { id: "gbs", label: "ギガバイト毎秒 (GB/s)", factor: 8e9 },
    ],
  },
  {
    name: "圧力",
    default: "hpa",
    units: [
      { id: "pa", label: "パスカル (Pa)", factor: 1 },
      { id: "hpa", label: "ヘクトパスカル (hPa)", factor: 100 },
      { id: "kpa", label: "キロパスカル (kPa)", factor: 1e3 },
      { id: "mpa", label: "メガパスカル (MPa)", factor: 1e6 },
      { id: "bar", label: "バール (bar)", factor: 1e5 },
      { id: "atm", label: "気圧 (atm)", factor: 101325 },
      { id: "mmhg", label: "水銀柱ミリメートル (mmHg)", factor: 133.322387415 },
      { id: "psi", label: "重量ポンド毎平方インチ (psi)", factor: 6894.757293168 },
    ],
  },
  {
    name: "エネルギー",
    default: "kcal",
    units: [
      { id: "j", label: "ジュール (J)", factor: 1 },
      { id: "kj", label: "キロジュール (kJ)", factor: 1e3 },
      { id: "cal", label: "カロリー (cal)", factor: 4.184 },
      { id: "kcal", label: "キロカロリー (kcal)", factor: 4184 },
      { id: "wh", label: "ワット時 (Wh)", factor: 3600 },
      { id: "kwh", label: "キロワット時 (kWh)", factor: 3.6e6 },
      { id: "btu", label: "英熱量 (BTU)", factor: 1055.05585262 },
    ],
  },
  {
    // L/100km は「値が小さいほど燃費が良い」逆数の関係なので、関数で変換する
    name: "燃費",
    default: "kml",
    units: [
      { id: "kml", label: "キロメートル毎リットル (km/L)", factor: 1 },
      { id: "l100km", label: "リットル毎100km (L/100km)", toBase: (v) => 100 / v, fromBase: (v) => 100 / v },
      { id: "mpgus", label: "マイル毎ガロン (米 mpg)", factor: 1.609344 / 3.785411784 },
      { id: "mpguk", label: "マイル毎ガロン (英 mpg)", factor: 1.609344 / 4.54609 },
    ],
  },
  {
    name: "力",
    default: "n",
    units: [
      { id: "n", label: "ニュートン (N)", factor: 1 },
      { id: "kn", label: "キロニュートン (kN)", factor: 1e3 },
      { id: "dyn", label: "ダイン (dyn)", factor: 1e-5 },
      { id: "gf", label: "重量グラム (gf)", factor: 0.00980665 },
      { id: "kgf", label: "重量キログラム (kgf)", factor: 9.80665 },
      { id: "lbf", label: "重量ポンド (lbf)", factor: 4.4482216152605 },
    ],
  },
  {
    name: "トルク",
    default: "nm",
    units: [
      { id: "ncm", label: "ニュートンセンチメートル (N·cm)", factor: 1e-2 },
      { id: "nm", label: "ニュートンメートル (N·m)", factor: 1 },
      { id: "knm", label: "キロニュートンメートル (kN·m)", factor: 1e3 },
      { id: "kgfcm", label: "重量キログラムセンチメートル (kgf·cm)", factor: 0.0980665 },
      { id: "kgfm", label: "重量キログラムメートル (kgf·m)", factor: 9.80665 },
      { id: "lbfin", label: "重量ポンドインチ (lbf·in)", factor: 4.4482216152605 * 0.0254 },
      { id: "lbfft", label: "重量ポンドフィート (lbf·ft)", factor: 4.4482216152605 * 0.3048 },
    ],
  },
  {
    name: "仕事率",
    default: "kw",
    units: [
      { id: "w", label: "ワット (W)", factor: 1 },
      { id: "kw", label: "キロワット (kW)", factor: 1e3 },
      { id: "mw", label: "メガワット (MW)", factor: 1e6 },
      { id: "ps", label: "仏馬力 (PS)", factor: 735.49875 },
      { id: "hp", label: "英馬力 (HP)", factor: 745.69987158227 },
      { id: "kcalh", label: "キロカロリー毎時 (kcal/h)", factor: 4184 / 3600 },
      { id: "btuh", label: "英熱量毎時 (BTU/h)", factor: 1055.05585262 / 3600 },
    ],
  },
];

const categoriesEl = document.getElementById("categories");
const valueEl = document.getElementById("value");
const fromEl = document.getElementById("from");
const allEl = document.getElementById("all");

let current = CATEGORIES[0];

// いったん基準単位に直してから、目的の単位に直す
function convert(value, from, to) {
  const base = from.toBase ? from.toBase(value) : value * from.factor;
  return to.fromBase ? to.fromBase(base) : base / to.factor;
}

// 0.1 + 0.2 = 0.30000000000000004 のような誤差を見せないよう、有効数字 10 桁に丸める
function format(n) {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e15 || abs < 1e-9) {
    return n.toExponential(6).replace(/\.?0+e/, "e").replace("e+", "e");
  }
  return new Intl.NumberFormat("ja-JP", { maximumSignificantDigits: 10 }).format(n);
}

function findUnit(id) {
  return current.units.find((u) => u.id === id);
}

function update() {
  const from = findUnit(fromEl.value);
  // 入力が空のときは NaN にして「—」を表示する
  const value = valueEl.value.trim() === "" ? NaN : Number(valueEl.value);

  // 変換元と同じ単位は一覧に出さない
  const others = current.units.filter((unit) => unit !== from);

  allEl.replaceChildren(
    ...others.map((unit) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      const num = document.createElement("span");
      name.className = "name";
      num.className = "num";
      name.textContent = unit.label;
      num.textContent = format(convert(value, from, unit));
      li.append(name, num);
      return li;
    })
  );
}

function selectCategory(category) {
  current = category;

  for (const button of categoriesEl.children) {
    button.setAttribute("aria-pressed", String(button.textContent === category.name));
  }

  fromEl.replaceChildren(...category.units.map((u) => new Option(u.label, u.id)));
  fromEl.value = category.default;

  update();
}

for (const category of CATEGORIES) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = category.name;
  button.addEventListener("click", () => selectCategory(category));
  categoriesEl.append(button);
}

valueEl.addEventListener("input", update);
fromEl.addEventListener("change", update);

selectCategory(current);
