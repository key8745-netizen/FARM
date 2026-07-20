#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
farm_report_html.py — 產生視覺化年度經營報告（單檔 HTML）

重用 annual_plan.py 的規劃邏輯，輸出一份自帶樣式、可用瀏覽器開啟的
年度經營報告：輪種時間軸、價位標示、肥料採購彙總、市場策略。

用法:
  python3 farm_report_html.py --start 2026-03 --area 2 --out report.html
  python3 farm_report_html.py --start 2026-03 --area 2 --only 高山草莓,玉女番茄 --out r.html
"""

import argparse
import sys
from collections import defaultdict
from datetime import date, timedelta

import annual_plan as AP

FEN_TO_HA = 0.1


def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def price_class(score):
    if score >= 1.15:
        return "hi", "高價"
    if score <= 0.9:
        return "lo", "低價"
    return "mid", "普通"


def build(plan, crops, ha, start_month, area_fen):
    if not plan:
        return "<p>無規劃結果</p>", {}
    axis_start = min(p[2] for p in plan)
    axis_end = max(p[4] for p in plan)
    span = max((axis_end - axis_start).days, 1)

    def pct(d):
        return (d - axis_start).days / span * 100

    # 月刻度
    ticks = []
    cur = date(axis_start.year, axis_start.month, 1)
    while cur <= axis_end:
        ticks.append((pct(cur), f"{cur.year%100:02d}/{cur.month:02d}"))
        ny, nm = (cur.year + (cur.month // 12), cur.month % 12 + 1)
        cur = date(ny, nm, 1)

    rows_html = []
    fert_total = defaultdict(float)
    for i, (name, fam, plant, hs, he, score) in enumerate(plan, 1):
        cls, label = price_class(score)
        grow_l, grow_r = pct(plant), pct(hs)
        harv_l, harv_r = pct(hs), pct(he)
        c = crops[name]
        plants = int(c["種植密度_株每公頃"] * ha)
        for k, v in c["施肥_每公頃"].items():
            fert_total[k] += v * (plants / c["種植密度_株每公頃"])
        rows_html.append(f"""
      <div class="track">
        <div class="track-label"><span class="rot">輪{i}</span> {esc(name)}
          <span class="fam">{esc(fam or '')}</span></div>
        <div class="track-bar">
          <div class="seg grow" style="left:{grow_l:.1f}%;width:{max(grow_r-grow_l,0.5):.1f}%"
               title="育成期"></div>
          <div class="seg harv {cls}" style="left:{harv_l:.1f}%;width:{max(harv_r-harv_l,0.5):.1f}%">
            <span class="seg-txt">{esc(name)}採收 · {label} {score:.2f}</span>
          </div>
        </div>
      </div>""")

    tick_html = "".join(
        f'<span class="tick" style="left:{p:.1f}%">{esc(t)}</span>' for p, t in ticks)

    # 肥料 tiles
    tiles = "".join(
        f'<div class="tile"><div class="tile-n">{v:,.0f}<span>kg</span></div>'
        f'<div class="tile-l">{esc(k)}</div></div>'
        for k, v in fert_total.items())

    # 輪種明細表
    trs = ""
    for i, (name, fam, plant, hs, he, score) in enumerate(plan, 1):
        cls, label = price_class(score)
        trs += (f'<tr><td class="num">{i}</td><td>{esc(name)}</td>'
                f'<td class="fam-c">{esc(fam or "")}</td>'
                f'<td class="mono">{plant.strftime("%Y-%m-%d")}</td>'
                f'<td class="mono">{hs.strftime("%m/%d")}–{he.strftime("%m/%d")}</td>'
                f'<td><span class="badge {cls}">{label} {score:.2f}</span></td></tr>')

    hi_names = sorted({p[0] for p in plan if p[5] >= 1.15})
    lo_names = sorted({p[0] for p in plan if p[5] <= 0.9})
    avg = sum(p[5] for p in plan) / len(plan)

    strat = []
    if hi_names:
        strat.append(f'<li class="s-hi"><b>主力高價檔：{esc("、".join(hi_names))}</b>'
                     '　對準夏季／產季空窗，做好分級包裝與產銷履歷加值。</li>')
    if lo_names:
        strat.append(f'<li class="s-lo"><b>低價檔：{esc("、".join(lo_names))}</b>'
                     '　考慮改短期葉菜、讓地休養接益菌，或轉契作鎖價。</li>')
    strat.append('<li>出貨前用行情工具查當日均價與多市場比價，挑最佳市場與時機。</li>')

    meta = {
        "start": start_month.strftime("%Y-%m"),
        "area": area_fen,
        "ha": ha,
        "rounds": len(plan),
        "avg": avg,
    }
    body = TEMPLATE_BODY.format(
        start=start_month.strftime("%Y 年 %m 月"),
        area=f"{area_fen:g}",
        ha=f"{ha:.2f}",
        rounds=len(plan),
        avg=f"{avg:.2f}",
        avg_label=("多數收成落在高價區間" if avg >= 1.15 else "收成價位中上" if avg >= 1.0 else "價位偏低，建議調整"),
        ticks=tick_html,
        tracks="".join(rows_html),
        tiles=tiles,
        table_rows=trs,
        strategy="".join(strat),
    )
    return body, meta


TEMPLATE_BODY = """
  <header class="masthead">
    <div class="eyebrow">農務小幫手 · 信義鄉高冷地溫室</div>
    <h1>年度經營報告</h1>
    <p class="sub">以歷史行情規律安排輪種，讓每一輪收成盡量落在高價區間，並遵守輪作養地。</p>
    <div class="meta">
      <div><span>起始</span>{start}</div>
      <div><span>畦區面積</span>{area} 分地（{ha} 公頃）</div>
      <div><span>年度輪次</span>{rounds} 輪</div>
      <div><span>平均價位分數</span>{avg}</div>
    </div>
  </header>

  <section class="panel">
    <h2>輪種時間軸</h2>
    <p class="note">淺色為育成期，深色為採收期；採收段顏色代表價位（綠＝高價、琥珀＝普通、紅＝低價）。</p>
    <div class="timeline">
      <div class="axis">{ticks}</div>
      <div class="tracks">{tracks}</div>
    </div>
    <div class="verdict">整體評估：平均價位分數 <b>{avg}</b> — {avg_label}。</div>
  </section>

  <section class="panel">
    <h2>全年肥料 · 資材採購彙總</h2>
    <p class="note">依畦區面積與各作物密度換算之純養分／堆肥重量；實際採購需再換算成肥料商品的 N-P-K 比例。</p>
    <div class="tiles">{tiles}</div>
  </section>

  <section class="panel">
    <h2>輪種明細</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>輪次</th><th>作物</th><th>科別</th><th>定植日</th><th>採收期</th><th>價位</th></tr></thead>
        <tbody>{table_rows}</tbody>
      </table>
    </div>
  </section>

  <section class="panel two">
    <div>
      <h2>市場策略</h2>
      <ul class="strat">{strategy}</ul>
    </div>
    <div>
      <h2>共通管理原則</h2>
      <ul class="mgmt">
        <li>每日抄錄介質 <b>EC / pH</b>，超標即淋洗或減肥，防鹽害。</li>
        <li>每週黏板巡查，達門檻才查合法用藥並鎖定安全採收期。</li>
        <li>換茬整地補有機質、接種益菌（木黴／枯草桿菌），養好根圈防土傳病害。</li>
        <li>茄科不連作；本表已通過輪作檢查。</li>
      </ul>
    </div>
  </section>

  <footer class="foot">
    數值為 crops.json 示範值。實際栽培曆、施肥與用藥請經 <b>台中區農業改良場</b> 與
    <b>信義鄉農會</b> 校正，並以真實行情替換月價指數後再據以決策。本報告為決策輔助，不取代農業專業診斷。
  </footer>
"""

PAGE = """<title>農務小幫手 · 年度經營報告</title>
<style>
:root {{
  --paper:#F7F5EF; --ink:#232A20; --ink-soft:#5C6353; --line:#DEE2D3;
  --card:#FFFFFF; --accent:#3B6B4A; --accent-soft:#EAF0E7;
  --hi:#4E8C5A; --hi-bg:#E6F0E4; --mid:#C0872C; --mid-bg:#F6ECD6; --lo:#B5533C; --lo-bg:#F5E2DB;
  --grow:#CBD5C0;
}}
@media (prefers-color-scheme: dark) {{
  :root {{
    --paper:#171A14; --ink:#E9EBE1; --ink-soft:#A2A899; --line:#2E3428;
    --card:#1F241B; --accent:#7FB98C; --accent-soft:#26301F;
    --hi:#77BE86; --hi-bg:#22301F; --mid:#D8A94E; --mid-bg:#302915; --lo:#D9846B; --lo-bg:#301E17;
    --grow:#3A4232;
  }}
}}
:root[data-theme="light"] {{
  --paper:#F7F5EF; --ink:#232A20; --ink-soft:#5C6353; --line:#DEE2D3; --card:#FFFFFF;
  --accent:#3B6B4A; --accent-soft:#EAF0E7; --hi:#4E8C5A; --hi-bg:#E6F0E4;
  --mid:#C0872C; --mid-bg:#F6ECD6; --lo:#B5533C; --lo-bg:#F5E2DB; --grow:#CBD5C0;
}}
:root[data-theme="dark"] {{
  --paper:#171A14; --ink:#E9EBE1; --ink-soft:#A2A899; --line:#2E3428; --card:#1F241B;
  --accent:#7FB98C; --accent-soft:#26301F; --hi:#77BE86; --hi-bg:#22301F;
  --mid:#D8A94E; --mid-bg:#302915; --lo:#D9846B; --lo-bg:#301E17; --grow:#3A4232;
}}
* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--paper); color:var(--ink);
  font-family:"PingFang TC","Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif;
  line-height:1.65; -webkit-font-smoothing:antialiased; }}
.wrap {{ max-width:900px; margin:0 auto; padding:clamp(20px,4vw,52px); display:flex;
  flex-direction:column; gap:28px; }}
.masthead {{ border-bottom:2px solid var(--ink); padding-bottom:22px; }}
.eyebrow {{ font-size:.78rem; letter-spacing:.18em; text-transform:uppercase;
  color:var(--accent); font-weight:700; }}
h1 {{ font-family:Georgia,"Songti TC",serif; font-size:clamp(2rem,5vw,3.1rem);
  margin:.15em 0 .1em; letter-spacing:.01em; text-wrap:balance; }}
.sub {{ color:var(--ink-soft); margin:0; max-width:60ch; }}
.meta {{ display:flex; flex-wrap:wrap; gap:10px 34px; margin-top:18px; }}
.meta div {{ font-size:1.05rem; font-weight:600; font-variant-numeric:tabular-nums; }}
.meta span {{ display:block; font-size:.72rem; letter-spacing:.1em; text-transform:uppercase;
  color:var(--ink-soft); font-weight:600; }}
.panel {{ background:var(--card); border:1px solid var(--line); border-radius:14px;
  padding:clamp(18px,3vw,30px); }}
.panel.two {{ display:grid; grid-template-columns:1fr 1fr; gap:32px; }}
@media (max-width:640px) {{ .panel.two {{ grid-template-columns:1fr; }} }}
h2 {{ font-family:Georgia,"Songti TC",serif; font-size:1.4rem; margin:0 0 6px; }}
.note {{ color:var(--ink-soft); font-size:.9rem; margin:0 0 20px; }}
.timeline {{ position:relative; }}
.axis {{ position:relative; height:20px; margin-bottom:6px; border-bottom:1px solid var(--line); }}
.tick {{ position:absolute; transform:translateX(-50%); font-size:.68rem; color:var(--ink-soft);
  font-variant-numeric:tabular-nums; white-space:nowrap; }}
.tracks {{ display:flex; flex-direction:column; gap:12px; padding-top:14px; }}
.track-label {{ font-size:.92rem; font-weight:600; margin-bottom:5px; }}
.rot {{ display:inline-block; background:var(--accent); color:#fff; border-radius:5px;
  padding:1px 7px; font-size:.75rem; margin-right:6px; }}
:root[data-theme="dark"] .rot,@media (prefers-color-scheme:dark){{ .rot{{color:#12160f;}} }}
.fam {{ color:var(--ink-soft); font-size:.8rem; font-weight:500; margin-left:6px; }}
.track-bar {{ position:relative; height:30px; background:var(--paper); border-radius:7px;
  border:1px solid var(--line); overflow:hidden; }}
.seg {{ position:absolute; top:0; height:100%; display:flex; align-items:center; }}
.seg.grow {{ background:var(--grow); }}
.seg.harv {{ border-radius:0 6px 6px 0; }}
.seg.harv.hi {{ background:var(--hi); }}
.seg.harv.mid {{ background:var(--mid); }}
.seg.harv.lo {{ background:var(--lo); }}
.seg-txt {{ font-size:.72rem; color:#fff; padding:0 8px; white-space:nowrap; font-weight:600;
  overflow:hidden; text-overflow:ellipsis; }}
.verdict {{ margin-top:18px; padding:12px 16px; background:var(--accent-soft); border-radius:9px;
  font-size:.95rem; }}
.tiles {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:14px; }}
.tile {{ background:var(--paper); border:1px solid var(--line); border-radius:11px;
  padding:18px 16px; text-align:center; }}
.tile-n {{ font-family:Georgia,serif; font-size:1.9rem; font-weight:700; color:var(--accent);
  font-variant-numeric:tabular-nums; }}
.tile-n span {{ font-size:.85rem; color:var(--ink-soft); margin-left:3px; }}
.tile-l {{ font-size:.85rem; color:var(--ink-soft); margin-top:2px; }}
.table-wrap {{ overflow-x:auto; }}
table {{ width:100%; border-collapse:collapse; font-size:.92rem; }}
th,td {{ text-align:left; padding:10px 12px; border-bottom:1px solid var(--line); }}
th {{ font-size:.72rem; letter-spacing:.08em; text-transform:uppercase; color:var(--ink-soft); }}
td.num,td.mono {{ font-variant-numeric:tabular-nums; }}
td.mono {{ font-family:ui-monospace,"SF Mono",monospace; font-size:.85rem; }}
.fam-c {{ color:var(--ink-soft); font-size:.85rem; }}
.badge {{ display:inline-block; padding:2px 9px; border-radius:20px; font-size:.78rem;
  font-weight:700; font-variant-numeric:tabular-nums; }}
.badge.hi {{ background:var(--hi-bg); color:var(--hi); }}
.badge.mid {{ background:var(--mid-bg); color:var(--mid); }}
.badge.lo {{ background:var(--lo-bg); color:var(--lo); }}
ul {{ margin:0; padding-left:1.1em; display:flex; flex-direction:column; gap:9px; }}
.strat li, .mgmt li {{ font-size:.93rem; }}
.strat .s-hi::marker {{ color:var(--hi); }}
.strat .s-lo::marker {{ color:var(--lo); }}
.foot {{ font-size:.82rem; color:var(--ink-soft); border-top:1px solid var(--line);
  padding-top:18px; line-height:1.7; }}
</style>
<div class="wrap">{body}</div>
"""


def main():
    ap = argparse.ArgumentParser(description="產生視覺化年度經營報告 HTML")
    ap.add_argument("--start", required=True, help="起始月 YYYY-MM")
    ap.add_argument("--area", type=float, default=1.0, help="畦區面積（分地）")
    ap.add_argument("--only", default="", help="限定作物，逗號分隔")
    ap.add_argument("--out", default="report.html", help="輸出 HTML 檔名")
    args = ap.parse_args()

    only = [s.strip() for s in args.only.split(",") if s.strip()] or None
    crops = AP.load_crops(only)
    if not crops:
        print("[錯誤] 沒有符合的作物", file=sys.stderr)
        sys.exit(1)
    y, m = args.start.split("-")
    start_month = date(int(y), int(m), 1)
    ha = args.area * FEN_TO_HA

    plan = AP.plan_zone(crops, start_month)
    body, _ = build(plan, crops, ha, start_month, args.area)
    html = PAGE.format(body=body)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"已輸出報告: {args.out}（{len(plan)} 輪）")


if __name__ == "__main__":
    main()
