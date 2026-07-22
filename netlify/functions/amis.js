/**
 * Netlify Function: amis
 *
 * 農務小幫手 — 果菜批發市場行情代理（信義鄉溫室番茄/彩椒）
 *
 * 代理農業部 AMIS 開放資料 API，讓 PWA 前端可在手機上即時查詢各市場的
 * 上/中/下/均價與交易量，判斷「哪個市場的上價最高（送上貨）、哪個市場的
 * 下價最高（送下貨）」。無需 API key。
 *
 * 上游：GET https://data.moa.gov.tw/api/v1/AgriProductsTransType/
 *        ?Start_time={ROC}&End_time={ROC}&CropName={name}&Page={n}
 * 日期為民國年 `YYY.MM.DD`（2026-07-06 -> 115.07.06）。
 *
 * POST body: { crop: "番茄", start: "YYYY-MM-DD", end: "YYYY-MM-DD" }
 * 回應: { crop, start, end, markets: MarketStat[], best, warnings }
 *
 * 注意：Claude/CI 開發環境對 data.moa.gov.tw 為封鎖狀態，無法在此即時測試；
 * 部署到 Netlify（開放網路）後由伺服器端呼叫上游，前端同源存取本函式。
 */

'use strict';

const UPSTREAM_BASE = 'https://data.moa.gov.tw/api/v1/AgriProductsTransType/';
const TIMEOUT_MS = 12000;
const MAX_PAGES = 40; // 保護：單次查詢最多抓 40 頁

/** 西元 ISO 日期 → 民國年 YYY.MM.DD */
function toRocDate(isoDate) {
  const [y, m, d] = isoDate.split('-');
  const roc = parseInt(y, 10) - 1911;
  return `${roc}.${m}.${d}`;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/** 抓單頁 AMIS，回傳 { data, next } 或 null（失敗） */
async function fetchPage(rocStart, rocEnd, cropName, page) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `${UPSTREAM_BASE}?Start_time=${encodeURIComponent(rocStart)}&End_time=${encodeURIComponent(rocEnd)}&CropName=${encodeURIComponent(cropName)}&Page=${page}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.RS !== 'OK' || !Array.isArray(json.Data)) return null;
    return { data: json.Data, next: json.Next === true };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 抓完整查詢（含分頁），回傳所有 rows 或 null */
async function fetchAll(rocStart, rocEnd, cropName) {
  let page = 1;
  let all = [];
  while (page <= MAX_PAGES) {
    const r = await fetchPage(rocStart, rocEnd, cropName, page);
    if (r === null) return page === 1 ? null : all; // 第一頁就失敗才算全失敗
    all = all.concat(r.data);
    if (!r.next) break;
    page++;
  }
  return all;
}

/**
 * 依「市場」彙總各價位。交易量加權平均；量為 0 時退回簡單平均。
 * 只計 Avg_Price > 0 的有效交易列（無交易日為 0，排除）。
 */
function aggregateByMarket(rows) {
  const byM = {};
  rows.forEach((r) => {
    if (!(typeof r.Avg_Price === 'number' && r.Avg_Price > 0)) return;
    const name = r.MarketName || r.MarketCode || '未知市場';
    const q = typeof r.Trans_Quantity === 'number' && r.Trans_Quantity > 0 ? r.Trans_Quantity : 0;
    const m = byM[name] || (byM[name] = { market: name, up: 0, mid: 0, low: 0, avg: 0, wsum: 0, n: 0, qty: 0, crops: [] });
    // 加權累積（權重 = 交易量；若量為 0 記為 1 以便退回簡單平均）
    const w = q > 0 ? q : 1;
    m.up += (+r.Upper_Price || 0) * w;
    m.mid += (+r.Middle_Price || 0) * w;
    m.low += (+r.Lower_Price || 0) * w;
    m.avg += (+r.Avg_Price || 0) * w;
    m.wsum += w;
    m.n += 1;
    m.qty += q;
    if (r.CropName && !m.crops.includes(r.CropName) && m.crops.length < 5) m.crops.push(r.CropName);
  });
  return Object.values(byM).map((m) => ({
    market: m.market,
    upper: round1(m.up / m.wsum),
    middle: round1(m.mid / m.wsum),
    lower: round1(m.low / m.wsum),
    avg: round1(m.avg / m.wsum),
    totalQty: Math.round(m.qty),
    days: m.n,
    sampleCropNames: m.crops,
  }));
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let crop, start, end;
  try {
    const body = JSON.parse(event.body || '{}');
    crop = body.crop;
    start = body.start;
    end = body.end || body.start;
    const dateOk = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
    if (typeof crop !== 'string' || crop.trim().length === 0) throw new Error('crop');
    if (!dateOk(start) || !dateOk(end)) throw new Error('date');
  } catch (e) {
    return { statusCode: 400, body: 'Invalid request body' };
  }

  const rocStart = toRocDate(start);
  const rocEnd = toRocDate(end);
  const rows = await fetchAll(rocStart, rocEnd, crop.trim());

  if (rows === null) {
    return { statusCode: 502, body: JSON.stringify({ error: '無法取得市場行情（上游查詢失敗或逾時）' }) };
  }

  const markets = aggregateByMarket(rows);
  const warnings = [];
  if (markets.length === 0) warnings.push(`區間內查無「${crop}」的有效交易資料`);

  // 各價位最佳市場（送哪裡的依據）
  const bestBy = (key) =>
    markets.length ? markets.reduce((a, b) => (b[key] > a[key] ? b : a)).market : null;
  const best = {
    upper: bestBy('upper'),
    middle: bestBy('middle'),
    lower: bestBy('lower'),
    avg: bestBy('avg'),
  };

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ crop, start, end, rocStart, rocEnd, markets, best, warnings }),
  };
};
