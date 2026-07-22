#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
farm_report.py — 一鍵年度經營報告

整合輪種規劃 + 肥料需求 + 作業重點 + 市場策略，產出一份完整的年度經營報告。
重用 annual_plan.py 的規劃邏輯與 crops.json 知識庫。

輸入你的種植規模（畦區面積），自動算出:
  - 全年輪種時間表（收成卡高價 + 輪作）
  - 每輪的肥料需求（依面積換算）與作業起訖
  - 全年肥料/堆肥採購彙總
  - 各輪的市場價位評分與策略提醒

零套件依賴。

用法:
  python3 farm_report.py --start 2026-03 --area 1                 # 1 分地
  python3 farm_report.py --start 2026-03 --area 2 --only 高山草莓,敏豆,高麗菜
"""

import argparse
import sys
from collections import defaultdict
from datetime import timedelta

import annual_plan as AP  # 重用規劃器（同目錄）

FEN_TO_HA = 0.1  # 1 分地 = 0.1 公頃


def fert_for(crop, plants):
    """回傳 {項目: (總量kg, 每株g)}。"""
    density = crop["種植密度_株每公頃"]
    ratio = plants / density
    out = {}
    for k, v in crop["施肥_每公頃"].items():
        total = v * ratio
        out[k] = (total, total * 1000 / plants if plants else 0)
    return out


def main():
    ap = argparse.ArgumentParser(description="一鍵年度經營報告")
    ap.add_argument("--start", required=True, help="起始月 YYYY-MM")
    ap.add_argument("--area", type=float, default=1.0, help="畦區面積（分地，1=0.1公頃）")
    ap.add_argument("--only", default="", help="限定作物，逗號分隔")
    args = ap.parse_args()

    only = [s.strip() for s in args.only.split(",") if s.strip()] or None
    crops = AP.load_crops(only)
    if not crops:
        print("[錯誤] 沒有符合的作物", file=sys.stderr)
        sys.exit(1)

    try:
        y, m = args.start.split("-")
        from datetime import date
        start_month = date(int(y), int(m), 1)
    except Exception:
        print("[錯誤] --start 格式須為 YYYY-MM", file=sys.stderr)
        sys.exit(1)

    plan = AP.plan_zone(crops, start_month)

    print("=" * 60)
    print(f" 農務小幫手 · 年度經營報告")
    print(f" 起始: {args.start}    畦區面積: {args.area} 分地"
          f"（{args.area * FEN_TO_HA:.2f} 公頃）")
    print("=" * 60)

    ha = args.area * FEN_TO_HA
    fert_total = defaultdict(float)

    print("\n【一】年度輪種與收成規劃")
    print(f"{'輪次':>3}  {'作物':<8}{'定植日':<12}{'採收期':<22}{'價位':>7}")
    for i, (name, fam, plant, hs, he, score) in enumerate(plan, 1):
        span = f"{hs.strftime('%m/%d')}~{he.strftime('%m/%d')}"
        print(f"{i:>3}  {name:<8}{plant.strftime('%Y-%m-%d'):<12}{span:<22}"
              f"{score:>5.2f}{AP.light(score)[:2]}")

    print("\n【二】各輪肥料需求（依面積換算）")
    for i, (name, fam, plant, hs, he, score) in enumerate(plan, 1):
        c = crops[name]
        plants = int(c["種植密度_株每公頃"] * ha)
        fert = fert_for(c, plants)
        line = "  ".join(f"{k} {v[0]:.1f}kg" for k, v in fert.items())
        print(f"  輪{i} {name}（約{plants:,}株）: {line}")
        for k, (tot, _) in fert.items():
            fert_total[k] += tot

    print("\n【三】全年肥料/資材採購彙總")
    for k, v in fert_total.items():
        print(f"  {k:<6}: {v:>8.1f} kg")
    print("  ※ 純養分/堆肥重量，需再換算成實際肥料商品；用藥另依植保系統與IPM。")

    print("\n【四】市場策略提醒")
    hi = [p for p in plan if p[5] >= 1.15]
    lo = [p for p in plan if p[5] <= 0.9]
    if hi:
        names = "、".join(sorted({p[0] for p in hi}))
        print(f"  🟢 主力高價檔: {names} — 對準夏季/產季空窗，做好分級與產銷履歷加值。")
    if lo:
        names = "、".join(sorted({p[0] for p in lo}))
        print(f"  🔴 低價檔: {names} — 考慮改短期葉菜、讓地休養接益菌，或轉契作鎖價。")
    print("  📊 出貨前用 fetch_amis.py + analyze_market.py 查當日行情與多市場比價。")

    print("\n【五】共通管理原則")
    print("  · 每日抄錄介質 EC/pH，超標即淋洗/減肥（防鹽害）。")
    print("  · 每週黏板巡查，達門檻才查合法用藥並鎖安全採收期。")
    print("  · 換茬整地補有機質+接種益菌（木黴/枯草桿菌），養好根圈防土傳病害。")
    print("  · 茄科不連作；本表已做輪作檢查。")

    print("\n⚠️ 本報告數值為 crops.json 示範值。實際施肥/用藥/栽培曆請經"
          "台中區農業改良場與信義鄉農會校正，並用實際行情替換月價指數。")


if __name__ == "__main__":
    main()
