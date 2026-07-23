/**
 * Netlify Function: diagnose
 *
 * 農務小幫手 — 作物 AI 影像診斷（信義鄉高冷地溫室・番茄/彩椒）
 *
 * 接收當日照片（base64）＋結構化數據，呼叫 Claude（claude-opus-4-8）以
 * 「介質栽培農藝顧問」角色判斷作物狀態，回傳狀態評估、問題清單、立即處置
 * （灌溉/施肥/用藥/其他）、信心與資料缺口。前端可把「立即處置」套用為當日
 * 動態調整。
 *
 * 需在 Netlify 環境變數設定 ANTHROPIC_API_KEY。
 *
 * POST body: {
 *   crop, stage, ageDays, plot,
 *   data: { giveEC, givePH, drainEC, drainPH, tempHigh, tempLow },
 *   observation: "文字",
 *   recentTrend: "文字",
 *   images: ["data:image/jpeg;base64,....", ...]   // 由前端壓縮後傳入
 * }
 * 回應: { ok, diagnosis:{狀態,問題,處置:{灌溉,施肥,用藥,其他},信心,資料缺口,追蹤}, raw }
 */

'use strict';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-4-8';
const MAX_IMAGES = 5;
const TIMEOUT_MS = 60000;

// AIAKOS PromptEngine 五角色診斷框架（本地化，MIT）
const SYSTEM_PROMPT = `你是「農務 AI 顧問系統」，服務台灣南投信義鄉高冷地溫室農友（作物：牛番茄／彩椒，介質栽培，海拔 800–1700m），目標遵守 TGAP／產銷履歷。

收到照片與現況數據後，請整合以下五位專家視角分析，再輸出一份統整診斷：

🩺 植物醫師視角
辨識可見症狀（部位、顏色、形態、蔓延方向），區分生理障礙 vs. 真菌／細菌／病毒感染 vs. 蟲害媒介，評估嚴重度與擴散速度。

🧪 植保師視角
評估是否需要防治介入，IPM 優先序（環境管理 → 物理 → 生物防治 → 化學農藥）。確認需用藥才建議「查台灣植保資訊系統合法登記藥、守安全採收期（PHI）」；不指定未登記藥名。

🌤 氣象師視角
結合今日天氣（溫濕度、降雨、日照）評估病害傳播與擴散風險；判斷噴藥時機視窗（若明日有雨則今日是最後機會）；高濕 + 低溫 → 灰黴、晚疫；高濕 + 高溫 → 青枯、細菌斑點。

🌱 農業顧問視角
整合上述分析為「今天就能做」的具體行動；施肥／灌溉建議對應介質栽培的給液／排液 EC・pH 目標值；高冷地重點：日夜溫差大，夜溫低於 15°C 易落花落果，著色與糖度受日照影響。

🧺 採收決策視角
評估果實成熟度、著色狀況、品質風險；提供採收時機與市場策略建議。非採收期則說明生育重點與距採收的關鍵管理。

原則：
- 只根據看得到、量得到的證據下判斷；不足時列明需補充的資料，不臆測
- 繁體中文，精簡可執行

僅輸出一個 JSON 物件（不含說明文字、不含 markdown 圍欄）：
{
  "狀態": "一句話總評",
  "問題": ["具體問題（含部位與嚴重度）"],
  "病害風險": "結合天氣說明今日最需警惕的病害及原因（無風險則說明）",
  "處置": {
    "灌溉": "今天怎麼調（或維持）",
    "施肥": "今天怎麼調（或維持）",
    "用藥": "是否需要、防治對象、IPM 建議（或暫不需要）",
    "其他": "整枝／疏果／通風／溫度管理等"
  },
  "採收建議": "採收時機與品質評估（非採收期則說明生育重點）",
  "今日優先": ["最重要的 1–3 項立即行動（精簡可操作）"],
  "信心": "高／中／低",
  "資料缺口": ["還需補拍或補量什麼才能更準"],
  "追蹤": "接下來 3–7 天要觀察或複查什麼"
}`;

function parseDataUrl(dataUrl) {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(String(dataUrl));
  if (!m) return null;
  return { media_type: m[1], data: m[2] };
}

function buildUserText(body) {
  const d = body.data || {};
  const lines = [];
  lines.push(`作物：${body.crop || '未指定'}｜生育階段：${body.stage || '未指定'}｜定植後第 ${body.ageDays != null ? body.ageDays : '?'} 天｜田區：${body.plot || '-'}`);
  const kv = [];
  if (d.giveEC || d.givePH) kv.push(`給液 EC ${d.giveEC || '?'} / pH ${d.givePH || '?'}`);
  if (d.drainEC || d.drainPH) kv.push(`排液 EC ${d.drainEC || '?'} / pH ${d.drainPH || '?'}`);
  if (d.tempHigh || d.tempLow) kv.push(`日高溫 ${d.tempHigh || '?'}℃ / 夜低溫 ${d.tempLow || '?'}℃`);
  if (kv.length) lines.push('數據：' + kv.join('｜'));
  if (body.observation) lines.push('現場觀察：' + body.observation);
  if (body.recentTrend) lines.push('近期趨勢：' + body.recentTrend);
  if (body.diseaseContext) lines.push('今日天氣病害風險預測（供交叉對照）：' + body.diseaseContext);
  lines.push('請依上面的照片與數據做診斷，輸出指定 JSON。');
  return lines.join('\n');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 400,
      body: JSON.stringify({ ok: false, error: '尚未設定 ANTHROPIC_API_KEY（請在 Netlify 環境變數加入）' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: '請求格式錯誤' }) };
  }

  const images = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];
  const content = [];
  for (const img of images) {
    const parsed = parseDataUrl(img);
    if (parsed) content.push({ type: 'image', source: { type: 'base64', media_type: parsed.media_type, data: parsed.data } });
  }
  content.push({ type: 'text', text: buildUserText(body) });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: content }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'AI 服務錯誤 ' + res.status + '：' + errText.slice(0, 200) }) };
    }
    const json = await res.json();
    // 安全採收期／拒絕處理
    if (json.stop_reason === 'refusal') {
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'AI 婉拒了此請求，請調整內容後再試。' }) };
    }
    const textBlock = (json.content || []).find((b) => b.type === 'text');
    const raw = textBlock ? textBlock.text : '';
    let diagnosis = null;
    try {
      const s = raw.indexOf('{');
      const e = raw.lastIndexOf('}');
      if (s !== -1 && e !== -1) diagnosis = JSON.parse(raw.slice(s, e + 1));
    } catch (e) { /* 保留 raw 供前端顯示 */ }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, diagnosis: diagnosis, raw: raw }),
    };
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'AI 診斷逾時，請減少照片數量或稍後再試。' : ('診斷失敗：' + e.message);
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: msg }) };
  } finally {
    clearTimeout(timer);
  }
};
