#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_amis.py — 抓取農業部「農產品交易行情」開放資料並做基礎季節分析

資料來源（農業部農業資料開放平臺）:
  https://data.moa.gov.tw/Service/OpenData/FromM/FarmTransData.aspx
  欄位: 交易日期(民國年 115.07.15)、種類代碼、作物代號、作物名稱、
        市場代號、市場名稱、上價、中價、下價、平均價、交易量

只用 Python 標準函式庫（urllib），不需 pip 安裝任何套件。

用法範例:
  # 抓 2026/06/01~2026/07/18 的「牛番茄」行情，輸出 CSV 並印月統計
  python3 fetch_amis.py --crop 牛番茄 --start 2026-06-01 --end 2026-07-18 --csv out.csv

  # 指定市場（例如台北一市），可多次 --market
  python3 fetch_amis.py --crop 甜椒 --start 2026-01-01 --end 2026-12-31

注意:
  - 本 API 日期參數採「民國年」格式（YYYY.MM.DD，年份為西元-1911），
    腳本會自動把你輸入的西元日期轉成民國年。
  - 若在受限網路（如某些雲端環境）執行可能被擋，請於自己的電腦/伺服器執行。
"""

import argparse
import csv
import json
import ssl
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date, datetime

API_URL = "https://data.moa.gov.tw/Service/OpenData/FromM/FarmTransData.aspx"


def to_roc(d: date) -> str:
    """西元 date -> 民國年字串 YYYY.MM.DD（API 需要的格式）。"""
    return f"{d.year - 1911:03d}.{d.month:02d}.{d.day:02d}"


def roc_to_iso(roc: str) -> str:
    """民國年 '115.07.15' -> 西元 '2026-07-15'。"""
    try:
        y, m, dd = roc.strip().split(".")
        return f"{int(y) + 1911:04d}-{int(m):02d}-{int(dd):02d}"
    except Exception:
        return roc


def fetch(crop: str, start: date, end: date, market: str = "") -> list:
    """呼叫 API 取得交易行情紀錄（list of dict）。"""
    params = {
        "Start_time": to_roc(start),
        "End_time": to_roc(end),
        "CropName": crop,
    }
    if market:
        params["MarketName"] = market
    url = API_URL + "?" + urllib.parse.urlencode(params, encoding="utf-8")

    req = urllib.request.Request(url, headers={"User-Agent": "farm-assistant/1.0"})
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=60, context=ctx) as resp:
        raw = resp.read().decode("utf-8-sig")
    data = json.loads(raw)
    # API 直接回傳 list；有些版本包在 dict 裡，兩者都容錯處理
    if isinstance(data, dict):
        for key in ("Data", "data", "result"):
            if key in data and isinstance(data[key], list):
                return data[key]
        return []
    return data if isinstance(data, list) else []


def num(x):
    try:
        return float(str(x).replace(",", ""))
    except Exception:
        return None


def monthly_summary(rows: list) -> dict:
    """依『西元年-月』彙總：平均均價、總交易量、天數。"""
    buckets = defaultdict(lambda: {"price_sum": 0.0, "price_n": 0, "vol": 0.0, "days": 0})
    for r in rows:
        iso = roc_to_iso(r.get("交易日期", ""))
        ym = iso[:7] if len(iso) >= 7 else "unknown"
        avg = num(r.get("平均價"))
        vol = num(r.get("交易量")) or 0.0
        b = buckets[ym]
        if avg is not None:
            b["price_sum"] += avg
            b["price_n"] += 1
        b["vol"] += vol
        b["days"] += 1
    out = {}
    for ym, b in sorted(buckets.items()):
        avg = b["price_sum"] / b["price_n"] if b["price_n"] else None
        out[ym] = {"avg_price": avg, "total_volume": b["vol"], "records": b["days"]}
    return out


def main():
    ap = argparse.ArgumentParser(description="抓取農產品交易行情並做月統計")
    ap.add_argument("--crop", required=True, help="作物名稱，例如 牛番茄 / 甜椒")
    ap.add_argument("--start", required=True, help="起始日期 西元 YYYY-MM-DD")
    ap.add_argument("--end", required=True, help="結束日期 西元 YYYY-MM-DD")
    ap.add_argument("--market", default="", help="市場名稱（可省略）")
    ap.add_argument("--csv", default="", help="輸出明細 CSV 檔名（可省略）")
    args = ap.parse_args()

    start = datetime.strptime(args.start, "%Y-%m-%d").date()
    end = datetime.strptime(args.end, "%Y-%m-%d").date()

    try:
        rows = fetch(args.crop, start, end, args.market)
    except Exception as e:
        print(f"[錯誤] 抓取失敗: {e}", file=sys.stderr)
        print("  常見原因: 網路被限制、日期區間太大、或 API 暫時無回應。", file=sys.stderr)
        sys.exit(1)

    print(f"共取得 {len(rows)} 筆『{args.crop}』交易紀錄 "
          f"（{args.start} ~ {args.end}）")

    if args.csv and rows:
        fields = ["交易日期", "作物代號", "作物名稱", "市場代號", "市場名稱",
                  "上價", "中價", "下價", "平均價", "交易量"]
        with open(args.csv, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
            w.writeheader()
            for r in rows:
                w.writerow(r)
        print(f"已輸出明細至 {args.csv}")

    # 月統計（估算爛價/旺季用）
    summary = monthly_summary(rows)
    if summary:
        print("\n=== 月統計（平均均價 元/公斤、總交易量 公斤）===")
        print(f"{'月份':<9}{'平均均價':>10}{'總交易量':>14}{'筆數':>8}")
        for ym, s in summary.items():
            ap_ = f"{s['avg_price']:.1f}" if s["avg_price"] is not None else "-"
            print(f"{ym:<9}{ap_:>10}{s['total_volume']:>14,.0f}{s['records']:>8}")

        # 標出最高/最低價月份（估旺季/爛價期）
        priced = {k: v["avg_price"] for k, v in summary.items() if v["avg_price"]}
        if priced:
            hi = max(priced, key=priced.get)
            lo = min(priced, key=priced.get)
            print(f"\n📈 最高價月: {hi} ({priced[hi]:.1f} 元/公斤) — 旺季/高價空窗參考")
            print(f"📉 最低價月: {lo} ({priced[lo]:.1f} 元/公斤) — 爛價期，避開此時採收")


if __name__ == "__main__":
    main()
