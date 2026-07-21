# 農務小幫手 App（PWA）

信義鄉高冷地溫室的手機 App，可**安裝到手機主畫面、離線使用**。純前端、無需伺服器、無需帳號，資料存在你自己的手機瀏覽器（localStorage）。

## 功能

| 分頁 | 功能 |
|---|---|
| ✅ 今日 | 依你的田區自動產生當日待辦，可逐項打勾（狀態記憶） |
| 🌱 田區 | 新增/刪除種植紀錄（畦區、作物、定植日、株數） |
| 🧮 計算 | 輸入作物+定植日+株數 → 採收日、肥料需求、作業排程 |
| 📅 規劃 | 從起始月排全年輪種，收成卡高價月 + 輪作檢查 |

作物知識庫（6 種：牛番茄、彩椒、玉女番茄、高山草莓、高麗菜、敏豆）與 `scripts/crops.json` 同源，數值為示範值，請經**台中區農業改良場**校正。

## 檔案

- `index.html` — App 本體（自帶樣式與邏輯，單檔可獨立運作）
- `manifest.webmanifest` — PWA 設定（名稱、圖示、主題色）
- `sw.js` — Service Worker（離線快取）
- `icon.svg` — App 圖示

## 怎麼用

### 最簡單：直接開
把 `index.html` 用手機瀏覽器開啟即可使用（田區/待辦/計算/規劃都能用）。

### 安裝成 App（需經 https 或 localhost）
PWA 的安裝與離線功能需要透過網頁伺服器（https 或 localhost）提供，不能用 `file://` 直接開。

本機測試：
```bash
cd app
python3 -m http.server 8000
# 手機與電腦同網段時，用手機瀏覽器開 http://<電腦IP>:8000
```

免費上線（擇一）：
- **GitHub Pages**：把 `app/` 內容推到 Pages，取得 https 網址
- **Netlify / Cloudflare Pages**：拖曳 `app/` 資料夾即部署

開啟後：
- iPhone Safari：分享 → 加入主畫面
- Android Chrome：選單 → 安裝應用程式 / 加到主畫面

安裝後有 App 圖示、全螢幕、離線可用。

## 與 scripts/ 工具的關係

`app/` 是給**現場每天用**的手機介面；`scripts/` 是給**電腦端**做資料抓取與批次分析（如 `fetch_amis.py` 撈真實行情）。兩者共用同一套作物知識與計算邏輯。
