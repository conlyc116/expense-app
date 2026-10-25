// 卡帳對帳（design-spec 9.1）。純函式、不碰 DOM／IndexedDB，node 可直接測。
// 配對規則：交易日 ±3 天 ＋ 原幣金額 ＋ 幣別；退款（負數）與同商家同額重複扣款自動併入同一群組。
import { normCur, curOf, daysBetween, NON_CARD_PAY } from './policy.js';

// 簡易 CSV（支援雙引號欄位；# 開頭的行當註解）
export function parseCsv(text) {
  const rows = []; let cur = []; let f = ''; let q = false;
  const s = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { cur.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; cur.push(f); f = ''; if (cur.some((x) => x !== '') && !String(cur[0]).startsWith('#')) rows.push(cur); cur = []; }
    else f += c;
  }
  if (f !== '' || cur.length) { cur.push(f); if (!String(cur[0]).startsWith('#')) rows.push(cur); }
  return rows;
}

const baseMerchant = (m) => String(m || '').toUpperCase().replace(/\bREFUND\b/g, '').replace(/[^A-Z0-9\u4e00-\u9fff]/g, '');

// 欄位：post_date,txn_date,merchant_on_statement,original_ccy,original_amt,twd_charged,fx_fee_twd[,match_to]
// match_to（若有）只是假資料的「標準答案」，配對時完全不看。
export function parseStatement(text) {
  const [head, ...body] = parseCsv(text);
  const ix = (n) => head.indexOf(n);
  const feeCol = ix('fx_fee_twd') >= 0 ? 'fx_fee_twd' : 'fee_twd';
  const need = ['txn_date', 'merchant_on_statement', 'original_ccy', 'original_amt', 'twd_charged', feeCol];
  for (const n of need) if (ix(n) < 0) throw new Error(`卡帳 CSV 缺少欄位 ${n}`);
  return body.map((r, i) => {
    const amt = +r[ix('original_amt')];
    return { idx: i, post: r[ix('post_date')] || '', txn: r[ix('txn_date')], merchant: r[ix('merchant_on_statement')], base: baseMerchant(r[ix('merchant_on_statement')]), ccy: normCur(r[ix('original_ccy')]), amt, ntd: +r[ix('twd_charged')], fee: +r[ix(feeCol)] || 0, type: amt < 0 ? 'refund' : 'charge' };
  });
}

const line = (r) => ({ type: r.type, amt: Math.abs(r.amt), ntd: Math.abs(r.ntd), fee: Math.abs(r.fee), txn: r.txn, merchant: r.merchant });

// expenses: app 的費用物件；rows: parseStatement() 結果；opts.window 預設 3 天
// 回傳 { matches:[{expenseId,status,lines}], unmatched:[row], noCard:[expenseId] }
// status: matched | merge（建議合併，需使用者接受）| private | non-card（卡帳上本來就找不到）| no-match
export function matchStatement(expenses, rows, opts = {}) {
  const win = opts.window ?? 3;
  const used = new Set(); const groups = new Map(); const matches = []; const noCard = [];
  const charges = rows.filter((r) => r.type === 'charge');
  const exps = expenses.slice().sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.createdAt || 0) - (b.createdAt || 0));

  // 1) 一對一：每筆費用只拿一筆扣款當正本（同額同日的兩筆正常消費不會被誤判成重複扣款）
  for (const e of exps) {
    if (NON_CARD_PAY.includes(e.payMethod)) { matches.push({ expenseId: e.id, status: 'non-card', lines: [] }); continue; }
    const cur = normCur(curOf(e)); const amt = +e.amount;
    const cands = charges.filter((r) => !used.has(r.idx) && r.ccy === cur && Math.abs(r.amt - amt) < 0.005 && e.date && Math.abs(daysBetween(e.date, r.txn)) <= win);
    if (!cands.length) { noCard.push(e.id); matches.push({ expenseId: e.id, status: 'no-match', lines: [] }); continue; }
    cands.sort((a, b) => Math.abs(daysBetween(e.date, a.txn)) - Math.abs(daysBetween(e.date, b.txn)) || a.idx - b.idx);
    const p = cands[0]; used.add(p.idx);
    groups.set(e.id, { e, primary: p, rows: [p] });
  }
  // 2) 剩下的扣款若和某個正本「同商家、同幣別、同額、±win 天」→ 重複扣款
  for (const r of charges) {
    if (used.has(r.idx)) continue;
    for (const g of groups.values()) {
      const p = g.primary;
      if (p.base === r.base && p.ccy === r.ccy && Math.abs(p.amt - r.amt) < 0.005 && Math.abs(daysBetween(p.txn, r.txn)) <= win) { g.rows.push(r); used.add(r.idx); break; }
    }
  }
  // 3) 退款：同商家＋同幣別、金額不超過正本；優先挑金額剛好相等（沖重複扣款）者，其次日期最近
  for (const r of rows.filter((x) => x.type === 'refund')) {
    const cands = [...groups.values()].filter((g) => g.primary.base === r.base && g.primary.ccy === r.ccy && Math.abs(r.amt) <= g.primary.amt + 0.005);
    if (!cands.length) continue;
    const score = (g) => [Math.abs(Math.abs(r.amt) - g.primary.amt) < 0.005 ? 0 : 1, Math.abs(daysBetween(g.primary.txn, r.txn))];
    cands.sort((a, b) => { const x = score(a), y = score(b); return x[0] - y[0] || x[1] - y[1]; });
    cands[0].rows.push(r); used.add(r.idx);
  }
  for (const g of groups.values()) {
    const merged = g.rows.length > 1;
    const hasFee = g.rows.some((r) => r.fee);
    matches.push({ expenseId: g.e.id, status: g.e.business === false ? 'private' : merged ? 'merge' : 'matched', hasFee, lines: g.rows.map(line) });
  }
  const unmatched = rows.filter((r) => !used.has(r.idx));
  return { matches, unmatched, noCard };
}

// 套用配對結果。acceptMerge=false 時，「建議合併」的群組不套用（等使用者按接受）。
export function applyMatches(expenses, result, { acceptMerge = true } = {}) {
  const by = new Map(result.matches.map((m) => [m.expenseId, m]));
  return expenses.map((e) => {
    const m = by.get(e.id);
    if (!m || !m.lines.length || (m.status === 'merge' && !acceptMerge)) return e;
    return { ...e, card: m.lines };
  });
}
