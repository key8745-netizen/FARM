// 病害風險 + 農事決策引擎 — 信義鄉溫室版（完全自包含）
// 資料邏輯參考 github.com/r91628120/ai-agriculture-core（MIT），已本地化獨立維護。

const WX_LAT = 23.40;
const WX_LON  = 120.85;

// 信義鄉境內 CWA 農業氣象站（來源：AIAKOS stations.json）
// 環境變數 CWA_API_KEY 未設定時自動 fallback 到 Open-Meteo 模型預報
const CWA_STATION_IDS = ['U2HA30', 'U2HA40']; // 臺大和社、臺大內茅埔

// ── 病害資料庫（番茄 / 彩椒，共 12 項）──────────────────────────────────────
const DISEASE_DB = [
  { name:'晚疫病',      crops:['番茄'],          sensitiveStages:['花期','果期','採收期'],
    cond:{ tempRange:[15,25], humidityMin:90, rainMin:5 },
    sym:'葉背白色霉層，果實水浸腐爛',
    adv:'通風降濕；移除病葉病果；噴波爾多液（依植保系統）' },
  { name:'早疫病',      crops:['番茄'],          sensitiveStages:['生長期','花期','果期'],
    cond:{ tempRange:[24,30], humidityMin:85, rainMin:5, sunshineMax:4 },
    sym:'葉片同心環褐斑，嚴重時黃化枯落',
    adv:'保持通風；噴百克敏或甲基多保淨（依植保系統）' },
  { name:'灰黴病',      crops:['番茄','彩椒'],   sensitiveStages:['花期','果期','採收期'],
    cond:{ tempRange:[15,23], humidityMin:90, sunshineMax:3 },
    sym:'花、果腐爛並覆灰色黴層',
    adv:'摘除病花病果；開窗通風降濕；噴腐黴利（依植保系統）' },
  { name:'疫病',        crops:['番茄','彩椒'],   sensitiveStages:['苗期','生長期','花期'],
    cond:{ tempRange:[20,30], humidityMin:90, rainMin:5 },
    sym:'莖葉水浸狀腐爛，2~3天蔓延',
    adv:'避免積水；苗期預防噴藥；發現立即拔除病株' },
  { name:'葉黴病',      crops:['番茄'],          sensitiveStages:['生長期','花期','果期'],
    cond:{ tempRange:[20,28], humidityMin:85 },
    sym:'葉背橄欖色黴斑，葉正面黃化',
    adv:'加強溫室通風；噴甲基多保淨（依植保系統）' },
  { name:'青枯病',      crops:['番茄','彩椒'],   sensitiveStages:['定植期','生長期','果期'],
    cond:{ tempRange:[25,35], humidityMin:80, rainMin:5 },
    sym:'植株急速萎凋（葉仍綠），維管束褐變',
    adv:'拔除病株；避免傷根；接種木黴菌生物防治' },
  { name:'細菌性斑點病',crops:['番茄','彩椒'],   sensitiveStages:['生長期','果期'],
    cond:{ tempRange:[24,32], humidityMin:85, rainMin:5, windSensitive:true },
    sym:'葉、果暗褐色斑點，風雨傳播快',
    adv:'減少雨水噴濺；噴氫氧化銅（依植保系統）' },
  { name:'萎凋病',      crops:['番茄'],          sensitiveStages:['生長期','果期'],
    cond:{ tempRange:[25,30], humidityMin:75 },
    sym:'葉片黃化萎凋，維管束褐變',
    adv:'選抗病品種；介質消毒；拔除病株' },
  { name:'白粉病',      crops:['番茄'],          sensitiveStages:['生長期','花期','果期'],
    cond:{ tempRange:[20,28], humidityMin:70, sunshineMin:6 },
    sym:'葉面白粉狀病斑，葉片黃化枯死',
    adv:'通風；噴窄域油或硫黃粉（依植保系統）' },
  { name:'炭疽病',      crops:['彩椒'],          sensitiveStages:['果期','採收期'],
    cond:{ tempRange:[24,32], humidityMin:80, rainMin:5 },
    sym:'果實凹陷水浸斑，採收期損失重',
    adv:'降濕；採收仔細選果；噴亞托敏（依植保系統）' },
  { name:'捲葉病毒',    crops:['番茄','彩椒'],   sensitiveStages:['苗期','生長期','花期'],
    cond:{ tempRange:[22,32], humidityMin:60, sunshineMin:8 },
    sym:'新葉捲曲矮化，兩週內顯症',
    adv:'防治粉蝨媒介（黏板+登記藥劑）；及早拔除病株' },
  { name:'斑點萎凋病毒',crops:['番茄','彩椒'],   sensitiveStages:['苗期','生長期'],
    cond:{ tempRange:[20,32], humidityMin:60, sunshineMin:8 },
    sym:'葉斑嵌紋，7~10天內萎凋',
    adv:'防治薊馬（主要媒介）；即早拔除病株' },
];

// ── 濕度推估（Open-Meteo fallback 用：WMO 碼 + 降雨機率 → 相對濕度 %）────────
function estimateHumidity(code, rainProb) {
  if ([45, 48].includes(code)) return 95;
  if (rainProb >= 80) return 92;
  if (rainProb >= 60 || [55,63,65,82,95,96,99].includes(code)) return 87;
  if (rainProb >= 40 || [51,53,61,80,81].includes(code)) return 79;
  if (rainProb >= 20 || code === 3) return 70;
  return 60;
}

// ── 病害評分（AIAKOS 升級版：含基底分、緩衝帶、生育階段加成）─────────────────
function calcScore(cond, wx) {
  let s = 20; // 基底風險（AIAKOS 原版設計）
  const [tl, th] = cond.tempRange ?? [20, 30];

  // 氣溫 (0~25 分) + 緩衝帶 ±3°C 給部分分
  if (wx.temp >= tl && wx.temp <= th) {
    s += 25;
  } else if (wx.temp >= tl - 3 && wx.temp <= th + 3) {
    s += 10;
  }

  // 濕度 (0~25 分) + 門檻 -10% 給部分分
  if (cond.humidityMin != null) {
    if (wx.humidity >= cond.humidityMin) s += 25;
    else if (wx.humidity >= cond.humidityMin - 10) s += 10;
  } else {
    s += 12;
  }

  // 降雨 (0~20 分) + 達門檻一半給部分分
  if (cond.rainMin > 0) {
    if (wx.rain >= cond.rainMin) s += 20;
    else if (wx.rain >= cond.rainMin / 2) s += 10;
  } else {
    s += 10;
  }

  // 風速（細菌性傳播加成 +8）
  if (cond.windSensitive && (wx.windSpeed ?? 0) >= 4) s += 8;

  // 日照 (0~10 分) — 真菌：低日照危險；病毒：高日照媒介活躍
  if (cond.sunshineMax != null) {
    if (wx.sunshine <= cond.sunshineMax) s += 10;
    else s += Math.max(0, 10 - (wx.sunshine - cond.sunshineMax) * 2);
  } else if (cond.sunshineMin != null) {
    if (wx.sunshine >= cond.sunshineMin) s += 10;
    else s += Math.max(0, 10 - (cond.sunshineMin - wx.sunshine) * 2);
  } else {
    s += 5;
  }

  // 生育階段加成 +15（AIAKOS 原版設計）
  if (wx.stage && Array.isArray(cond.sensitiveStages ?? []) &&
      (cond.sensitiveStages ?? []).includes(wx.stage)) {
    s += 15;
  }

  return Math.min(100, Math.round(s));
}

// ── CWA 真實氣象站（需 CWA_API_KEY 環境變數）────────────────────────────────
async function fetchCWAWeather() {
  const key = process.env.CWA_API_KEY;
  if (!key) return null;

  try {
    const ids = CWA_STATION_IDS.join(',');
    const url =
      `https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0003-001` +
      `?Authorization=${key}&StationId=${ids}`;

    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;

    const data  = await r.json();
    const stns  = data?.records?.Station;
    if (!Array.isArray(stns) || !stns.length) return null;

    let tSum = 0, hSum = 0, rSum = 0, wSum = 0, sunSum = 0, n = 0;
    const names = [];

    for (const s of stns) {
      const we  = s.WeatherElement ?? {};
      const t   = parseFloat(we.AirTemperature);
      const h   = parseFloat(we.RelativeHumidity);
      if (!isFinite(t) || t === -99 || !isFinite(h) || h === -99) continue;

      tSum   += t;
      hSum   += h;
      rSum   += parseFloat(we.Now?.Precipitation ?? 0) || 0;
      wSum   += parseFloat(we.WindSpeed ?? 0) || 0;
      sunSum += parseFloat(we.SunshineDuration ?? 0) || 0;
      names.push(s.StationName || s.StationId);
      n++;
    }

    if (!n) return null;

    return {
      temp:      tSum / n,
      tempMax:   null,   // 即時觀測無日高，由 Open-Meteo 預報補
      tempMin:   null,
      humidity:  Math.round(hSum / n),
      rain:      rSum / n,
      windSpeed: wSum / n,
      sunshine:  sunSum / n,
      rainProb:  null,
      code:      null,
      source:    'CWA',
      stations:  names.join(' + '),
    };
  } catch (_) {
    return null;
  }
}

// ── Open-Meteo 預報（fallback，免 API Key）────────────────────────────────────
async function fetchOpenMeteoWeather() {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${WX_LAT}&longitude=${WX_LON}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,` +
    `weathercode,precipitation_sum,sunshine_duration,wind_speed_10m_max` +
    `&timezone=Asia%2FTaipei&forecast_days=1`;

  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
  const { daily: d } = await r.json();

  const code     = d.weathercode?.[0] ?? 0;
  const rainProb = d.precipitation_probability_max?.[0] ?? 0;
  const tempMax  = d.temperature_2m_max?.[0] ?? 25;
  const tempMin  = d.temperature_2m_min?.[0] ?? 18;

  return {
    temp:      (tempMax + tempMin) / 2,
    tempMax,
    tempMin,
    humidity:  estimateHumidity(code, rainProb),
    rain:      d.precipitation_sum?.[0] ?? 0,
    windSpeed: d.wind_speed_10m_max?.[0] ?? 0,
    sunshine:  (d.sunshine_duration?.[0] ?? 0) / 3600,
    rainProb,
    code,
    source:    'Open-Meteo',
    stations:  `${WX_LAT}°N ${WX_LON}°E（模型預報）`,
  };
}

// CWA 優先，失敗則 fallback
async function fetchTodayWeather() {
  const cwa = await fetchCWAWeather();
  if (cwa) return cwa;
  return fetchOpenMeteoWeather();
}

// ── 五類農事決策（AIAKOS DecisionEngine 本地化）──────────────────────────────
function analyzeDecisions(wx) {
  const { temp, humidity, rain, windSpeed: ws } = wx;
  const dec = [];

  // 1. 採收
  if (rain >= 20 || ws >= 8) {
    dec.push({ cat:'採收', level:'hi',
      msg:`${ws >= 8 ? '強風 '+ws.toFixed(1)+' m/s' : '大雨 '+rain.toFixed(1)+' mm'}：採收易損傷，建議今日延後` });
  } else if (rain >= 5 || ws >= 4) {
    dec.push({ cat:'採收', level:'mid',
      msg:'有雨/微風：採收輕拿輕放，避免碰傷降等' });
  } else {
    dec.push({ cat:'採收', level:'ok',
      msg:'天氣條件適合採收與分級作業' });
  }

  // 2. 出貨 / 運輸
  if (rain >= 20 || ws >= 8) {
    dec.push({ cat:'出貨', level:'hi',
      msg:'強雨/強風：不建議今日送貨，先與盤商確認延後' });
  } else if (rain >= 5) {
    dec.push({ cat:'出貨', level:'mid',
      msg:'有降雨：確保包裝防水、車廂通風良好' });
  } else {
    dec.push({ cat:'出貨', level:'ok',
      msg:'可安排今日送貨，路況注意山區落石' });
  }

  // 3. 採後儲存品質
  if (humidity >= 85 || temp >= 34) {
    dec.push({ cat:'採後儲存', level:'hi',
      msg:`${humidity >= 85 ? '高濕 '+humidity+'%' : '高溫 '+temp.toFixed(0)+'°C'}：採後果品立即移冷藏，勿堆置，否則表皮出水降等` });
  } else if (humidity >= 75 || temp >= 30) {
    dec.push({ cat:'採後儲存', level:'mid',
      msg:'溫濕偏高：已採果品盡快冷藏，延遲超過 2 小時品質下降' });
  }

  // 4. 施肥 / 施藥
  if (rain >= 20) {
    dec.push({ cat:'施肥施藥', level:'hi',
      msg:'大雨：暫停施肥施藥。肥料被沖走直接虧錢，農藥藥效也消失；確認溫室排水暢通' });
  } else if (rain >= 5) {
    dec.push({ cat:'施肥施藥', level:'mid',
      msg:'有雨：避免葉面噴施，改灌根或等雨停 2 小時後再施' });
  } else if (temp >= 34) {
    dec.push({ cat:'施肥施藥', level:'mid',
      msg:'高溫：避免正午噴藥（蒸發快、藥害風險），改早晨 07:00 前或傍晚 17:00 後' });
  } else {
    dec.push({ cat:'施肥施藥', level:'ok',
      msg:'條件適合施肥或噴藥，注意安全採收期（PHI）' });
  }

  // 5. 病害預防
  if (humidity >= 85 && rain >= 5) {
    dec.push({ cat:'病害預防', level:'hi',
      msg:'高濕 + 降雨：真菌性病害高風險。花果期需特別考慮預防性施藥' });
  } else if (humidity >= 80) {
    dec.push({ cat:'病害預防', level:'mid',
      msg:'濕度偏高：加強溫室通風，注意灰黴、葉黴初期症狀' });
  } else {
    dec.push({ cat:'病害預防', level:'ok',
      msg:'目前濕度正常，維持日常巡田觀察' });
  }

  return dec;
}

// ── Netlify Function 入口 ─────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=1800',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const body     = JSON.parse(event.body || '{}');
    const cropKeys = Array.isArray(body.crops) && body.crops.length
      ? body.crops : ['番茄', '彩椒'];
    const stage    = body.stage ?? '';   // 生育期（可選，用於病害階段加成）

    const wx = await fetchTodayWeather();

    const risks = DISEASE_DB
      .filter(d => d.crops.some(c => cropKeys.includes(c)))
      .map(d => ({
        name:  d.name,
        sym:   d.sym,
        adv:   d.adv,
        score: calcScore(d.cond, { ...wx, stage }),
      }))
      .filter(d => d.score >= 50)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    const decisions = analyzeDecisions(wx);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ risks, decisions, weather: wx }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: e.message }),
    };
  }
};
