// Policy rules: Butterfly T&E Policy (2026-03-17) + Taiwan process. See README.
import { t } from './i18n.js';
export const CATS = ['Air ticket', 'Hotel', 'Transportation', 'Meals', 'Communication', 'Misc'];
export const CAT_ZH = { 'Air ticket': '機票', Hotel: '住宿', Transportation: '交通', Meals: '餐費', Communication: '通訊', Misc: '雜支' };
export const CURRENCIES = ['NTD', 'RMB', 'THB', 'HKD', 'USD', 'JPY'];
export const DEFAULT_RATES = { RMB: 4.5, THB: 0.95, HKD: 4.1, USD: 32, JPY: 0.21 };
export const CABINS = ['Economy', 'Premium economy', 'Business', 'First'];
export const LIMITS = { deadlineDays: 60, deadlineWarnDays: 14, deadlineDangerDays: 3, receiptUsd: 50, mealUsdPerDay: 150, hotelGuideLow: 200, hotelGuideHigh: 300, hotelHighCost: 500, hotelApproval: 650, intlAirApproval: 4000, domAirApproval: 1500, shortHaulHours: 5 };
// 付款工具（design-spec 6.7）。非卡支付在卡帳單上找不到，對帳時走「確認估計」而不是配對。
export const PAY_METHODS = ['信用卡', 'Apple Pay', '現金', '支付寶', '電子錢包', '行動支付', '電信帳單'];
export const NON_CARD_PAY = ['現金', '支付寶', '電子錢包', '行動支付', '電信帳單', '電子錢包X'];
export const normCur = (c) => { const u = String(c || '').trim().toUpperCase(); return u === 'TWD' ? 'NTD' : u === 'CNY' ? 'RMB' : u; };

export const curOf = (e) => (e.currency === 'OTHER' ? (e.customCurrency || 'OTHER').toUpperCase() : e.currency);
export const usdRate = (trip) => +(trip.rates && trip.rates.USD) || 32;

const r2 = (n) => Math.round(n * 100) / 100;
const fmtN = (n) => Number(r2(n)).toLocaleString('en-US', { maximumFractionDigits: 2 });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// 信用卡帳單明細 → 這一筆的實扣。lines: [{type:'charge'|'refund', amt, ntd, fee}]（金額一律用正數，type 決定方向）
// 規則：第一筆扣款 = 正本；其餘同額扣款 = 重複扣款；與正本同額的退款先沖重複扣款；金額較小的退款 = 部分退款。
// 沒被退掉的重複扣款不請款（對公司最保守），並產生警示。
export function settleCard(lines) {
  const L = (lines || []).map((l) => ({ type: l.type === 'refund' ? 'refund' : 'charge', amt: Math.abs(+l.amt || 0), ntd: Math.abs(+l.ntd || 0), fee: Math.abs(+l.fee || 0) }));
  const charges = L.filter((l) => l.type === 'charge'); const refunds = L.filter((l) => l.type === 'refund');
  if (!charges.length) return { ntd: 0, amount: 0, charge: 0, fee: 0, refund: 0, dupCharges: 0, dupRefunded: 0, dupUnrefunded: 0, fullyRefunded: false, empty: true, text: '' };
  const p = charges[0];
  const same = (r) => Math.abs(r.amt - p.amt) < 0.005;
  const full = refunds.filter(same); const partial = refunds.filter((r) => !same(r));
  const dupCharges = charges.length - 1;
  const dupRefunded = Math.min(dupCharges, full.length);
  const dupUnrefunded = dupCharges - dupRefunded;
  const fullyRefunded = full.length > dupCharges;
  const refund = partial.reduce((s, r) => s + r.ntd + r.fee, 0);
  const refundAmt = partial.reduce((s, r) => s + r.amt, 0);
  const ntd = fullyRefunded ? 0 : Math.round(p.ntd + p.fee - refund);
  const amount = fullyRefunded ? 0 : r2(p.amt - refundAmt);
  let text = fmtN(p.ntd);
  if (p.fee) text += `＋fee ${fmtN(p.fee)}`;
  if (refund) text += `－refund ${fmtN(refund)}`;
  if (dupRefunded) text += `; ${plural(dupRefunded, 'duplicate charge')} refunded`;
  if (dupUnrefunded) text += `; ${plural(dupUnrefunded, 'duplicate charge')} not refunded (excluded)`;
  if (fullyRefunded) text += '; fully refunded';
  const merged = !!(p.fee || refund || dupCharges || fullyRefunded || partial.length);
  return { ntd, amount, charge: p.ntd, fee: p.fee, refund, dupCharges, dupRefunded, dupUnrefunded, fullyRefunded, merged, empty: false, text };
}
export const hasCard = (e) => Array.isArray(e.card) && e.card.length > 0;
export const amountOf = (e) => (hasCard(e) ? settleCard(e.card).amount : +e.amount);

// 匯率順序（policy_rules）：刷卡實際匯率 → 換匯水單 → 公司匯率。
// source: 'card' | 'exchange-receipt' | 'ntd' | 'trip-rate'；只有 trip-rate 是「估」。
export function ntdOf(e, trip) {
  if (hasCard(e)) { const s = settleCard(e.card); return { ntd: s.ntd, actual: true, source: 'card', settle: s }; }
  if (e.actualNtd !== null && e.actualNtd !== undefined && e.actualNtd !== '' && !isNaN(+e.actualNtd)) return { ntd: Math.round(+e.actualNtd), actual: true, source: 'card' };
  const cur = curOf(e);
  const amt = +e.amount;
  if (!isFinite(amt)) return { ntd: null, actual: false, source: null };
  if (cur === 'NTD') return { ntd: Math.round(amt), actual: true, source: 'ntd' };
  if (+e.rateOverride > 0) return { ntd: Math.round(amt * +e.rateOverride), actual: true, source: 'exchange-receipt' };
  const rate = +((trip.rates || {})[cur]);
  if (!rate) return { ntd: null, actual: false, source: null };
  return { ntd: Math.round(amt * rate), actual: !!e.estConfirmed, source: 'trip-rate' };
}
// Rate 欄：實扣 = NTD ÷ 原幣（含手續費）；估算 = 實際使用的匯率本身（不用四捨五入後的 NTD 反推，避免 4.78 變 4.77）。
export function rateOf(e, trip) {
  if (curOf(e) === 'NTD') return 1;
  const r = ntdOf(e, trip);
  const amt = amountOf(e);
  if (r.ntd === null) return null;
  if (r.source === 'trip-rate') return +(trip.rates || {})[curOf(e)];
  if (r.source === 'exchange-receipt') return +e.rateOverride;
  if (!amt) return null;
  return Math.round((r.ntd / amt) * 10000) / 10000;
}

export function attendeeList(e) { return (e.attendees || '').split(/[,，、;；\n]+/).map((s) => s.trim()).filter(Boolean); }

const dayMs = 86400000;
const toUtc = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
export const addDays = (s, n) => new Date(toUtc(s) + n * dayMs).toISOString().slice(0, 10);
export function todayStr() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
export const daysBetween = (a, b) => Math.round((toUtc(b) - toUtc(a)) / dayMs);

// Returns { byId: {id: [{level, msg}]}, summary: [{level, msg}], deadline, totals }
// 航程是否「< 5 小時」：有填 legHours 以數字為準（<= 5 一律當短程，邊界採最保守）；沒填才看舊的勾選欄 legUnder5h。
export function airShortHaul(e) { const h = parseFloat(e.legHours); return isFinite(h) && h > 0 ? h <= LIMITS.shortHaulHours : !!e.legUnder5h; }

// opts.today（YYYY-MM-DD）僅供測試／可重現計算；平常不傳。
export function evaluate(trip, expenses, opts = {}) {
  const today = opts.today || todayStr();
  const lang = opts.lang || 'zh-Hant'; // 預設繁中（node 測試可重現）；app 傳入目前語言
  const byId = {}; const summary = [];
  const M = (key, args) => ({ key, args, msg: t(key, args, lang) });
  const add = (id, level, key, args) => { (byId[id] = byId[id] || []).push({ level, ...M(key, args) }); };
  const usd = usdRate(trip);
  const biz = expenses.filter((e) => e.business !== false);
  const totals = { business: 0, personal: 0, count: biz.length, personalCount: expenses.length - biz.length, estimated: 0, missingNtd: 0 };

  for (const e of expenses) {
    const { ntd, actual } = ntdOf(e, trip);
    if (e.business === false) { totals.personal += ntd || 0; continue; }
    if (ntd === null) { totals.missingNtd++; add(e.id, 'error', 'pol.missingRate', { cur: curOf(e) }); continue; }
    totals.business += ntd;
    if (!actual) { totals.estimated++; add(e.id, 'info', 'pol.estimated'); }
    const st = hasCard(e) ? settleCard(e.card) : null;
    if (st && st.dupUnrefunded) add(e.id, 'warn', 'pol.dupUnrefunded', { n: st.dupUnrefunded });
    if (st && st.fullyRefunded) add(e.id, 'info', 'pol.fullyRefunded');
    const usdVal = ntd / usd;
    if (usdVal > LIMITS.receiptUsd && !(e.photos && e.photos.length) && !e.receiptSeparate) add(e.id, 'warn', 'pol.needReceipt', { usd: LIMITS.receiptUsd, ntd: Math.round(LIMITS.receiptUsd * usd).toLocaleString() });
    if (e.date && trip.from && trip.to && (e.date < addDays(trip.from, -30) || e.date > addDays(trip.to, 1)) && e.category !== 'Air ticket') add(e.id, 'info', 'pol.dateOutside');
    if (e.category === 'Air ticket') {
      if (e.cabin === 'Premium economy' && airShortHaul(e) && !e.preApproval) add(e.id, 'warn', 'pol.premiumShort');
      if (e.cabin === 'Premium economy' && !(parseFloat(e.legHours) > 0) && !e.legUnder5h && !e.preApproval) add(e.id, 'info', 'pol.needHours');
      if ((e.cabin === 'Business' || e.cabin === 'First') && !e.preApproval) add(e.id, 'warn', 'pol.bizFirst');
      const airCap = e.domestic ? LIMITS.domAirApproval : LIMITS.intlAirApproval;
      if (usdVal > airCap && !e.preApproval) add(e.id, 'warn', e.domestic ? 'pol.airCapDom' : 'pol.airCapIntl', { cap: airCap.toLocaleString() });
    }
    if (e.category === 'Hotel') {
      const nights = Math.max(1, +e.nights || 1);
      const perNight = usdVal / nights;
      if (perNight > LIMITS.hotelApproval) add(e.id, 'warn', 'pol.hotelApproval', { per: Math.round(perNight), cap: LIMITS.hotelApproval });
      else if (perNight > LIMITS.hotelGuideHigh) add(e.id, 'info', 'pol.hotelHigh', { per: Math.round(perNight), low: LIMITS.hotelGuideLow, high: LIMITS.hotelGuideHigh, hc: LIMITS.hotelHighCost });
      if (!e.nights) add(e.id, 'info', 'pol.needNights');
    }
    if (e.category === 'Meals' && e.shared) {
      if (attendeeList(e).length < 2) add(e.id, 'warn', 'pol.listAttendees');
      if (!e.seniorPays) add(e.id, 'warn', 'pol.seniorPays');
    }
  }

  // Own meals cap per day
  const perDay = {};
  for (const e of biz) {
    if (e.category !== 'Meals' || !e.date) continue;
    const { ntd } = ntdOf(e, trip); if (ntd === null) continue;
    const share = e.shared ? ntd / Math.max(2, attendeeList(e).length) : ntd;
    (perDay[e.date] = perDay[e.date] || { sum: 0, ids: [] }).sum += share;
    perDay[e.date].ids.push(e.id);
  }
  for (const [d, v] of Object.entries(perDay)) {
    const usdDay = v.sum / usd;
    if (usdDay > LIMITS.mealUsdPerDay) {
      const args = { md: d.slice(5), usd: Math.round(usdDay), cap: LIMITS.mealUsdPerDay };
      v.ids.forEach((id) => add(id, 'warn', 'pol.mealCap', args)); summary.push({ level: 'warn', ...M('pol.mealCap', args) });
    }
  }

  // Deadline: 60 days from earliest expense date
  const dates = biz.map((e) => e.date).filter(Boolean).sort();
  let deadline = null;
  const base = dates[0] || trip.from;
  if (base) {
    const due = addDays(base, LIMITS.deadlineDays);
    deadline = { base, due, daysLeft: daysBetween(today, due) };
    if (deadline.daysLeft < 0) summary.unshift({ level: 'error', ...M('pol.deadlineOver', { due }) });
    else if (deadline.daysLeft <= LIMITS.deadlineDangerDays) summary.unshift({ level: 'error', ...M('pol.deadlineDanger', { due, n: deadline.daysLeft }) });
    else if (deadline.daysLeft <= LIMITS.deadlineWarnDays) summary.unshift({ level: 'warn', ...M('pol.deadlineWarn', { due, n: deadline.daysLeft }) });
  }

  const counts = { warn: 0, error: 0, info: 0 };
  Object.values(byId).flat().forEach((w) => counts[w.level]++);
  for (const lv of ['error', 'warn']) if (counts[lv]) summary.push({ level: lv, ...M(lv === 'error' ? 'pol.cntError' : 'pol.cntWarn', { n: counts[lv] }) });
  if (totals.estimated) summary.push({ level: 'info', ...M('pol.sumEstimated', { n: totals.estimated }) });
  if (totals.personalCount) summary.push({ level: 'info', ...M('pol.sumPersonal', { n: totals.personalCount }) });
  return { byId, summary, deadline, totals };
}
