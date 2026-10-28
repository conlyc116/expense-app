// Company xlsx export (fills the company template XML directly), receipts zip, JSON backup.
import { ntdOf, rateOf, curOf, attendeeList, amountOf, hasCard, CAT_ZH } from './policy.js';
import { get } from './db.js';
import { blobToDataURL } from './image.js';
import { t, getLang, catLabel } from './i18n.js';
import { buildXlsxBytes, exportFileName, sheetNameFor, XLSX_MIME } from './xlsxfill.js';
import { buildPptxBytes, imageSize, sniffImage, PPTX_MIME } from './pptxgen.js';
import { readExifOrientation, compressImage } from './image.js';

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

// 產生公司報帳單 xlsx：直接填 assets/template_blank.xlsx 的 XML（見 xlsxfill.js），不經 ExcelJS。
export async function buildXlsx(trip, expenses, settings = {}) {
  if (!window.JSZip) throw new Error(t('exp.noJszip'));
  const { items, total, notes } = buildSheetModel(trip, expenses, settings);
  const resp = await fetch('assets/template_blank.xlsx');
  if (!resp || !resp.ok) throw new Error(t('exp.noTemplate', { status: resp ? resp.status : '' }));
  const data = {
    empNo: settings.empNo, empName: settings.empName, destination: trip.destination || '', from: trip.from, to: trip.to,
    checkMarks: settings.checkMarks !== false, total, notes, sheetName: sheetNameFor(trip),
    items: items.map((it) => ({ no: it.no, date: it.e.date, category: it.e.category, desc: it.desc, currency: it.currency, amount: it.amount, rate: it.rate, ntd: it.ntd, check: it.check })),
  };
  const bytes = await buildXlsxBytes(window.JSZip, await resp.arrayBuffer(), data);
  return { blob: new Blob([bytes], { type: XLSX_MIME }), name: exportFileName(trip), total, count: items.length };
}

// ---- 收據簡報（.pptx）：每張照片一頁。直接在手機上產生，不需要 Google 登入／API；用 Google 簡報開啟即可 ----
// 照片進簡報前：JPEG(無 EXIF 旋轉)／PNG 直接用原檔；其他（HEIC、有旋轉資訊的 JPEG…）先用 canvas 轉成已轉正的 JPEG。
export async function prepareSlideImage(blob, normalize = defaultNormalize) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const kind = sniffImage(bytes); const size = kind ? imageSize(bytes) : null;
  if (kind && size && size.w > 0 && size.h > 0 && (kind === 'png' || readExifOrientation(bytes.buffer) === 1)) return { bytes, ext: kind, w: size.w, h: size.h };
  return normalize(blob);
}
async function defaultNormalize(blob) {
  const { blob: jpg, width, height } = await compressImage(blob, 2000, 0.85);
  return { bytes: new Uint8Array(await jpg.arrayBuffer()), ext: 'jpeg', w: width, h: height };
}
export async function buildPptx(trip, expenses, settings = {}, opts = {}) {
  if (!window.JSZip) throw new Error(t('exp.noJszip'));
  const items = exportItems(trip, expenses); const slides = []; let failed = 0;
  for (const it of items) {
    const ids = it.e.photos || []; let part = 0;
    for (const pid of ids) {
      const p = await get('photos', pid); if (!p || !p.blob) continue;
      part++; let image = null;
      try { image = await prepareSlideImage(p.blob, opts.normalize); } catch (err) { failed++; console.warn('pptx image', err); }
      slides.push({ no: it.no, date: it.e.date, category: catLabel(it.e.category), amount: it.amount, currency: it.currency, ntd: it.ntd, desc: it.desc, part, parts: ids.length, image });
    }
  }
  if (!slides.length) return null;
  slides.forEach((s) => { const same = slides.filter((x) => x.no === s.no); s.parts = same.length; s.part = same.indexOf(s) + 1; });
  const labels = { count: t('ppt.count', { n: slides.length }), no: t('ppt.no'), date: t('ppt.date'), category: t('ppt.category'), amount: t('ppt.amount'), ntd: t('ppt.ntd'), desc: t('ppt.desc'), noPhoto: t('ppt.noPhoto') };
  const { bytes, pages } = await buildPptxBytes(window.JSZip, { title: trip.destination || t('trip.fallbackTitle'), from: trip.from, to: trip.to, lang: getLang() === 'en' ? 'en-US' : 'zh-TW', labels, slides });
  return { blob: new Blob([bytes], { type: PPTX_MIME }), name: exportFileName(trip, 'pptx'), count: slides.length, pages, failed };
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
  return { blob, name: exportFileName(trip, 'zip', '_receipts'), count };
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
export async function shareOrDownloadMany(list) {
  const files = list.map(({ blob, name }) => new File([blob], name, { type: blob.type }));
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files, title: list[0].name }); return 'shared'; } catch (err) { if (err && err.name === 'AbortError') return 'cancelled'; }
  }
  for (let i = 0; i < list.length; i++) {
    const url = URL.createObjectURL(list[i].blob);
    const a = document.createElement('a'); a.href = url; a.download = list[i].name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    if (i < list.length - 1) await new Promise((r) => setTimeout(r, 600)); // 連續下載之間稍等，避免 Safari 擋掉第二個
  }
  return 'downloaded';
}
export const shareOrDownload = (blob, name) => shareOrDownloadMany([{ blob, name }]);
export { CAT_ZH };
