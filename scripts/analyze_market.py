#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
analyze_market.py — 對行情資料做進階分析

吃 fetch_amis.py 產出的 CSV（欄位含 交易日期(民國年)、市場名稱、平均價、交易量），
產出:
  1. 多市場比價     — 各市場平均均價與交易量，找送哪個市場最好
  2. 季節指數       — 每月歷年平均價 / 全期平均，>1 旺季、<1 淡季
  3. 去年同期比較   — 同月今年 vs 去年，看漲跌
  4. 移動平均趨勢   — 近期價格方向
  5. 種植紅黃綠燈   — 依「定植後約 N 天採收落在哪個價格帶」給燈號

零套件依賴，只用 Python 3 標準函式庫。

用法:
  python3 analyze_market.py 牛番茄.csv --grow-days 60
  python3 analyze_market.py 甜椒.csv --grow-days 90 --market-report
"""

import argparse
import csv
import statistics
import sys
from collections import defaultdict


def roc_to_iso(roc: str) -> str:
    try:
        y, m, d = roc.strip().split(".")
        return f"{int(y) + 1911:04d}-{int(m):02d}-{int(d):02d}"
    except Exception:
        return roc


def num(x):
    try:
        return float(str(x).replace(",", ""))
    except Exception:
        return None


def load(paths):
    rows = []
    for p in paths:
        with open(p, newline="", encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                iso = roc_to_iso(r.get("交易日期", ""))
                r["_iso"] = iso
                r["_ym"] = iso[:7]
                r["_month"] = iso[5:7]
                r["_year"] = iso[:4]
                r["_price"] = num(r.get("平均價"))
                r["_vol"] = num(r.get("交易量")) or 0.0
                rows.append(r)
    return rows


def market_report(rows):
    agg = defaultdict(lambda: {"p": [], "v": 0.0})
    for r in rows:
        if r["_price"] is not None:
            agg[r.get("市場名稱", "?")]["p"].append(r["_price"])
            agg[r.get("市場名稱", "?")]["v"] += r["_vol"]
    print("\n=== 多市場比價（平均均價 元/公斤、總交易量 公斤）===")
    print(f"{'市場':<12}{'平均均價':>10}{'總交易量':>14}{'筆數':>8}")
    ranked = sorted(agg.items(), key=lambda kv: statistics.mean(kv[1]["p"]), reverse=True)
    for name, a in ranked:
        avg = statistics.mean(a["p"])
        print(f"{name:<12}{avg:>10.1f}{a['v']:>14,.0f}{len(a['p']):>8}")
    if ranked:
        print(f"\n💰 均價最高市場: {ranked[0][0]}（{statistics.mean(ranked[0][1]['p']):.1f} 元/公斤）"
              f" — 但別忘了扣運費再比")


def seasonal_index(rows):
    by_month = defaultdict(list)
    for r in rows:
        if r["_price"] is not None and r["_month"]:
            by_month[r["_month"]].append(r["_price"])
    if not by_month:
        return
    overall = statistics.mean([p for ps in by_month.values() for p in ps])
    print(f"\n=== 季節指數（全期平均 {overall:.1f} 元/公斤；指數>1 旺季、<1 淡季）===")
    print(f"{'月':>4}{'月均價':>10}{'季節指數':>10}{'':>4}")
    rows_out = []
    for m in sorted(by_month):
        mp = statistics.mean(by_month[m])
        idx = mp / overall if overall else 0
        tag = "📈旺" if idx >= 1.1 else ("📉淡" if idx <= 0.9 else "－")
        rows_out.append((m, mp, idx, tag))
        print(f"{m:>4}{mp:>10.1f}{idx:>10.2f}  {tag}")
    return rows_out


def yoy(rows):
    by_ym = defaultdict(list)
    for r in rows:
        if r["_price"] is not None:
            by_ym[r["_ym"]].append(r["_price"])
    ym_avg = {k: statistics.mean(v) for k, v in by_ym.items()}
    pairs = []
    for ym, avg in sorted(ym_avg.items()):
        year, mon = ym[:4], ym[5:7]
        prev = f"{int(year)-1:04d}-{mon}"
        if prev in ym_avg:
            diff = (avg - ym_avg[prev]) / ym_avg[prev] * 100
            pairs.append((ym, avg, ym_avg[prev], diff))
    if pairs:
        print("\n=== 去年同期比較 ===")
        print(f"{'月份':<9}{'今年':>8}{'去年':>8}{'漲跌%':>9}")
        for ym, cur, pv, diff in pairs:
            arrow = "▲" if diff > 0 else ("▼" if diff < 0 else "－")
            print(f"{ym:<9}{cur:>8.1f}{pv:>8.1f}{diff:>8.1f}%{arrow}")


def moving_average(rows, window=4):
    by_ym = defaultdict(list)
    for r in rows:
        if r["_price"] is not None:
            by_ym[r["_ym"]].append(r["_price"])
    series = [(k, statistics.mean(v)) for k, v in sorted(by_ym.items())]
    if len(series) >= window:
        recent = [p for _, p in series[-window:]]
        ma = statistics.mean(recent)
        last = series[-1][1]
        trend = "上升↑" if last > ma else ("下降↓" if last < ma else "持平→")
        print(f"\n=== 近 {window} 月移動平均 ===")
        print(f"移動平均 {ma:.1f} 元/公斤；最新月 {last:.1f} → 趨勢 {trend}")


def planting_light(seasonal, grow_days):
    """依季節指數，給每個『定植月』對應的採收月燈號。"""
    if not seasonal:
        return
    idx_by_month = {m: idx for m, mp, idx, tag in seasonal}
    offset = round(grow_days / 30)  # 約略幾個月後採收
    print(f"\n=== 種植紅黃綠燈（生育約 {grow_days} 天 ≈ {offset} 個月後採收）===")
    print(f"{'定植月':>6}{'→採收月':>8}{'採收季節指數':>14}{'建議':>8}")
    for m in range(1, 13):
        harvest = (m - 1 + offset) % 12 + 1
        hm = f"{harvest:02d}"
        idx = idx_by_month.get(hm)
        if idx is None:
            light = "資料不足"
        elif idx >= 1.1:
            light = "🟢 好價，建議種"
        elif idx <= 0.9:
            light = "🔴 爛價，避開"
        else:
            light = "🟡 普通"
        idx_s = f"{idx:.2f}" if idx is not None else "-"
        print(f"{m:>5}月{hm:>7}月{idx_s:>14}   {light}")


def main():
    ap = argparse.ArgumentParser(description="行情進階分析")
    ap.add_argument("csv", nargs="+", help="fetch_amis.py 產出的 CSV（可多檔）")
    ap.add_argument("--grow-days", type=int, default=60,
                    help="定植到採收天數（牛番茄約60、彩椒約90）")
    ap.add_argument("--market-report", action="store_true", help="顯示多市場比價")
    args = ap.parse_args()

    try:
        rows = load(args.csv)
    except FileNotFoundError as e:
        print(f"[錯誤] 找不到檔案: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"載入 {len(rows)} 筆行情紀錄")
    if args.market_report:
        market_report(rows)
    seasonal = seasonal_index(rows)
    yoy(rows)
    moving_average(rows)
    planting_light(seasonal, args.grow_days)


if __name__ == "__main__":
    main()
