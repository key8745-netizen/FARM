#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
farm.py — 農務小幫手統一入口

把所有工具收在一個指令下，不用記一堆檔名。

  python3 farm.py today   --file plantings.json          今日待辦（文字）
  python3 farm.py today   --file plantings.json --html today.html   今日待辦（手機頁）
  python3 farm.py calc    --crop 牛番茄 --date 2026-09-15 --plants 500
  python3 farm.py plan    --start 2026-03                 全年輪種規劃
  python3 farm.py report  --start 2026-03 --area 2        年度經營報告（文字）
  python3 farm.py report  --start 2026-03 --area 2 --html report.html   （視覺化）
  python3 farm.py fetch   --crop 甜椒 --start 2026-01-01 --end 2026-12-31 --csv 甜椒.csv
  python3 farm.py market  甜椒.csv --grow-days 90 --market-report
  python3 farm.py crops                                   列出知識庫作物

不帶參數則顯示總覽選單。
"""

import runpy
import sys
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def run(module, argv):
    """設定 sys.argv 後執行指定模組的 main。"""
    sys.argv = [module] + argv
    try:
        runpy.run_path(os.path.join(HERE, module), run_name="__main__")
    except BrokenPipeError:
        # 輸出被 head 等截斷時安靜結束，不噴 traceback
        try:
            sys.stdout.close()
        except Exception:
            pass


def list_crops():
    import json
    with open(os.path.join(HERE, "crops.json"), encoding="utf-8") as f:
        crops = json.load(f)["作物"]
    print("知識庫作物（可用於 calc / plan / report / today）:")
    for name, c in crops.items():
        fam = c.get("科別", "?")
        grow = c.get("生育天數_定植到初採", "?")
        print(f"  · {name}（{fam}，生育約 {grow} 天）")


MENU = """農務小幫手 · 統一入口
────────────────────────────────────────────
每日操作
  today   --file plantings.json [--html today.html]   今天各畦區要做什麼
規劃與計算
  calc    --crop <作物> --date YYYY-MM-DD --plants N   單作物：採收/肥料/排程
  plan    --start YYYY-MM [--only 作物,作物]           全年輪種卡高價
  report  --start YYYY-MM --area <分地> [--html f.html] 年度經營報告
市場行情
  fetch   --crop <作物> --start .. --end .. --csv f    抓交易行情
  market  <csv> [--grow-days N] [--market-report]      行情季節分析
其他
  crops                                                列出知識庫作物
────────────────────────────────────────────
範例: python3 farm.py today --file plantings.json --html today.html
"""

DISPATCH = {
    "calc": "calc_crop.py",
    "plan": "annual_plan.py",
    "fetch": "fetch_amis.py",
    "market": "analyze_market.py",
}


def main():
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help", "help"):
        print(MENU)
        return
    cmd, rest = args[0], args[1:]

    if cmd == "crops":
        list_crops()
    elif cmd == "today":
        # --html <檔> 切換成手機頁產生器，其餘參數原樣傳遞
        if "--html" in rest:
            i = rest.index("--html")
            out = rest[i + 1] if i + 1 < len(rest) else "today.html"
            rest = rest[:i] + rest[i + 2:] + ["--out", out]
            run("daily_tasks_html.py", rest)
        else:
            run("daily_tasks.py", rest)
    elif cmd == "report":
        if "--html" in rest:
            i = rest.index("--html")
            out = rest[i + 1] if i + 1 < len(rest) else "report.html"
            rest = rest[:i] + rest[i + 2:] + ["--out", out]
            run("farm_report_html.py", rest)
        else:
            run("farm_report.py", rest)
    elif cmd in DISPATCH:
        run(DISPATCH[cmd], rest)
    else:
        print(f"未知指令: {cmd}\n", file=sys.stderr)
        print(MENU)
        sys.exit(1)


if __name__ == "__main__":
    main()
