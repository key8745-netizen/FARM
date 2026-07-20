#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
daily_tasks.py — 每日任務產生器

讀你的種植紀錄（plantings.json），對指定日期算出每個畦區「今天要做什麼」:
  - 排程一次性任務（定植後第 N 天）到期提醒 + 未來 7 天預告
  - 每日例行（抄錄 EC/pH、巡視）
  - 每週例行（黏板巡查病蟲害）
  - 目前生育階段與 EC 目標值
  - 採收狀態（是否進入採收期、出貨前查行情）

知識庫: crops.json（作業排程、EC曲線、生育天數）。零套件依賴。

用法:
  python3 daily_tasks.py --file plantings.json                # 用今天
  python3 daily_tasks.py --file plantings.json --date 2026-07-20
  python3 daily_tasks.py --file plantings.json --plot A區
"""

import argparse
import json
import os
import sys
from datetime import date, datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))


def load_crops():
    with open(os.path.join(HERE, "crops.json"), encoding="utf-8") as f:
        return json.load(f)["作物"]


def load_plantings(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f).get("種植紀錄", [])


def ec_stage(crop, age, grow):
    """依生育進度回傳 (階段名, EC目標)。"""
    ec = crop.get("EC曲線")
    if not ec:
        return None, None
    keys = list(ec.keys())
    if age <= 0:
        f = 0.0
    elif age >= grow:
        f = 0.999
    else:
        f = age / grow
    idx = min(int(f * len(keys)), len(keys) - 1)
    return keys[idx], ec[keys[idx]]


def tasks_for(rec, crop, today):
    plant = datetime.strptime(rec["定植日"], "%Y-%m-%d").date()
    age = (today - plant).days
    grow = crop["生育天數_定植到初採"]
    dur = crop["採收持續天數"]
    out = {"today": [], "soon": [], "info": []}

    if age < 0:
        out["info"].append(f"尚未定植（{-age} 天後 {rec['定植日']} 定植）")
        return age, out
    if age > grow + dur + 30:
        out["info"].append("採收期已結束，準備清園、換茬養地（補有機質+接種益菌）")
        return age, out

    # 一次性排程任務
    for t in crop.get("作業排程_定植後天數", []):
        d = t["天"] - age
        if d == 0:
            out["today"].append(f"📋 {t['事']}")
        elif 0 < d <= 7:
            due = plant + timedelta(days=t["天"])
            out["soon"].append(f"{due.strftime('%m/%d')}（{d}天後）{t['事']}")

    # 每日例行
    stage, ecv = ec_stage(crop, age, grow)
    if stage:
        out["today"].append(f"🌡️ 抄錄介質 EC/pH（目前 {stage}，EC 目標約 {ecv}）；超標即淋洗/減肥")
    out["today"].append("👀 巡視植株：新葉/老葉/花果有無異常（黃化、捲葉、落花、裂果）")

    # 每週例行
    if age % 7 == 0:
        out["today"].append("🪤 黃色黏板巡查（粉蝨/薊馬）；達門檻才查合法用藥並鎖安全採收期")

    # 採收
    if age >= grow:
        harvest_day = age - grow
        out["today"].append(f"🧺 採收期第 {harvest_day} 天：分批適熟採收、記錄產量")
        out["today"].append("💰 出貨前用 analyze_market.py 查當日行情與多市場比價")
    elif 0 < grow - age <= 7:
        out["soon"].append(f"{(plant+timedelta(days=grow)).strftime('%m/%d')}"
                           f"（{grow-age}天後）預計開始採收")

    return age, out


def main():
    ap = argparse.ArgumentParser(description="每日任務產生器")
    ap.add_argument("--file", required=True, help="種植紀錄 JSON（見 plantings.example.json）")
    ap.add_argument("--date", default="", help="指定日期 YYYY-MM-DD（預設今天）")
    ap.add_argument("--plot", default="", help="只看某畦區")
    args = ap.parse_args()

    today = (datetime.strptime(args.date, "%Y-%m-%d").date()
             if args.date else date.today())

    try:
        crops = load_crops()
        recs = load_plantings(args.file)
    except FileNotFoundError as e:
        print(f"[錯誤] 找不到檔案: {e}", file=sys.stderr)
        sys.exit(1)

    if args.plot:
        recs = [r for r in recs if r.get("畦區") == args.plot]

    print("=" * 52)
    print(f" 🌱 今日農務待辦  {today.strftime('%Y-%m-%d (%a)')}")
    print("=" * 52)

    if not recs:
        print("沒有種植紀錄。請複製 plantings.example.json 為 plantings.json 並填入。")
        return

    for rec in recs:
        name = rec.get("作物")
        crop = crops.get(name)
        plot = rec.get("畦區", "?")
        if not crop:
            print(f"\n▌{plot}｜{name}：知識庫沒有此作物，略過")
            continue
        age, out = tasks_for(rec, crop, today)
        print(f"\n▌{plot}｜{name}（定植後第 {age} 天，{rec.get('株數','?')} 株）")
        if out["today"]:
            print("  今日要做:")
            for t in out["today"]:
                print(f"    • {t}")
        if out["soon"]:
            print("  未來 7 天:")
            for t in out["soon"]:
                print(f"    ◦ {t}")
        if out["info"]:
            for t in out["info"]:
                print(f"    ℹ️ {t}")

    print("\n" + "-" * 52)
    print("提醒：用藥一律查植保系統合法登記藥並守安全採收期；數值為示範，"
          "請經改良場校正。")


if __name__ == "__main__":
    main()
