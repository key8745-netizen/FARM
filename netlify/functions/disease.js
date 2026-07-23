// 病害風險引擎 — 信義鄉溫室版（完全自包含，不依賴任何外部套件）
// 資料邏輯靈感來自 github.com/r91628120/ai-agriculture-core（MIT），
// 已將 diseases.json 相關欄位複製並本地化，此後可獨立維護，不受原 repo 影響。

const WX_LAT = 23.40;
const WX_LON = 120.85;

// ── 病害資料庫（番茄 / 彩椒，共 12 項）──────────────────────────────────────
// 欄位說明：
//   cond.tempRange     [低°C, 高°C]  — 適合發病溫度範圍
//   cond.humidityMin   %              — 最低觸發濕度
//   cond.rainMin       mm/日          — 最低觸發雨量（0 = 無需降雨）
//   cond.sunshineMax   h/日           — 真菌：日照越短越危險
//   cond.sunshineMin   h/日           — 病毒：日照越長媒介越活躍
const DISEASE_DB = [
  { name:"晚疫病",    crops:["番茄"],           cond:{ tempRange:[15,25], humidityMin:90, rainMin:5 },
    sym:"葉背白色霉層，果實水浸腐爛",
    adv:"通風降濕；移除病葉病果；噴波爾多液（依植保系統）" },
  { name:"早疫病",    crops:["番茄"],           cond:{ tempRange:[24,30], humidityMin:85, rainMin:5, sunshineMax:4 },
    sym:"葉片同心環褐斑，嚴重時黃化枯落",
    adv:"保持通風；噴百克敏或甲基多保淨（依植保系統）" },
  { name:"灰黴病",    crops:["番茄","彩椒"],    cond:{ tempRange:[15,23], humidityMin:90, sunshineMax:3 },
    sym:"花、果腐爛並覆灰色黴層",
    adv:"摘除病花病果；開窗通風降濕；噴腐黴利（依植保系統）" },
  { name:"疫病",      crops:["番茄","彩椒"],    cond:{ tempRange:[20,30], humidityMin:90, rainMin:5 },
    sym:"莖葉水浸狀腐爛，2~3天蔓延",
    adv:"避免積水；苗期預防噴藥；發現立即拔除病株" },
  { name:"葉黴病",    crops:["番茄"],           cond:{ tempRange:[20,28], humidityMin:85 },
    sym:"葉背橄欖色黴斑，葉正面黃化",
    adv:"加強溫室通風；噴甲基多保淨（依植保系統）" },
  { name:"青枯病",    crops:["番茄","彩椒"],    cond:{ tempRange:[25,35], humidityMin:80, rainMin:5 },
    sym:"植株急速萎凋（葉仍綠），維管束褐變",
    adv:"拔除病株；避免傷根；接種木黴菌生物防治" },
  { name:"細菌性斑點病", crops:["番茄","彩椒"], cond:{ tempRange:[24,32], humidityMin:85, rainMin:5 },
    sym:"葉、果暗褐色斑點，風雨傳播快",
    adv:"減少雨水噴濺；噴氫氧化銅（依植保系統）" },
  { name:"萎凋病",    crops:["番茄"],           cond:{ tempRange:[25,30], humidityMin:75 },
    sym:"葉片黃化萎凋，維管束褐變",
    adv:"選抗病品種；介質消毒；拔除病株" },
  { name:"白粉病",    crops:["番茄"],           cond:{ tempRange:[20,28], humidityMin:70, sunshineMin:6 },
    sym:"葉面白粉狀病斑，葉片黃化枯死",
    adv:"通風；噴窄域油或硫黃粉（依植保系統）" },
  { name:"炭疽病",    crops:["彩椒"],           cond:{ tempRange:[24,32], humidityMin:80, rainMin:5 },
    sym:"果實凹陷水浸斑，採收期損失重",
    adv:"降濕；採收仔細選果；噴亞托敏（依植保系統）" },
  { name:"捲葉病毒",  crops:["番茄","彩椒"],    cond:{ tempRange:[22,32], humidityMin:60, sunshineMin:8 },
    sym:"新葉捲曲矮化，兩週內顯症",
    adv:"防治粉蝨媒介（黏板+登記藥劑）；及早拔除病株" },
  { name:"斑點萎凋病毒", crops:["番茄","彩椒"], cond:{ tempRange:[20,32], humidityMin:60, sunshineMin:8 },
    sym:"葉斑嵌紋，7~10天內萎凋",
    adv:"防治薊馬（主要媒介）；即早拔除病株" },
];

// ── 濕度推估（從 WMO 天氣碼 + 降雨機率 → 相對濕度 %）────────────────────────
function estimateHumidity(code, rainProb) {
  if ([45, 48].includes(code)) return 95;           // 霧
  if (rainProb >= 80) return 92;
  if (rainProb >= 60 || [55,63,65,82,95,96,99].includes(code)) return 87;
  if (rainProb >= 40 || [51,53,61,80,81].includes(code)) return 79;
  if (rainProb >= 20 || code === 3) return 70;      // 陰天
  return 60;                                        // 晴 / 多雲
}

// ── 單一病害評分（0~100）────────────────────────────────────────────────────
function calcScore(cond, wx) {
  let s = 0;
  const [tl, th] = cond.tempRange ?? [20, 30];

  // 氣溫 (40 分)
  if (wx.temp >= tl && wx.temp <= th) {
    s += 40;
  } else {
    const miss = Math.min(Math.abs(wx.temp - tl), Math.abs(wx.temp - th));
    s += Math.max(0, 40 - miss * 5);
  }

  // 濕度 (30 分)
  if (cond.humidityMin != null) {
    if (wx.humidity >= cond.humidityMin) s += 30;
    else s += Math.max(0, 30 - (cond.humidityMin - wx.humidity) * 1.5);
  } else {
    s += 15;
  }

  // 降雨 (20 分)
  if (cond.rainMin > 0) {
    if (wx.rain >= cond.rainMin) s += 20;
    else s += Math.max(0, 20 - (cond.rainMin - wx.rain) * 4);
  } else {
    s += 10;
  }

  // 日照 (10 分) — 真菌用 sunshineMax，病毒用 sunshineMin
  if (cond.sunshineMax != null) {
    if (wx.sunshine <= cond.sunshineMax) s += 10;
    else s += Math.max(0, 10 - (wx.sunshine - cond.sunshineMax) * 2);
  } else if (cond.sunshineMin != null) {
    if (wx.sunshine >= cond.sunshineMin) s += 10;
    else s += Math.max(0, 10 - (cond.sunshineMin - wx.sunshine) * 2);
  } else {
    s += 5;
  }

  return Math.min(100, Math.round(s));
}

// ── 抓今日天氣（Open-Meteo，免 API Key）────────────────────────────────────
async function fetchTodayWeather() {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${WX_LAT}&longitude=${WX_LON}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,` +
    `weathercode,precipitation_sum,sunshine_duration` +
    `&timezone=Asia%2FTaipei&forecast_days=1`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
  const { daily: d } = await r.json();

  const code     = d.weathercode?.[0] ?? 0;
  const rainProb = d.precipitation_probability_max?.[0] ?? 0;
  const tempMax  = d.temperature_2m_max?.[0] ?? 25;
  const tempMin  = d.temperature_2m_min?.[0] ?? 18;

  return {
    temp:     (tempMax + tempMin) / 2,
    tempMax,
    tempMin,
    humidity: estimateHumidity(code, rainProb),
    rain:     d.precipitation_sum?.[0] ?? 0,
    sunshine: (d.sunshine_duration?.[0] ?? 0) / 3600,
    rainProb,
    code,
  };
}

// ── Netlify Function 入口 ─────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=1800',   // 30 分鐘快取
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const body     = JSON.parse(event.body || '{}');
    const cropKeys = Array.isArray(body.crops) && body.crops.length
      ? body.crops
      : ['番茄', '彩椒'];

    const wx = await fetchTodayWeather();

    const risks = DISEASE_DB
      .filter(d => d.crops.some(c => cropKeys.includes(c)))
      .map(d => ({
        name:  d.name,
        sym:   d.sym,
        adv:   d.adv,
        score: calcScore(d.cond, wx),
      }))
      .filter(d => d.score >= 50)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ risks, weather: wx }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: e.message }),
    };
  }
};
