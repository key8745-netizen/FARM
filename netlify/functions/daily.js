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
      const daysLeft = -plot.ageDays;
      tasks.push({
        priority: 'today',
        icon: '🌱',
        plot: plot.plot,
        task: `${daysLeft} 天後定植`,
        detail: daysLeft <= 3
          ? '定植前確認清單：① 介質填充完成（椰纖:珍珠石=1:1，排液 EC < 1.0）② 每株滴頭出水順暢 ③ 誘引繩/夾子備妥 ④ 夜溫確認 > 15°C'
          : '本週工作：備妥栽培介質、裝好滴灌管、確認每株滴頭出水。定植前 1 天先澆水讓介質充分濕潤。',
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
        detail: `什麼是安全採收期（PHI）？\n農藥施用後，需要一段時間讓藥劑在果實中分解到安全濃度以下，這段時間就是 PHI（Pre-Harvest Interval）。\n在 ${plot.phiEndStr} 之前採收，可能導致農藥殘留超標，消費者吃了有健康風險，你也可能面臨罰款或取消產銷履歷認證。\n→ 今日繼續其他農事，耐心等待 PHI 結束。`,
        reason: '植保安全採收期，食安法規強制要求'
      });
    }

    // ② 病害高風險 → 考慮預防施藥
    if (hiRisks.length > 0 && !plot.inPHI && (plot.sprayLastDays == null || plot.sprayLastDays > 7)) {
      const riskLines = hiRisks.map(r => `• ${r.name}（${r.score}分）：${r.sym}\n  → ${r.adv}`).join('\n');
      tasks.push({
        priority: 'urgent',
        icon: '🦠',
        plot: plot.plot,
        task: `病害高風險（${hiRisks.length} 項）— 考慮預防施藥`,
        detail: `今日天氣條件有利以下病害發生，建議先巡田確認有無初期症狀，再決定是否施藥：\n${riskLines}\n\n施藥前請記得：① 查植保資訊系統確認登記藥 ② 記錄藥名和安全採收期（PHI）③ 避免正午高溫噴藥。`,
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
        detail: `為什麼下雨前要施藥？\n雨水會把剛噴的農藥或葉面肥沖洗掉，藥效大幅降低甚至完全消失。明日降雨機率 ${tmRain}%，若有需要施藥，今日（最好上午 9–11 點或傍晚）是本週最後機會。\n\n今日施藥步驟：① 確認藥劑已在植保系統登記 ② 依稀釋倍數配藥 ③ 均勻噴施葉面（正反兩面）④ 登錄藥名、日期、安全採收期到 App →「用藥」。`,
        reason: '雨水會沖洗藥劑，明日後需重新評估是否補噴'
      });
    }

    // ④ EC/pH 已逾 7 天未量
    if (plot.ecLastDays == null || plot.ecLastDays >= 7) {
      const ecStageHint = plot.stage === '苗期' ? '苗期目標 EC 1.5–2.0'
        : plot.stage === '生長期' ? '生長期目標 EC 2.0–2.5'
        : plot.stage === '花期' ? '花期目標 EC 2.5–2.8'
        : plot.stage === '果期' || plot.stage === '採收期' ? '果期/採收期目標 EC 2.8–3.2'
        : 'EC 目標請對照系統建議值';
      tasks.push({
        priority: 'today',
        icon: '🌡️',
        plot: plot.plot,
        task: `EC/pH 抄錄${plot.ecLastDays != null ? `（已 ${plot.ecLastDays} 天未測）` : '（尚無紀錄）'}`,
        detail: `怎麼量？用 EC 計和 pH 計插入介質中，或收集排液（袋底流出的水）放入小杯測量。\n\n今日 ${plot.crop || ''}（${plot.stage || '生育中'}）：${ecStageHint}，pH 目標 6.0–6.8。\n\nEC 偏高（> 目標×1.3）→ 今日澆清水淋洗，暫停追肥。\nEC 偏低（< 目標×0.6）→ 可適量追肥補養分。\npH > 7.2 或 < 5.5 → 調整灌溉水酸鹼度（加磷酸或石灰）。\n\n量完後記到 App →「EC/pH」，系統會自動分析偏差。`,
        reason: 'EC/pH 偏差直接影響根系吸水吸肥效率，每週至少量一次'
      });
    }

    // ⑤ 黏板巡查已逾 14 天
    if (plot.ipmLastDays == null || plot.ipmLastDays >= 14) {
      tasks.push({
        priority: 'today',
        icon: '🪤',
        plot: plot.plot,
        task: `黏板巡查${plot.ipmLastDays != null ? `（已 ${plot.ipmLastDays} 天未查）` : '（尚無紀錄）'}`,
        detail: `怎麼做黏板巡查？\n① 取下舊黃板，數上面黏著的小蟲數量。\n   黃板：主要黏粉蝨（白色小飛蟲）和蚜蟲（綠/黑色小蟲）\n   藍板：主要黏薊馬（細長小黑蟲）\n② 記錄到 App →「黏板巡查」（粉蝨、薊馬、葉蟎、蚜蟲各填數量）\n③ 換上新黃板/藍板（每 1–2 週換一次）\n\n達到門檻才需要用藥（IPM 原則）：\n粉蝨 ≥ 5 隻/板、薊馬 ≥ 3 隻/板、葉蟎 ≥ 5 隻/板、蚜蟲 ≥ 10 隻/板\n未達門檻：繼續觀察，不需急著用藥。`,
        reason: '兩週未巡查可能錯過蟲口暴增初期，IPM 防治的核心是監測密度'
      });
    }

    // ⑥ 即將採收（7 天內）
    if (!plot.isHarvesting && plot.daysToHarvest != null && plot.daysToHarvest > 0 && plot.daysToHarvest <= 7) {
      tasks.push({
        priority: 'today',
        icon: '🧺',
        plot: plot.plot,
        task: `${plot.daysToHarvest} 天後預計開始採收`,
        detail: `採收前準備清單：\n① 採收工具：準備採果剪（鋒利、消毒）\n② 容器：塑膠採收箱（帶透氣孔），內墊軟墊避免碰傷\n③ 冷藏：確認冷藏庫/冷藏車有足夠空間（番茄冷藏 10–13°C）\n④ 聯繫盤商：提前 2–3 天通知採收量，確認出貨時間、市場\n⑤ 採收標準（番茄）：果肩轉橘紅色即可（七分熟），不要等到全紅才摘，否則運輸中容易損傷\n\n採完後用 App →「採收」記錄產量，分級填入特/優/次級。`,
        reason: '提前準備可大幅降低首批採收損耗與物流壓力'
      });
    }

    // ⑦ 病害中風險（且無高風險） → 加強通風即可
    if (midRisks.length > 0 && hiRisks.length === 0) {
      const riskNames = midRisks.slice(0, 3).map(r => `${r.name}（${r.score}分）`).join('、');
      tasks.push({
        priority: 'today',
        icon: '💨',
        plot: plot.plot,
        task: `病害中風險（${riskNames}）— 加強通風`,
        detail: `今日天氣對 ${riskNames} 有中等感染風險。最簡單有效的預防是通風降濕：\n\n怎麼加強通風？\n① 上午 9 點起打開側窗 + 天窗（利用煙囪效應帶走濕氣）\n② 保持走道通暢，不堆放雜物阻礙氣流\n③ 摘除老葉（下位葉、黃葉），增加株間通風\n④ 撿起落果落葉，避免成為病菌繁殖溫床\n\n通風是最便宜的病害預防，優先於用藥。若明日症狀惡化才考慮施藥。`,
        reason: '通風是預防真菌病害最經濟的手段，優先於化學防治'
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
