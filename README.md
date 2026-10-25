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
