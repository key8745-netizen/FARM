#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
daily_tasks_html.py — 每日任務手機頁（單檔 HTML）

讀種植紀錄，產生手機友善、可勾選的當日待辦頁。勾選狀態存於瀏覽器
localStorage（依日期記憶），隔天自動換新清單。重用 daily_tasks.py 邏輯。

用法:
  python3 daily_tasks_html.py --file plantings.json --out today.html
  python3 daily_tasks_html.py --file plantings.json --date 2026-07-20 --out today.html
"""

import argparse
import json
import sys
from datetime import date, datetime

import daily_tasks as DT


def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def build_cards(recs, crops, today):
    cards = []
    total = done_hint = 0
    for rec in recs:
        name = rec.get("作物")
        crop = crops.get(name)
        plot = rec.get("畦區", "?")
        if not crop:
            continue
        age, out = DT.tasks_for(rec, crop, today)
        stage = "採收中" if age >= crop["生育天數_定植到初採"] else "生育中"
        if age < 0:
            stage = "未定植"
        badge_cls = "harv" if stage == "採收中" else ("pre" if stage == "未定植" else "grow")

        items = ""
        for t in out["today"]:
            total += 1
            tid = esc(f"{plot}-{name}-{abs(hash(t))%99999}")
            items += (f'<label class="task"><input type="checkbox" data-k="{tid}">'
                      f'<span>{esc(t)}</span></label>')
        soon = ""
        for t in out["soon"]:
            soon += f'<li>{esc(t)}</li>'
        info = "".join(f'<div class="info">{esc(t)}</div>' for t in out["info"])

        soon_html = f'<div class="soon"><div class="soon-h">未來 7 天</div><ul>{soon}</ul></div>' if soon else ""
        agestr = f"定植後第 {age} 天" if age >= 0 else f"{-age} 天後定植"
        cards.append(f"""
    <article class="card">
      <div class="card-top">
        <h2>{esc(plot)}　<span class="crop">{esc(name)}</span></h2>
        <span class="stage {badge_cls}">{stage}</span>
      </div>
      <div class="sub">{agestr}　·　{esc(str(rec.get('株數','?')))} 株</div>
      {info}
      <div class="tasks">{items}</div>
      {soon_html}
    </article>""")
    return "".join(cards), total


PAGE = """<title>今日農務待辦</title>
<style>
:root {{
  --paper:#F7F5EF; --ink:#232A20; --ink-soft:#5C6353; --line:#DEE2D3; --card:#FFFFFF;
  --accent:#3B6B4A; --accent-soft:#EAF0E7; --harv:#4E8C5A; --harv-bg:#E6F0E4;
  --grow:#C0872C; --grow-bg:#F6ECD6; --pre:#7A8272; --pre-bg:#ECEEE6; --done:#9AA391;
}}
@media (prefers-color-scheme:dark) {{
  :root {{
    --paper:#171A14; --ink:#E9EBE1; --ink-soft:#A2A899; --line:#2E3428; --card:#1F241B;
    --accent:#7FB98C; --accent-soft:#26301F; --harv:#77BE86; --harv-bg:#22301F;
    --grow:#D8A94E; --grow-bg:#302915; --pre:#8A9280; --pre-bg:#252A20; --done:#5B6350;
  }}
}}
:root[data-theme="light"] {{
  --paper:#F7F5EF; --ink:#232A20; --ink-soft:#5C6353; --line:#DEE2D3; --card:#FFFFFF;
  --accent:#3B6B4A; --accent-soft:#EAF0E7; --harv:#4E8C5A; --harv-bg:#E6F0E4;
  --grow:#C0872C; --grow-bg:#F6ECD6; --pre:#7A8272; --pre-bg:#ECEEE6; --done:#9AA391;
}}
:root[data-theme="dark"] {{
  --paper:#171A14; --ink:#E9EBE1; --ink-soft:#A2A899; --line:#2E3428; --card:#1F241B;
  --accent:#7FB98C; --accent-soft:#26301F; --harv:#77BE86; --harv-bg:#22301F;
  --grow:#D8A94E; --grow-bg:#302915; --pre:#8A9280; --pre-bg:#252A20; --done:#5B6350;
}}
* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--paper); color:var(--ink);
  font-family:"PingFang TC","Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif;
  line-height:1.6; -webkit-font-smoothing:antialiased; }}
.wrap {{ max-width:560px; margin:0 auto; padding:18px 16px 60px; display:flex;
  flex-direction:column; gap:16px; }}
header {{ position:sticky; top:0; background:var(--paper); padding:8px 0 12px;
  border-bottom:2px solid var(--ink); z-index:5; }}
.eyebrow {{ font-size:.72rem; letter-spacing:.16em; text-transform:uppercase;
  color:var(--accent); font-weight:700; }}
h1 {{ font-family:Georgia,"Songti TC",serif; font-size:1.7rem; margin:.1em 0 .15em; }}
.progress {{ display:flex; align-items:center; gap:10px; font-size:.85rem; color:var(--ink-soft); }}
.bar {{ flex:1; height:8px; background:var(--line); border-radius:5px; overflow:hidden; }}
.bar i {{ display:block; height:100%; width:0; background:var(--accent); transition:width .3s; }}
.card {{ background:var(--card); border:1px solid var(--line); border-radius:15px; padding:16px 16px 14px; }}
.card-top {{ display:flex; justify-content:space-between; align-items:center; gap:10px; }}
h2 {{ font-size:1.15rem; margin:0; }}
.crop {{ color:var(--accent); }}
.stage {{ font-size:.72rem; font-weight:700; padding:3px 10px; border-radius:20px; white-space:nowrap; }}
.stage.harv {{ background:var(--harv-bg); color:var(--harv); }}
.stage.grow {{ background:var(--grow-bg); color:var(--grow); }}
.stage.pre {{ background:var(--pre-bg); color:var(--pre); }}
.sub {{ font-size:.82rem; color:var(--ink-soft); margin:3px 0 10px; }}
.info {{ font-size:.9rem; background:var(--accent-soft); border-radius:9px; padding:9px 12px; margin-bottom:8px; }}
.tasks {{ display:flex; flex-direction:column; gap:2px; }}
.task {{ display:flex; align-items:flex-start; gap:11px; padding:11px 6px; cursor:pointer;
  border-bottom:1px solid var(--line); }}
.task:last-child {{ border-bottom:none; }}
.task input {{ width:24px; height:24px; margin:0; flex-shrink:0; accent-color:var(--accent); cursor:pointer; }}
.task span {{ font-size:.98rem; padding-top:1px; }}
.task input:checked + span {{ color:var(--done); text-decoration:line-through; }}
.soon {{ margin-top:12px; padding-top:10px; border-top:1px dashed var(--line); }}
.soon-h {{ font-size:.72rem; letter-spacing:.08em; text-transform:uppercase; color:var(--ink-soft);
  font-weight:700; margin-bottom:5px; }}
.soon ul {{ margin:0; padding-left:1.1em; }}
.soon li {{ font-size:.86rem; color:var(--ink-soft); margin:3px 0; }}
.foot {{ font-size:.78rem; color:var(--ink-soft); text-align:center; line-height:1.7; padding:0 10px; }}
</style>
<div class="wrap">
  <header>
    <div class="eyebrow">農務小幫手 · 信義鄉溫室</div>
    <h1>今日農務待辦</h1>
    <div class="progress"><span id="pt">0 / {total}</span>
      <div class="bar"><i id="pb"></i></div><span id="pd">{datestr}</span></div>
  </header>
  {cards}
  <div class="foot">用藥一律查植保系統合法登記藥並守安全採收期。<br>數值為示範，請經台中區農業改良場校正。</div>
</div>
<script>
(function(){{
  var day="{daykey}";
  var boxes=document.querySelectorAll('.task input');
  function key(b){{return "farm-"+day+"-"+b.dataset.k;}}
  function refresh(){{
    var done=0; boxes.forEach(function(b){{if(b.checked)done++;}});
    document.getElementById('pt').textContent=done+" / "+boxes.length;
    document.getElementById('pb').style.width=(boxes.length? done/boxes.length*100:0)+"%";
  }}
  boxes.forEach(function(b){{
    try{{ if(localStorage.getItem(key(b))==="1") b.checked=true; }}catch(e){{}}
    b.addEventListener('change',function(){{
      try{{ localStorage.setItem(key(b), b.checked?"1":"0"); }}catch(e){{}}
      refresh();
    }});
  }});
  refresh();
}})();
</script>
"""


def main():
    ap = argparse.ArgumentParser(description="每日任務手機頁")
    ap.add_argument("--file", required=True)
    ap.add_argument("--date", default="")
    ap.add_argument("--out", default="today.html")
    args = ap.parse_args()

    today = (datetime.strptime(args.date, "%Y-%m-%d").date()
             if args.date else date.today())
    try:
        crops = DT.load_crops()
        recs = DT.load_plantings(args.file)
    except FileNotFoundError as e:
        print(f"[錯誤] 找不到檔案: {e}", file=sys.stderr)
        sys.exit(1)

    cards, total = build_cards(recs, crops, today)
    html = PAGE.format(cards=cards, total=total,
                       datestr=today.strftime("%Y-%m-%d"),
                       daykey=today.strftime("%Y%m%d"))
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"已輸出手機待辦頁: {args.out}（{total} 項任務）")


if __name__ == "__main__":
    main()
