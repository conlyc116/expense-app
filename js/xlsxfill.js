// 直接在公司模板（assets/template_blank.xlsx）的 XML 上填值來產生 xlsx。
// 為什麼不再用 ExcelJS 讀整份模板再重寫：整份重寫（尤其 insertRows＋複製樣式）會讓結構、樣式、列高跑掉，
// 而且無法在 node／沙盒驗證。這裡只改「儲存格內容」和「插入明細／NOTES 列」，其餘（合併儲存格、欄寬、字型、
// 框線、數字格式、列高、列印設定）逐位元沿用模板。純函式，node 可直接測；瀏覽器只需要 vendor/jszip.min.js。
//
// 版面（與公司既有報帳單一致，座標以模板為準）：
//   1–3 抬頭（A:H 合併） 4–7 員工／目的地／期間   8 表頭
//   9…(8+n)  n 筆明細（以模板第 9 列為樣板複製）
//   (9+n)    一列空白（模板第 10 列）           (10+n) Total 列（模板第 11 列：G='Total'、H=總額）
//   Total 下一列起：NOTES: 與各條說明（插入，原本第 12 列以後的簽核區／備註整段往下移）
// 全部是「算好的數字／文字」，沒有任何公式。

const pad = (n) => String(n).padStart(2, '0');
const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
const escXml = (s) => String(s).replace(XML_BAD, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colNum = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

export const SHEET_PATH = 'xl/worksheets/sheet1.xml';
export const WORKBOOK_PATH = 'xl/workbook.xml';
export const RELS_PATH = 'xl/_rels/workbook.xml.rels';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// 模板用到的樣式編號（xl/styles.xml 的 cellXfs），見 tests/xlsx.test.mjs 的逐項檢查
export const STYLE = { no: 18, date: 19, text: 20, plain: 21, rate: 33, ntd: 20, check: 17, notesHead: 5, notes: 2 };

export const excelSerial = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); if (!m) return null;
  return Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000);
};
const fmtDate = (s) => (s ? s.replace(/-/g, '/') : '');

// 檔名：出差名稱_YYYYMMDD（YYYYMMDD = 出差開始日）。拿掉檔名不能用的字元；逗號／空白改成 -
export function safeName(s, fallback = 'Trip') {
  const x = String(s || '').replace(/[\u0000-\u001F\\/:*?"<>|]+/g, '').replace(/[,\s]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40).replace(/[-.]+$/g, '');
  return x || fallback;
}
export function exportFileName(trip, ext = 'xlsx', suffix = '') {
  const d = (trip && trip.from ? String(trip.from) : '').replace(/-/g, '');
  const day = /^\d{8}$/.test(d) ? d : (() => { const n = new Date(); return `${n.getFullYear()}${pad(n.getMonth() + 1)}${pad(n.getDate())}`; })();
  return `${safeName(trip && trip.destination)}_${day}${suffix}.${ext}`;
}

// ---------- 列／儲存格操作（字串層級，不依賴 DOMParser）----------
function parseRows(sheetXml) {
  const a = sheetXml.indexOf('<sheetData>'); const b = sheetXml.indexOf('</sheetData>');
  if (a < 0 || b < 0) throw new Error('template: no sheetData');
  const head = sheetXml.slice(0, a); const tail = sheetXml.slice(b + '</sheetData>'.length);
  const rows = new Map(); const re = /<row r="(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g; let m;
  const body = sheetXml.slice(a + '<sheetData>'.length, b);
  while ((m = re.exec(body))) rows.set(+m[1], { attrs: m[2], inner: m[3] || '' });
  return { head, tail, rows };
}
const rowXml = (r, row) => `<row r="${r}"${row.attrs}>${row.inner}</row>`;
const renumber = (row, r) => ({ attrs: row.attrs, inner: row.inner.replace(/<c r="([A-Z]+)\d+"/g, `<c r="$1${r}"`) });
const withHeight = (row, ht) => ({ ...row, attrs: row.attrs.replace(/ht="[^"]*"/, `ht="${ht}"`) });

// 設定儲存格：spec = { v, s }；v 為 number → 數值；string → inlineStr；null → 清空（保留樣式）
function setCell(row, col, r, spec) {
  const addr = `${col}${r}`;
  const re = new RegExp(`<c r="${addr}"([^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
  const m = row.inner.match(re);
  const sOld = m ? (/\ss="(\d+)"/.exec(m[1]) || [])[1] : undefined;
  const s = spec.s !== undefined ? spec.s : sOld;
  const sAttr = s !== undefined ? ` s="${s}"` : '';
  let xml;
  if (spec.v === null || spec.v === undefined || (typeof spec.v === 'number' && !Number.isFinite(spec.v))) xml = `<c r="${addr}"${sAttr}/>`;
  else if (typeof spec.v === 'number') xml = `<c r="${addr}"${sAttr}><v>${String(spec.v)}</v></c>`;
  else xml = `<c r="${addr}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${escXml(String(spec.v).replace(/\r?\n/g, ' '))}</t></is></c>`;
  if (m) { row.inner = row.inner.replace(re, () => xml); return; }
  // 沒有這格：依欄位順序插入
  const cells = [...row.inner.matchAll(/<c r="([A-Z]+)\d+"/g)];
  const after = cells.find((c) => colNum(c[1]) > colNum(col));
  if (after) row.inner = row.inner.slice(0, after.index) + xml + row.inner.slice(after.index); else row.inner += xml;
}

// ---------- 填 sheet1.xml ----------
export function fillSheetXml(sheetXml, d) {
  const { head, tail, rows } = parseRows(sheetXml);
  const get = (r) => { const x = rows.get(r); if (!x) throw new Error(`template: missing row ${r}`); return x; };
  const items = d.items || []; const n = items.length; const N = Math.max(n, 1);
  const notes = d.notes || [];

  const out = []; // [r, row]
  // 1–8：抬頭、員工資訊、表頭
  for (let r = 1; r <= 8; r++) {
    const row = { ...get(r) };
    if (r === 4 && d.empNo) setCell(row, 'A', r, { v: `Employee Number: ${d.empNo}` });
    if (r === 5 && d.empName) setCell(row, 'A', r, { v: `Employee Name: ${d.empName}` });
    if (r === 6) setCell(row, 'A', r, { v: `Destination: ${d.destination || ''}` });
    if (r === 7) setCell(row, 'A', r, { v: `Period: From ${fmtDate(d.from)} to ${fmtDate(d.to)}` });
    out.push([r, row]);
  }
  // 明細：以模板第 9 列為樣板
  const proto = get(9);
  for (let i = 0; i < N; i++) {
    const r = 9 + i; const row = renumber(withHeight(proto, 30), r); const it = items[i];
    if (it) {
      setCell(row, 'A', r, { v: it.no });
      setCell(row, 'B', r, { v: excelSerial(it.date) });
      setCell(row, 'C', r, { v: it.category });
      setCell(row, 'D', r, { v: it.desc });
      setCell(row, 'E', r, { v: it.currency });
      setCell(row, 'F', r, { v: it.amount });
      // Rate 欄寬只有 6.33：模板第 9 列用 0.0000（<10 的匯率放得下，如 4.6667）；匯率 ≥10（USD、SGD…）四位小數會顯示 ###，改用模板同欄的 General 樣式（Excel 會自動依欄寬取位）
      setCell(row, 'G', r, { v: it.rate, s: Math.abs(it.rate) < 10 ? STYLE.rate : STYLE.plain });
      setCell(row, 'H', r, { v: it.ntd });
      if (d.checkMarks !== false && it.check) setCell(row, 'I', r, { v: it.check, s: STYLE.check });
    } else setCell(row, 'G', r, { v: null, s: STYLE.rate });
    out.push([r, row]);
  }
  // 空白列＋Total 列（模板第 10、11 列）
  const blankR = 9 + N; const totalR = 10 + N;
  out.push([blankR, renumber(get(10), blankR)]);
  const tot = renumber(get(11), totalR);
  setCell(tot, 'G', totalR, { v: 'Total' });
  setCell(tot, 'H', totalR, { v: d.total });
  out.push([totalR, tot]);
  // NOTES：Total 下一列起插入；原第 12 列以後整段下移
  let next = totalR + 1;
  if (notes.length) {
    const noteProto = get(13);
    const mk = (text, s) => { const row = renumber(withHeight(noteProto, 18), next); setCell(row, 'A', next, { v: text, s }); out.push([next, row]); next++; };
    mk('NOTES:', STYLE.notesHead);
    for (const t of notes) mk(t, STYLE.notes);
  }
  const lastTemplate = Math.max(...rows.keys());
  for (let r = 12; r <= lastTemplate; r++) { if (rows.has(r)) { out.push([next, renumber(get(r), next)]); } next++; }
  const maxRow = next - 1;

  let h = head.replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:Z${maxRow}"/>`);
  // 檢視狀態：模板存檔時停在 A14、放大 163%，開啟時看起來像「版面跑掉」→ 回到 A1、100%
  h = h.replace(/<sheetViews>[\s\S]*?<\/sheetViews>/, '<sheetViews><sheetView tabSelected="1" workbookViewId="0"><selection activeCell="A1" sqref="A1"/></sheetView></sheetViews>');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + h + '<sheetData>' + out.map(([r, row]) => rowXml(r, row)).join('') + '</sheetData>' + tail;
}

// ---------- workbook.xml／rels 修正 ----------
// 模板的 workbookView 帶 minimized="1"（視窗最小化）、視窗尺寸異常、fullCalcOnLoad（沒有公式卻每次重算）。
// 分頁名稱：用出差名稱；Excel 不允許 \ / ? * [ ] :，不可空白、不可以 ' 開頭或結尾、最長 31 字元（UTF-16），也不能叫 History
export function sheetNameFor(trip) {
  let n = String((trip && trip.destination) || '').replace(/[\u0000-\u001F\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim();
  const cut = (s) => { let out = ''; for (const ch of s) { if ((out + ch).length > 31) break; out += ch; } return out; };
  n = cut(n).replace(/^['\s]+|['\s]+$/g, '');
  if (!n) n = 'Trip';
  if (n.toLowerCase() === 'history') n += '_';
  return n;
}
export function patchWorkbookXml(xml, sheetName) {
  return xml
    .replace(/(<sheet\b[^>]*?\bname=")[^"]*(")/, (m, a, b) => (sheetName ? a + escXml(sheetName) + b : m))
    .replace(/\sminimized="[^"]*"/, '')
    .replace(/xWindow="[^"]*"/, 'xWindow="0"').replace(/yWindow="[^"]*"/, 'yWindow="0"')
    .replace(/windowWidth="[^"]*"/, 'windowWidth="28800"').replace(/windowHeight="[^"]*"/, 'windowHeight="17000"')
    .replace(/\sfullCalcOnLoad="[^"]*"/, '');
}
// openpyxl 產的 rels 用絕對路徑（/xl/worksheets/…）；改成相對路徑，所有讀取器都能吃
export function patchRelsXml(xml) { return xml.replace(/Target="\/xl\//g, 'Target="'); }

// ---------- 組 zip ----------
export async function buildXlsxBytes(JSZip, templateBuf, data) {
  const zin = await JSZip.loadAsync(templateBuf);
  const read = async (p) => { const f = zin.file(p); if (!f) throw new Error(`template: missing ${p}`); return f.async('string'); };
  const files = {};
  for (const name of Object.keys(zin.files)) if (!zin.files[name].dir) files[name] = null;
  files[SHEET_PATH] = fillSheetXml(await read(SHEET_PATH), data);
  files[WORKBOOK_PATH] = patchWorkbookXml(await read(WORKBOOK_PATH), data.sheetName);
  files[RELS_PATH] = patchRelsXml(await read(RELS_PATH));
  const zout = new JSZip();
  // [Content_Types].xml 與 _rels 放最前面（OPC 慣例；部分讀取器——Apple 的預覽／Numbers——對順序較挑）
  const order = ['[Content_Types].xml', '_rels/.rels', ...Object.keys(files).filter((n) => n !== '[Content_Types].xml' && n !== '_rels/.rels')];
  for (const name of order) {
    if (!(name in files)) continue;
    zout.file(name, files[name] === null ? await zin.file(name).async('uint8array') : files[name], { compression: 'DEFLATE', createFolders: false });
  }
  return zout.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: XLSX_MIME });
}
