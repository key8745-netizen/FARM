#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
annual_plan.py — 一年輪種規劃器

目標: 為單一溫室/畦區安排一整年的輪種，讓每一輪收成盡量落在「高價月」，
      同時遵守輪作原則（不連作同科別，降低土傳病害）。

原理:
  - 讀 crops.json 的「生育天數、採收持續、科別、月價指數」。
  - 從起始月開始，貪婪地：在可選作物中（科別 != 上一輪）試不同定植時機，
    計算「採收期間的平均月價指數」，挑最高者排入，換茬留緩衝期後接下一輪。
  - 產出年度輪種時間表 + 每輪的採收價位評分。

零套件依賴。數值為示範，實際月價指數建議用 fetch_amis.py + analyze_market.py 撈實資替換。

用法:
  python3 annual_plan.py --start 2026-04 --zones 1
  python3 annual_plan.py --start 2026-04 --only 彩椒,牛番茄,高麗菜,敏豆
  python3 annual_plan.py --start 2026-04 --per-crop      # 只看各作物最佳定植月
"""

import argparse
import json
import os
import sys
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
TURNAROUND = 20  # 換茬整地/消毒緩衝天數


def load_crops(only=None):
    with open(os.path.join(HERE, "crops.json"), encoding="utf-8") as f:
        data = json.load(f)["作物"]
    if only:
        data = {k: v for k, v in data.items() if k in only}
    return data


def add_days(d, n):
    return d + timedelta(days=n)


def harvest_months(plant, grow, dur):
    """回傳採收期間涵蓋的月份 list（1-12）。"""
    start = add_days(plant, grow)
    end = add_days(start, dur)
    months, cur = [], start
    while cur <= end:
        if cur.month not in months:
            months.append(cur.month)
        cur = add_days(cur, 15)
    return months, start, end


def avg_price_index(crop, plant):
    idx = crop.get("月價指數")
    if not idx:
        return 1.0, None, None
    months, start, end = harvest_months(
        plant, crop["生育天數_定植到初採"], crop["採收持續天數"])
    score = sum(idx[m - 1] for m in months) / len(months)
    return score, start, end


def light(score):
    if score >= 1.15:
        return "🟢 高價"
    if score <= 0.9:
        return "🔴 低價"
    return "🟡 普通"


def per_crop_report(crops):
    print("=== 各作物最佳定植月（採收落在高價月）===")
    for name, c in crops.items():
        print(f"\n【{name}】科別:{c.get('科別','?')} 生育{c['生育天數_定植到初採']}天 "
              f"採收{c['採收持續天數']}天")
        rows = []
        for m in range(1, 13):
            plant = date(2026, m, 1)
            score, hs, he = avg_price_index(c, plant)
            rows.append((m, score, hs, he))
        rows.sort(key=lambda r: r[1], reverse=True)
        print(f"  {'定植月':>6}{'採收期':>22}{'價位分數':>10}{'':>4}")
        for m, score, hs, he in rows[:4]:
            span = f"{hs.strftime('%m/%d')}~{he.strftime('%m/%d')}"
            print(f"  {m:>5}月{span:>22}{score:>10.2f}  {light(score)}")


def plan_zone(crops, start_month, horizon_days=400):
    """貪婪排一整年輪種。"""
    start = date(start_month.year, start_month.month, 1)
    end_limit = add_days(start, horizon_days)
    pos = start
    prev_family = None
    plan = []

    while pos < end_limit:
        best = None  # (score, crop_name, plant_date, hs, he)
        for name, c in crops.items():
            if c.get("科別") == prev_family:
                continue  # 輪作: 不連作同科
            # 允許延後定植 0~45 天以卡更好的價位窗
            for delay in range(0, 46, 15):
                plant = add_days(pos, delay)
                score, hs, he = avg_price_index(c, plant)
                # 微罰空置天數，避免無謂等待
                adj = score - delay * 0.001
                if best is None or adj > best[0]:
                    best = (adj, score, name, plant, hs, he)
        if best is None:
            break
        _, score, name, plant, hs, he = best
        plan.append((name, crops[name].get("科別"), plant, hs, he, score))
        prev_family = crops[name].get("科別")
        pos = add_days(he, TURNAROUND)  # 換茬緩衝

    return plan


def print_plan(plan):
    print("\n=== 建議年度輪種時間表（單一畦區）===")
    print(f"{'輪次':>4}  {'作物':<8}{'科別':<8}{'定植日':<12}{'採收期':<24}{'價位':>8}")
    total = 0
    for i, (name, fam, plant, hs, he, score) in enumerate(plan, 1):
        span = f"{hs.strftime('%Y-%m-%d')}~{he.strftime('%m-%d')}"
        print(f"{i:>4}  {name:<8}{fam or '?':<8}{plant.strftime('%Y-%m-%d'):<12}"
              f"{span:<24}{score:>6.2f}{light(score)[:2]}")
        total += score
    if plan:
        print(f"\n平均價位分數: {total/len(plan):.2f}"
              f"（>1.15 表多數收成卡在高價區間）")
        fams = [p[1] for p in plan]
        ok = all(fams[i] != fams[i+1] for i in range(len(fams)-1))
        print(f"輪作檢查: {'✅ 相鄰輪次不同科，符合輪作' if ok else '⚠️ 有連作同科'}")


def main():
    ap = argparse.ArgumentParser(description="一年輪種規劃器")
    ap.add_argument("--start", required=True, help="起始月 YYYY-MM")
    ap.add_argument("--only", default="", help="限定作物，逗號分隔")
    ap.add_argument("--per-crop", action="store_true", help="只列各作物最佳定植月")
    args = ap.parse_args()

    only = [s.strip() for s in args.only.split(",") if s.strip()] or None
    crops = load_crops(only)
    if not crops:
        print("[錯誤] 沒有符合的作物", file=sys.stderr)
        sys.exit(1)

    try:
        y, m = args.start.split("-")
        start_month = date(int(y), int(m), 1)
    except Exception:
        print("[錯誤] --start 格式須為 YYYY-MM", file=sys.stderr)
        sys.exit(1)

    if args.per_crop:
        per_crop_report(crops)
        return

    per_crop_report(crops)
    plan = plan_zone(crops, start_month)
    print_plan(plan)
    print("\n⚠️ 月價指數為示範值。請用 fetch_amis.py + analyze_market.py 撈信義鄉"
          "常送市場的實際歷史行情，替換 crops.json 的『月價指數』後再規劃。")


if __name__ == "__main__":
    main()
