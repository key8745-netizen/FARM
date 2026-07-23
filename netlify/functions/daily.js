// 農務智慧日報引擎 — 天氣 × 病害風險 × 每日行動清單（統一入口）
// 資料邏輯參考 github.com/r91628120/ai-agriculture-core（MIT），已本地化獨立維護。
// 入口：POST { plots: [{plot,crop,stage,ageDays,isHarvesting,daysToHarvest,
//                       inPHI,phiEndStr,ecLastDays,ipmLastDays,sprayLastDays,isDone}] }
// 回傳：{ weather, weatherTomorrow, decisions, risks, tasks }

const WX_LAT = 23.40;
const WX_LON  = 120.85;

const CWA_STATION_IDS = ['U2HA30', 'U2HA40']; // 臺大和社、臺大內茅埔

// ── 病害資料庫（番茄 / 彩椒，共 12 項）──────────────────────────────────────
const DISEASE_DB = [
  { name:'晚疫病',       crops:['番茄'],          sensitiveStages:['花期','果期','採收期'],
    cond:{ tempRange:[15,25], humidityMin:90, rainMin:5 },
    sym:'葉背白色霉層，果實水浸腐爛',
    adv:'通風降濕；移除病葉病果；噴波爾多液（依植保系統）' },
  { name:'早疫病',       crops:['番茄'],          sensitiveStages:['生長期','花期','果期'],
    cond:{ tempRange:[24,30], humidityMin:85, rainMin:5, sunshineMax:4 },
    sym:'葉片同心環褐斑，嚴重時黃化枯落',
    adv:'保持通風；噴百克敏或甲基多保淨（依植保系統）' },
  { name:'灰黴病',       crops:['番茄','彩椒'],   sensitiveStages:['花期','果期','採收期'],
    cond:{ tempRange:[15,23], humidityMin:90, sunshineMax:3 },
    sym:'花、果腐爛並覆灰色黴層',
    adv:'摘除病花病果；開窗通風降濕；噴腐黴利（依植保系統）' },
  { name:'疫病',         crops:['番茄','彩椒'],   sensitiveStages:['苗期','生長期','花期'],
    cond:{ tempRange:[20,30], humidityMin:90, rainMin:5 },
    sym:'莖葉水浸狀腐爛，2~3天蔓延',
    adv:'避免積水；苗期預防噴藥；發現立即拔除病株' },
  { name:'葉黴病',       crops:['番茄'],          sensitiveStages:['生長期','花期','果期'],
    cond:{ tempRange:[20,28], humidityMin:85 },
    sym:'葉背橄欖色黴斑，葉正面黃化',
    adv:'加強溫室通風；噴甲基多保淨（依植保系統）' },
  { name:'青枯病',       crops:['番茄','彩椒'],   sensitiveStages:['定植期','生長期','果期'],
    cond:{ tempRange:[25,35], humidityMin:80, rainMin:5 },
    sym:'植株急速萎凋（葉仍綠），維管束褐變',
    adv:'拔除病株；避免傷根；接種木黴菌生物防治' },
  { name:'細菌性斑點病', crops:['番茄','彩椒'],   sensitiveStages:['生長期','果期'],
    cond:{ tempRange:[24,32], humidityMin:85, rainMin:5, windSensitive:true },
    sym:'葉、果暗褐色斑點，風雨傳播快',
    adv:'減少雨水噴濺；噴氫氧化銅（依植保系統）' },
  { name:'萎凋病',       crops:['番茄'],          sensitiveStages:['生長期','果期'],
    cond:{ tempRange:[25,30], humidityMin:75 },
    sym:'葉片黃化萎凋，維管束褐變',
    adv:'選抗病品種；介質消毒；拔除病株' },
  { name:'白粉病',       crops:['番茄'],          sensitiveStages:['生長期','花期','果期'],
    cond:{ tempRange:[20,28], humidityMin:70, sunshineMin:6 },
    sym:'葉面白粉狀病斑，葉片黃化枯死',
    adv:'通風；噴窄域油或硫黃粉（依植保系統）' },
  { name:'炭疽病',       crops:['彩椒'],          sensitiveStages:['果期','採收期'],
    cond:{ tempRange:[24,32], humidityMin:80, rainMin:5 },
    sym:'果實凹陷水浸斑，採收期損失重',
    adv:'降濕；採收仔細選果；噴亞托敏（依植保系統）' },
  { name:'捲葉病毒',     crops:['番茄','彩椒'],   sensitiveStages:['苗期','生長期','花期'],
    cond:{ tempRange:[22,32], humidityMin:60, sunshineMin:8 },
    sym:'新葉捲曲矮化，兩週內顯症',
    adv:'防治粉蝨媒介（黏板+登記藥劑）；及早拔除病株' },
  { name:'斑點萎凋病毒', crops:['番茄','彩椒'],   sensitiveStages:['苗期','生長期'],
    cond:{ tempRange:[20,32], humidityMin:60, sunshineMin:8 },
    sym:'葉斑嵌紋，7~10天內萎凋',
    adv:'防治薊馬（主要媒介）；即早拔除病株' },
];

// ── 濕度推估（WMO 天氣碼 + 降雨機率 → 相對濕度 %）─────────────────────────
function estimateHumidity(code, rainProb) {
  if ([45, 48].includes(code)) return 95;
  if (rainProb >= 80) return 92;
  if (rainProb >= 60 || [55,63,65,82,95,96,99].includes(code)) return 87;
  if (rainProb >= 40 || [51,53,61,80,81].includes(code)) return 79;
  if (rainProb >= 20 || code === 3) return 70;
  return 60;
}

// ── 病害評分（AIAKOS 升級版）────────────────────────────────────────────────
function calcScore(cond, wx) {
  let s = 20;
  const [tl, th] = cond.tempRange ?? [20, 30];

  if (wx.temp >= tl && wx.temp <= th) s += 25;
  else if (wx.temp >= tl - 3 && wx.temp <= th + 3) s += 10;

  if (cond.humidityMin != null) {
    if (wx.humidity >= cond.humidityMin) s += 25;
    else if (wx.humidity >= cond.humidityMin - 10) s += 10;
  } else {
    s += 12;
  }

  if (cond.rainMin > 0) {
    if (wx.rain >= cond.rainMin) s += 20;
    else if (wx.rain >= cond.rainMin / 2) s += 10;
  } else {
    s += 10;
  }

  if (cond.windSensitive && (wx.windSpeed ?? 0) >= 4) s += 8;

  if (cond.sunshineMax != null) {
    if (wx.sunshine <= cond.sunshineMax) s += 10;
    else s += Math.max(0, 10 - (wx.sunshine - cond.sunshineMax) * 2);
  } else if (cond.sunshineMin != null) {
    if (wx.sunshine >= cond.sunshineMin) s += 10;
    else s += Math.max(0, 10 - (cond.sunshineMin - wx.sunshine) * 2);
  } else {
    s += 5;
  }

  if (wx.stage && Array.isArray(cond.sensitiveStages) &&
      cond.sensitiveStages.includes(wx.stage)) {
    s += 15;
  }

  return Math.min(100, Math.round(s));
}

// ── CWA 農業氣象站（需 CWA_API_KEY 環境變數）────────────────────────────────
async function fetchCWAWeather() {
  const key = process.env.CWA_API_KEY;
  if (!key) return null;
  try {
    const url =
      `https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0003-001` +
      `?Authorization=${key}&StationId=${CWA_STATION_IDS.join(',')}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const data  = await r.json();
    const stns  = data?.records?.Station;
    if (!Array.isArray(stns) || !stns.length) return null;

    let tSum = 0, hSum = 0, rSum = 0, wSum = 0, sunSum = 0, n = 0;
    const names = [];
    for (const s of stns) {
      const we = s.WeatherElement ?? {};
      const t  = parseFloat(we.AirTemperature);
      const h  = parseFloat(we.RelativeHumidity);
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
      tempMax:   null,
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

// ── Open-Meteo 多日預報（免 API Key）────────────────────────────────────────
async function fetchOpenMeteoMultiDay(days = 3) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${WX_LAT}&longitude=${WX_LON}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,` +
    `weathercode,precipitation_sum,sunshine_duration,wind_speed_10m_max` +
    `&timezone=Asia%2FTaipei&forecast_days=${days}`;

  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
  const { daily: d } = await r.json();

  return Array.from({ length: days }, (_, i) => {
    const code     = d.weathercode?.[i] ?? 0;
    const rainProb = d.precipitation_probability_max?.[i] ?? 0;
    const tempMax  = d.temperature_2m_max?.[i] ?? 25;
    const tempMin  = d.temperature_2m_min?.[i] ?? 18;
    return {
      temp:      (tempMax + tempMin) / 2,
      tempMax,
      tempMin,
      humidity:  estimateHumidity(code, rainProb),
      rain:      d.precipitation_sum?.[i] ?? 0,
      windSpeed: d.wind_speed_10m_max?.[i] ?? 0,
      sunshine:  (d.sunshine_duration?.[i] ?? 0) / 3600,
      rainProb,
      code,
      source:    'Open-Meteo',
      stations:  `${WX_LAT}°N ${WX_LON}°E（模型預報）`,
    };
  });
}

// ── 五類農事決策（AIAKOS DecisionEngine 本地化）──────────────────────────────
function analyzeDecisions(wx) {
  const { temp, humidity, rain, windSpeed: ws } = wx;
  const dec = [];

  if (rain >= 20 || ws >= 8) {
    dec.push({ cat:'採收', level:'hi',
      msg:`${ws >= 8 ? '強風 '+ws.toFixed(1)+' m/s' : '大雨 '+rain.toFixed(1)+' mm'}：採收易損傷，建議今日延後` });
  } else if (rain >= 5 || ws >= 4) {
    dec.push({ cat:'採收', level:'mid', msg:'有雨/微風：採收輕拿輕放，避免碰傷降等' });
  } else {
    dec.push({ cat:'採收', level:'ok', msg:'天氣條件適合採收與分級作業' });
  }

  if (rain >= 20 || ws >= 8) {
    dec.push({ cat:'出貨', level:'hi', msg:'強雨/強風：不建議今日送貨，先與盤商確認延後' });
  } else if (rain >= 5) {
    dec.push({ cat:'出貨', level:'mid', msg:'有降雨：確保包裝防水、車廂通風良好' });
  } else {
    dec.push({ cat:'出貨', level:'ok', msg:'可安排今日送貨，路況注意山區落石' });
  }

  if (humidity >= 85 || temp >= 34) {
    dec.push({ cat:'採後儲存', level:'hi',
      msg:`${humidity >= 85 ? '高濕 '+humidity+'%' : '高溫 '+temp.toFixed(0)+'°C'}：採後果品立即移冷藏，勿堆置，否則表皮出水降等` });
  } else if (humidity >= 75 || temp >= 30) {
    dec.push({ cat:'採後儲存', level:'mid', msg:'溫濕偏高：已採果品盡快冷藏，延遲超過 2 小時品質下降' });
  }

  if (rain >= 20) {
    dec.push({ cat:'施肥施藥', level:'hi',
      msg:'大雨：暫停施肥施藥。肥料被沖走直接虧錢，農藥藥效也消失；確認溫室排水暢通' });
  } else if (rain >= 5) {
    dec.push({ cat:'施肥施藥', level:'mid', msg:'有雨：避免葉面噴施，改灌根或等雨停 2 小時後再施' });
  } else if (temp >= 34) {
    dec.push({ cat:'施肥施藥', level:'mid', msg:'高溫：避免正午噴藥，改早晨 07:00 前或傍晚 17:00 後' });
  } else {
    dec.push({ cat:'施肥施藥', level:'ok', msg:'條件適合施肥或噴藥，注意安全採收期（PHI）' });
  }

  if (humidity >= 85 && rain >= 5) {
    dec.push({ cat:'病害預防', level:'hi', msg:'高濕 + 降雨：真菌性病害高風險。花果期需特別考慮預防性施藥' });
  } else if (humidity >= 80) {
    dec.push({ cat:'病害預防', level:'mid', msg:'濕度偏高：加強溫室通風，注意灰黴、葉黴初期症狀' });
  } else {
    dec.push({ cat:'病害預防', level:'ok', msg:'目前濕度正常，維持日常巡田觀察' });
  }

  return dec;
}

// ── 每日智慧行動清單（核心：整合病害 × 天氣 × 田區狀態）────────────────────
function generateTasks(plots, today, tomorrow, perPlotRisks) {
  const tasks = [];
  const tmRain = tomorrow?.rainProb ?? 0;

  for (const plot of plots) {
    if (plot.isDone) continue;   // 已結束輪作
    if (plot.ageDays < 0) {      // 尚未定植
      tasks.push({
        priority: 'today',
        icon: '🌱',
        plot: plot.plot,
        task: `${-plot.ageDays} 天後定植`,
        detail: '準備介質、消毒容器、確認種苗來源',
        reason: '定植前準備'
      });
      continue;
    }

    const plotRisks = perPlotRisks[plot.plot] || [];
    const hiRisks   = plotRisks.filter(r => r.score >= 70);
    const midRisks  = plotRisks.filter(r => r.score >= 50 && r.score < 70);

    // ① 禁採（PHI 期間採收風險）
    if (plot.inPHI && plot.isHarvesting) {
      tasks.push({
        priority: 'urgent',
        icon: '⚠️',
        plot: plot.plot,
        task: `禁採：用藥安全期至 ${plot.phiEndStr}`,
        detail: '安全採收期尚未結束，採收將有農藥殘留超標風險，依食安法可開罰',
        reason: '植保安全採收期'
      });
    }

    // ② 病害高風險 → 考慮預防施藥
    if (hiRisks.length > 0 && !plot.inPHI && (plot.sprayLastDays == null || plot.sprayLastDays > 7)) {
      tasks.push({
        priority: 'urgent',
        icon: '🦠',
        plot: plot.plot,
        task: `病害高風險（${hiRisks.length} 項）— 考慮預防施藥`,
        detail: hiRisks.map(r => `${r.name} ${r.score}分 → ${r.adv}`).join('\n'),
        reason: `最高評分 ${hiRisks[0].score} 分，天氣條件極適病害發生`
      });
    }

    // ③ 明日有雨 → 今日是施藥/施肥最後視窗
    if (tmRain >= 60 && !plot.inPHI && (plot.sprayLastDays == null || plot.sprayLastDays > 5)) {
      tasks.push({
        priority: 'today',
        icon: '🌧',
        plot: plot.plot,
        task: `明日降雨 ${tmRain}%，把握今日施藥視窗`,
        detail: '明日雨後藥效消失，今日是噴施農藥或葉面肥最後時機',
        reason: '雨水稀釋藥效，明日後需重新評估'
      });
    }

    // ④ EC/pH 已逾 7 天未量
    if (plot.ecLastDays == null || plot.ecLastDays >= 7) {
      tasks.push({
        priority: 'today',
        icon: '🌡️',
        plot: plot.plot,
        task: `EC/pH 抄錄${plot.ecLastDays != null ? `（已 ${plot.ecLastDays} 天未測）` : '（尚無紀錄）'}`,
        detail: `${plot.stage || ''}期目標 EC 請對照系統建議值；pH 維持 6.0–6.8`,
        reason: 'EC/pH 偏差直接影響根系吸水吸肥效率，每週至少一次'
      });
    }

    // ⑤ 黏板巡查已逾 14 天
    if (plot.ipmLastDays == null || plot.ipmLastDays >= 14) {
      tasks.push({
        priority: 'today',
        icon: '🪤',
        plot: plot.plot,
        task: `黏板巡查${plot.ipmLastDays != null ? `（已 ${plot.ipmLastDays} 天未查）` : '（尚無紀錄）'}`,
        detail: '計數各色黏板：粉蝨、薊馬、葉蟎、蚜蟲；達門檻才查植保系統用藥',
        reason: '兩週未巡查可能錯過蟲口暴增初期'
      });
    }

    // ⑥ 即將採收（7 天內）
    if (!plot.isHarvesting && plot.daysToHarvest != null && plot.daysToHarvest > 0 && plot.daysToHarvest <= 7) {
      tasks.push({
        priority: 'today',
        icon: '🧺',
        plot: plot.plot,
        task: `${plot.daysToHarvest} 天後預計開始採收`,
        detail: '備妥採收容器、分級設備、冷藏空間；提前與盤商確認出貨時間',
        reason: '提前準備可降低首批採收損耗'
      });
    }

    // ⑦ 病害中風險（且無高風險） → 加強通風即可
    if (midRisks.length > 0 && hiRisks.length === 0) {
      tasks.push({
        priority: 'today',
        icon: '💨',
        plot: plot.plot,
        task: `病害中風險 — 加強通風`,
        detail: midRisks.slice(0, 3).map(r => `${r.name}（${r.score}分）`).join('、') + '，及早清除枯葉、病花、落果',
        reason: '通風是預防真菌病害最經濟的手段，優先於用藥'
      });
    }
  }

  // 緊急任務排前面，其次按原始田區順序
  return tasks.sort((a, b) => {
    if (a.priority === b.priority) return 0;
    return a.priority === 'urgent' ? -1 : 1;
  });
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
    const body  = JSON.parse(event.body || '{}');
    const plots = Array.isArray(body.plots) ? body.plots : [];

    // 同時取 CWA 即時 + Open-Meteo 三天預報
    const [cwa, omDays] = await Promise.all([
      fetchCWAWeather(),
      fetchOpenMeteoMultiDay(3),
    ]);

    const omToday = omDays[0];
    // CWA 補充 Open-Meteo 缺少的預報欄位
    const today = cwa ? {
      ...cwa,
      tempMax:  cwa.tempMax  ?? omToday.tempMax,
      tempMin:  cwa.tempMin  ?? omToday.tempMin,
      rainProb: cwa.rainProb ?? omToday.rainProb,
      code:     cwa.code     ?? omToday.code,
    } : omToday;
    const tomorrow = omDays[1] ?? omToday;

    // 逐田區計算病害風險（含生育階段加成）
    const perPlotRisks = {};
    for (const plot of plots) {
      if (plot.ageDays < 0) { perPlotRisks[plot.plot] = []; continue; }
      const cropKey = (plot.crop || '').includes('番茄') ? '番茄' : '彩椒';
      perPlotRisks[plot.plot] = DISEASE_DB
        .filter(d => d.crops.includes(cropKey))
        .map(d => ({
          name:  d.name,
          sym:   d.sym,
          adv:   d.adv,
          score: calcScore(d.cond, { ...today, stage: plot.stage }),
        }))
        .filter(d => d.score >= 50);
    }

    // 全域病害風險（去重，取各病害最高分）
    let allRisksList = Object.values(perPlotRisks).flat();
    if (!allRisksList.length) {
      // 無田區時用預設兩種作物
      for (const cropKey of ['番茄', '彩椒']) {
        allRisksList.push(...DISEASE_DB
          .filter(d => d.crops.includes(cropKey))
          .map(d => ({ name: d.name, sym: d.sym, adv: d.adv, score: calcScore(d.cond, today) }))
          .filter(d => d.score >= 50));
      }
    }
    const riskDedup = {};
    for (const r of allRisksList) {
      if (!riskDedup[r.name] || riskDedup[r.name].score < r.score) riskDedup[r.name] = r;
    }
    const risks = Object.values(riskDedup)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    const decisions = analyzeDecisions(today);
    const tasks     = generateTasks(plots, today, tomorrow, perPlotRisks);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ weather: today, weatherTomorrow: tomorrow, decisions, risks, tasks }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: e.message }),
    };
  }
};
