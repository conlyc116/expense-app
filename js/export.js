// Company xlsx export (ExcelJS keeps the template styling), receipts zip, JSON backup.
import { ntdOf, rateOf, curOf, attendeeList, amountOf, hasCard, CAT_ZH } from './policy.js';
import { get } from './db.js';
import { blobToDataURL } from './image.js';

const fmtDate = (s) => (s ? s.replace(/-/g, '/') : '');
const pad2 = (n) => String(n).padStart(2, '0');

export function exportItems(trip, expenses) {
  const order = { 'Air ticket': 0 };
  return expenses
    .filter((e) => e.business !== false)
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (order[a.category] ?? 1) - (order[b.category] ?? 1) || (a.createdAt || 0) - (b.createdAt || 0))
    .map((e, i) => {
      const nt = ntdOf(e, trip); const { ntd, actual } = nt;
      let desc = (e.description || '').trim();
      if (e.category === 'Meals' && e.shared) {
        const att = attendeeList(e);
        desc += `${desc ? ' ' : ''}(attendees: ${att.join(', ')}${e.seniorPays ? '; paid by senior attendee' : ''})`;
      }
      if (e.category === 'Air ticket' && e.cabin && e.cabin !== 'Economy' && !/premium|business|first/i.test(desc)) desc += `${desc ? ' ' : ''}(${e.cabin.toLowerCase()})`;
      if (e.category === 'Hotel' && e.nights && !/night/i.test(desc)) desc += `${desc ? ' / ' : ''}${e.nights} night${+e.nights > 1 ? 's' : ''}`;
      // 合併項（手續費／重複扣款／部分退款）：算式寫在 Description，金額欄只放算好的數字（規則：不用公式）
      const st = nt.settle || null;
      if (st && st.merged) desc += `${desc ? ' ' : ''}(${st.text})`;
      const cur = curOf(e);
      const est = cur !== 'NTD' && !actual && ntd !== null;
      if (est) desc += `${desc ? ' ' : ''}(est. rate)`;
      const check = hasCard(e) || (actual && cur !== 'NTD') ? 'v' : '';
      return { no: i + 1, e, ntd, actual, est, check, source: nt.source, settle: st, rate: rateOf(e, trip), amount: amountOf(e), currency: cur, desc };
    });
}

export function autoNotes(trip, items) {
  const notes = [];
  for (const it of items) {
    const e = it.e;
    if (e.category === 'Air ticket' && e.cabin && e.cabin !== 'Economy') notes.push(`Air ticket (No.${it.no}): ${e.cabin}${e.preApproval ? ' - written pre-approval attached' : ''}${e.note ? '; ' + e.note : ''}.`);
    if (e.category === 'Meals' && e.shared) notes.push(`No.${it.no}: shared meal with ${attendeeList(e).join(', ')}${e.seniorPays ? '; paid by senior attendee per policy' : ''}.`);
  }
  if (items.some((i) => i.actual && i.currency !== 'NTD')) notes.push('NTD = actual amount charged on card incl. foreign transaction fee (rate rule 1: card rate). Rate = NTD / original amount.');
  const est = items.filter((i) => !i.actual).map((i) => i.no);
  if (est.length) notes.push(`No. ${est.join(', ')}: NTD estimated with trip exchange rate (card charge not yet posted).`);
  (trip.notes || '').split('\n').map((s) => s.trim()).filter(Boolean).forEach((s) => notes.push(s));
  return notes.map((n, i) => `${i + 1}. ${n}`);
}

// 純資料模型（不碰 ExcelJS）：所有欄位都是「算好的數字／文字」，沒有任何公式。node 可直接測。
export function buildSheetModel(trip, expenses, settings = {}) {
  const items = exportItems(trip, expenses);
  const total = items.reduce((s, it) => s + (it.ntd || 0), 0);
  return { items, total, notes: autoNotes(trip, items), count: items.length };
}

const ORANGE = 'FFC65911';
const RATE_FMT = '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)'; // 與公司既有報帳單一致（2 位小數）

export async function buildXlsx(trip, expenses, settings = {}) {
  if (!window.ExcelJS) throw new Error('ExcelJS 尚未載入');
  const { items, total, notes } = buildSheetModel(trip, expenses, settings);
  const buf = await (await fetch('assets/template_blank.xlsx')).arrayBuffer();
  const wb = new window.ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('PRETECH_BET') || wb.worksheets[0];

  if (settings.empNo) ws.getCell('A4').value = `Employee Number: ${settings.empNo}`;
  if (settings.empName) ws.getCell('A5').value = `Employee Name: ${settings.empName}`;
  ws.getCell('A6').value = `Destination: ${trip.destination || ''}`;
  ws.getCell('A7').value = `Period: From ${fmtDate(trip.from)} to ${fmtDate(trip.to)}`;

  const n = items.length;
  if (n > 1) {
    ws.insertRows(10, Array.from({ length: n - 1 }, () => []), 'n');
    const proto = ws.getRow(9);
    for (let r = 10; r < 9 + n; r++) {
      const row = ws.getRow(r); row.height = proto.height || 30;
      for (let c = 1; c <= 9; c++) row.getCell(c).style = JSON.parse(JSON.stringify(proto.getCell(c).style || {}));
    }
  }
  const useChecks = settings.checkMarks !== false;
  items.forEach((it, i) => {
    const r = ws.getRow(9 + i);
    r.height = 30;
    const [y, m, d] = (it.e.date || '').split('-').map(Number);
    r.getCell(1).value = it.no;
    r.getCell(2).value = y ? new Date(Date.UTC(y, m - 1, d)) : null;
    r.getCell(3).value = it.e.category;
    r.getCell(4).value = it.desc;
    r.getCell(5).value = it.currency;
    r.getCell(6).value = it.amount;            // 原幣（合併項為扣掉退款後的淨額）
    r.getCell(7).value = it.rate;              // plain number (NTD / amount；估算時為使用的匯率)
    r.getCell(8).value = it.ntd;               // plain number, no formula
    r.getCell(7).numFmt = RATE_FMT;
    r.getCell(8).numFmt = '#,##0';
    if (it.est) for (const c of [7, 8]) { const cell = r.getCell(c); cell.font = Object.assign({}, cell.font, { color: { argb: ORANGE } }); }
    if (useChecks && it.check) { r.getCell(9).value = it.check; r.getCell(9).alignment = { horizontal: 'center', vertical: 'middle' }; }
  });
  const totalRow = 9 + Math.max(n, 1) + 1;   // one blank bordered row between items and total
  ws.getCell(`G${totalRow}`).value = 'Total';
  ws.getCell(`H${totalRow}`).value = total;  // plain number, no formula
  ws.getCell(`H${totalRow}`).numFmt = '#,##0';
  for (const col of ['G', 'H']) ws.getCell(`${col}${totalRow}`).font = { name: 'Times New Roman', size: 12, bold: true };

  if (notes.length) {
    const at = totalRow + 1;                 // NOTES 緊接在 Total 下一列（與公司既有報帳單一致）
    ws.insertRows(at, [['NOTES:'], ...notes.map((t) => [t])], 'n');
    for (let r = at; r <= at + notes.length; r++) {
      const c = ws.getCell(`A${r}`); c.font = { name: 'Times New Roman', size: 12, bold: r === at }; ws.getRow(r).height = 18;
    }
  }
  const out = await wb.xlsx.writeBuffer();
  const fname = `PRETECH_BET_${(trip.from || '').replace(/-/g, '')}${trip.destination ? '_' + trip.destination.replace(/[\\/:*?"<>|,\s-]+/g, '-').slice(0, 30) : ''}.xlsx`;
  return { blob: new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name: fname, total, count: n };
}

export async function buildReceiptsZip(trip, expenses) {
  const items = exportItems(trip, expenses);
  const zip = new window.JSZip();
  let count = 0;
  for (const it of items) {
    const ids = it.e.photos || [];
    for (let k = 0; k < ids.length; k++) {
      const p = await get('photos', ids[k]); if (!p) continue;
      zip.file(`${pad2(it.no)}${ids.length > 1 ? '-' + (k + 1) : ''}_${it.e.date || 'nodate'}_${it.e.category.replace(/\s+/g, '-')}.jpg`, p.blob);
      count++;
    }
  }
  const list = items.map((it) => `${pad2(it.no)}\t${it.e.date || ''}\t${it.e.category}\t${it.desc}\t${it.currency} ${it.amount}\tNT$${it.ntd ?? ''}\t${(it.e.photos || []).length ? '' : (it.e.receiptSeparate ? '(receipt separate)' : '(no photo)')}`).join('\n');
  zip.file('00_index.txt', `Receipts - ${trip.destination} ${trip.from} ~ ${trip.to}\nNo.\tDate\tCategory\tDescription\tAmount\tNTD\n${list}\n`);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  return { blob, name: `receipts_${(trip.from || '').replace(/-/g, '')}.zip`, count };
}

export async function buildBackup(trips, expensesByTrip, includePhotos = true) {
  const data = { app: 'bt-expense', version: 1, exportedAt: new Date().toISOString(), trips, expenses: [], photos: [] };
  for (const t of trips) for (const e of expensesByTrip[t.id] || []) {
    data.expenses.push(e);
    if (includePhotos) for (const pid of e.photos || []) { const p = await get('photos', pid); if (p) data.photos.push({ id: p.id, dataURL: await blobToDataURL(p.blob) }); }
  }
  const name = trips.length === 1 ? `backup_${(trips[0].from || '').replace(/-/g, '')}_${(trips[0].destination || 'trip').replace(/[\\/:*?"<>|,\s]+/g, '-').slice(0, 20)}.json` : `backup_all_${new Date().toISOString().slice(0, 10)}.json`;
  return { blob: new Blob([JSON.stringify(data)], { type: 'application/json' }), name };
}

// iOS: navigator.share must run inside a tap, so callers build first, then call this from a second tap.
export async function shareOrDownload(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return 'shared'; } catch (err) { if (err && err.name === 'AbortError') return 'cancelled'; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return 'downloaded';
}
export { CAT_ZH };
