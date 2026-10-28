# 出差報帳 Business Trip Expenses (v1)

iPhone-first PWA for Butterfly Network Taiwan business-trip expense reports.
Fully static: no backend, no accounts. All data (trips, expenses, receipt photos) stays in the
browser's IndexedDB on the device. Settings in localStorage.

## Use
1. Open the site in Safari → Share → 加入主畫面 (Add to Home Screen).
2. 新增出差 (destination, dates) → set exchange rates (💱).
3. During the trip: 📷 拍收據 or 🖼️ 相簿／截圖 → on-device OCR pre-fills date / merchant / currency / amount → confirm → 儲存.
4. After the card statement posts: 💳 填刷卡實扣台幣 (actual NTD incl. foreign-transaction fee overrides the estimate; Rate = NTD ÷ amount).
5. 📤 匯出: company xlsx (PRETECH_BET layout, plain numbers, no formulas) + receipts zip named by item No.
6. 💾 Backup / restore JSON (Settings → 備份全部 / 從備份檔還原).

## Files
- `index.html`, `styles.css`, `manifest.webmanifest`, `sw.js`, `icons/`
- `js/app.js` UI + router · `js/db.js` IndexedDB · `js/policy.js` policy rules · `js/ocr.js` Tesseract + parsing · `js/image.js` photo compression · `js/export.js` xlsx / zip / backup
- `assets/template_blank.xlsx` – blank company form (items, names, employee no. and file paths stripped)
- `vendor/` – ExcelJS 4.4 (MIT), JSZip 3 (MIT/GPLv3), Tesseract.js 5 + core (Apache-2.0), tessdata 4.0.0_best_int (Apache-2.0): eng, chi_sim, chi_tra, tha

## Hosting
Any static host over HTTPS (service worker + camera need HTTPS). No server code. Bump `VERSION` in `sw.js` on each deploy so phones pick up the update.

## Policy rules implemented (T&E Policy 2026-03-17 + Taiwan process)
60-day deadline from earliest expense date · receipt required > USD 50 · own meals ≤ USD 150/day (shared meals counted per head) ·
air: < 5h legs economy only, premium economy needs written pre-approval; business/first and > USD 4,000 need ELT approval ·
hotel guideline USD 200–300/night, > USD 650 needs manager approval · shared meals list attendees, senior attendee pays · personal items never exported.

## 介面語言（v1.3.0）
- 繁體中文／English，首頁右上角與設定頁皆可切換，選擇存在 localStorage（`bt-lang`）；第一次開啟依瀏覽器語言。
- 所有介面文字集中在 `js/i18n.js`（`TABLE`：key／繁中／English）。新增文字請加 key，不要把字串寫進其他檔。
- 類別（`Air ticket` 等）與付款方式（`信用卡` 等）以代碼存入資料，顯示時才用 `catLabel()`／`payLabel()` 翻譯；匯出的 Excel 內容不隨語言改變。

## 版本與更新（v1.3.1）
- 版號：`js/version.js`（`APP_VERSION`），設定頁「關於」會顯示版號與已安裝的 service worker 快取版本；兩者不同代表畫面還是舊版，按「更新到最新版」（不會刪資料）。
- service worker 對 app 檔案改為「網路優先」（`cache: 'no-cache'`），離線或網路慢（> 4 秒）才用快取；新版接手後會自動重新載入（編輯中只提示）。發版時請同步改 `sw.js` 的 `VERSION` 與 `js/version.js`（`tests/version.test.mjs` 會檢查）。
- 照片失敗時畫面會留下錯誤面板（步驟＋錯誤名稱），設定頁可複製「診斷記錄」。

## 匯出格式（v1.3.2）
- 匯出的 xlsx 直接填 `assets/template_blank.xlsx` 的 XML（`js/xlsxfill.js`），不再用 ExcelJS 讀寫整份檔案（已從 index.html／sw.js 移除；`vendor/exceljs.min.js` 可刪）。抬頭、合併儲存格、欄寬、字型、框線、數字格式、列高、列印設定全部沿用模板；只填資料並插入明細列／NOTES，下方簽核區整段下移。
- 檔名：`出差名稱_YYYYMMDD.xlsx`（YYYYMMDD＝出差開始日；zip 為 `…_receipts.zip`）。
- Google Sheets：上傳到 Google 雲端硬碟後「用 Google 試算表開啟」即可；Mac 的 Excel／Numbers／預覽程式也可開。

## v1.3.3：分頁名稱與收據簡報
- Excel 分頁名稱＝出差名稱（≤31 字元，去掉 `\ / ? * [ ] :`），不再出現 PRETECH_BET。
- 按「產生公司 Excel ＋ 收據簡報」時，同時在手機上產生 `出差名稱_YYYYMMDD.pptx`（`js/pptxgen.js`，不需 Google 登入／API）：第 1 頁封面（出差名稱＋日期區間），之後每張照片一頁，照片等比例放到最大，頁面寫日期、類別、金額、幣別、說明。上傳到 Google 雲端硬碟後用 Google 簡報開啟。
- 只含公務費用且有照片者，順序與 Excel 的 No. 相同；沒有照片時不產生簡報（Excel 照常）。
