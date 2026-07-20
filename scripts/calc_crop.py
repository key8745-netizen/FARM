#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
calc_crop.py — 作物計算引擎（雛形）

輸入「作物、定植日、株數」，計算:
  - 預估初次採收日、採收結束日、屬於哪個期作
  - 需要的堆肥、氮、磷、鉀用量（總量與每株）
  - EC 目標曲線
  - 定植後作業排程（含實際日期）
  - 分批（非同步）定植建議

知識庫: crops.json（同目錄）。零套件依賴。

用法:
  python3 calc_crop.py --crop 牛番茄 --date 2026-09-15 --plants 500
  python3 calc_crop.py --crop 彩椒 --date 2026-04-01 --plants 800 --batches 4
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))


def load_crops():
    with open(os.path.join(HERE, "crops.json"), encoding="utf-8") as f:
        return json.load(f)["作物"]


def which_season(harvest_month, season_map):
    hits = [name for name, months in season_map.items() if harvest_month in months]
    return hits


def fmt(d):
    return d.strftime("%Y-%m-%d")


def calc(crop_name, plant_date, plants, crops, batches=1):
    if crop_name not in crops:
        print(f"[錯誤] 知識庫沒有『{crop_name}』。可選: {', '.join(crops)}", file=sys.stderr)
        sys.exit(1)
    c = crops[crop_name]
    grow = c["生育天數_定植到初採"]
    dur = c["採收持續天數"]
    density = c["種植密度_株每公頃"]
    ratio = plants / density  # 換算比例

    first = plant_date + timedelta(days=grow)
    last = first + timedelta(days=dur)
    seasons = which_season(first.month, c["期作採收月"])

    print(f"作物: {crop_name}    定植日: {fmt(plant_date)}    株數: {plants:,}")
    print("=" * 52)
    print(f"🌱 初次採收: {fmt(first)}（定植後 {grow} 天）")
    print(f"🍅 採收結束: {fmt(last)} 前後（持續約 {dur} 天）")
    print(f"📅 對應期作: {'、'.join(seasons) if seasons else '（採收月不在建議期作，請留意）'}")

    print(f"\n=== 肥料需求（依 {plants:,} 株 ÷ {density:,} 株/公頃 換算）===")
    fert = c["施肥_每公頃"]
    print(f"{'項目':<8}{'每公頃kg':>10}{'你的總量kg':>12}{'每株g':>10}")
    for k, v in fert.items():
        total = v * ratio
        per = total * 1000 / plants
        print(f"{k:<8}{v:>10,.0f}{total:>12.2f}{per:>10.1f}")
    print("※ 上為純養分/堆肥重量，實際購買需再換算成肥料商品的 N-P-K 比例。")

    ec = c.get("EC曲線")
    if ec:
        print("\n=== EC 目標曲線（dS/m，隨生育期調整）===")
        print("  " + "   ".join(f"{stage}:{val}" for stage, val in ec.items()))

    print("\n=== 作業排程 ===")
    for t in c["作業排程_定植後天數"]:
        d = plant_date + timedelta(days=t["天"])
        print(f"  {fmt(d)}（+{t['天']:>3}天）  {t['事']}")

    if batches > 1:
        print(f"\n=== 分批定植建議（分 {batches} 梯，錯開採收避免爆量）===")
        per_batch = plants // batches
        gap = 14  # 每梯間隔天數
        print(f"每梯約 {per_batch:,} 株，每隔 {gap} 天定植一梯:")
        print(f"{'梯次':>4}{'定植日':>14}{'初採日':>14}")
        for i in range(batches):
            pd = plant_date + timedelta(days=i * gap)
            hd = pd + timedelta(days=grow)
            print(f"{i+1:>4}{fmt(pd):>14}{fmt(hd):>14}")
        print("→ 效果: 採收期拉長、人力平均、每週有貨、分散價格風險。")

    print("\n⚠️ 數值為公開資料示範值，實際（尤其施肥/用藥）請經台中區農業改良場確認。")


def main():
    ap = argparse.ArgumentParser(description="作物計算引擎")
    ap.add_argument("--crop", required=True, help="作物名稱（牛番茄 / 彩椒）")
    ap.add_argument("--date", required=True, help="定植日 西元 YYYY-MM-DD")
    ap.add_argument("--plants", required=True, type=int, help="株數")
    ap.add_argument("--batches", type=int, default=1, help="分批梯次（預設1=不分批）")
    args = ap.parse_args()

    try:
        pd = datetime.strptime(args.date, "%Y-%m-%d").date()
    except ValueError:
        print("[錯誤] 日期格式須為 YYYY-MM-DD", file=sys.stderr)
        sys.exit(1)

    crops = load_crops()
    calc(args.crop, pd, args.plants, crops, args.batches)


if __name__ == "__main__":
    main()
