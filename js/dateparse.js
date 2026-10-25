// 純函式日期解析（無 DOM 依賴，可在 node 測）。
// 支援：西元、泰國佛曆（-543）、民國（+1911）、英文／泰文月份名。
// detectDate(text, { today }) → { date:'YYYY-MM-DD', flag:null|'old'|'future', needsConfirm, era:'CE'|'BE'|'ROC', raw } | null
// flag：'old' = 早於今天一年前；'future' = 晚於今天 → UI 應標記請使用者確認。

const pad = (n) => String(n).padStart(2, '0');

export function todayLocal(now = new Date()) {
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export function isValidYmd(y, m, d) {
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1)) return false;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= dim;
}

// 一年前的同月同日（2/29 → 2/28）
export function oneYearBefore(today) {
  const [y, m, d] = today.split('-').map(Number);
  const dim = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
  return `${y - 1}-${pad(m)}-${pad(Math.min(d, dim))}`;
}

// 日期是否需要使用者確認
export function assessDate(iso, today = todayLocal()) {
  if (iso > today) return 'future';
  if (iso < oneYearBefore(today)) return 'old';
  return null;
}

function normalize(text) {
  return String(text)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xff10 + 48))
    .replace(/[๐-๙]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x0e50 + 48))
    .replace(/[．。]/g, '.').replace(/[／]/g, '/').replace(/[－‐‑–—]/g, '-')
    .replace(/中華民國|中华民国|民國|民国|R\.?O\.?C\.?/gi, '\u0001');
}

// 4 位數年份：西元 / 佛曆；回傳 { y, era } 或 null
function year4(n) {
  if (n >= 1900 && n <= 2399) return { y: n, era: 'CE' };
  if (n >= 2400 && n <= 2699) return { y: n - 543, era: 'BE' };
  return null;
}
// 2 位數年份（D/M/YY）：>50 視為佛曆 25xx，否則 20xx
function year2(n) {
  return n > 50 ? { y: 2500 + n - 543, era: 'BE' } : { y: 2000 + n, era: 'CE' };
}
function yearRoc(n) { return n >= 1 && n <= 200 ? { y: n + 1911, era: 'ROC' } : null; }

const EN_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const TH_FULL = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const TH_ABBR = ['ม.ค', 'ก.พ', 'มี.ค', 'เม.ย', 'พ.ค', 'มิ.ย', 'ก.ค', 'ส.ค', 'ก.ย', 'ต.ค', 'พ.ย', 'ธ.ค'];
const TH_MAP = {};
TH_FULL.forEach((n, i) => { TH_MAP[n] = i + 1; });
TH_ABBR.forEach((n, i) => { TH_MAP[n] = i + 1; });
const thMonthOf = (s) => TH_MAP[s.replace(/\.$/, '')] || 0;
const reEsc = (s) => s.replace(/\./g, '\\.');
const TH_ALT = [...TH_FULL, ...TH_ABBR].map(reEsc).join('|');

// 蒐集全部合法候選（依出現位置排序）
export function parseDateCandidates(text, today = todayLocal()) {
  let s = normalize(text);
  const out = [];
  const push = (idx, y, m, d, era, raw) => {
    if (!isValidYmd(y, m, d)) return;
    const date = `${y}-${pad(m)}-${pad(d)}`;
    out.push({ idx, date, era, raw: raw.trim(), flag: assessDate(date, today) });
  };
  const blank = (m) => ' '.repeat(m.length);

  // 1) 年月日（民國／西元／佛曆）：115年10月25日、民國115年10月25日
  s = s.replace(/(\u0001?)\s*(\d{1,4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/g, (all, mk, yy, mm, dd, idx) => {
    const n = +yy; const yr = mk ? yearRoc(n) : (yy.length === 4 ? year4(n) : yearRoc(n));
    if (yr) push(idx, yr.y, +mm, +dd, yr.era, all.replace(/\u0001/g, '民國'));
    return blank(all);
  });

  // 2) 月份名（英文／泰文）：25 Oct 2026、Oct 25, 2026、25 ต.ค. 2569
  const dmy = (all, dd, mon, yy, idx, thai) => {
    const mo = thai ? thMonthOf(mon) : EN_MONTHS[mon.slice(0, 3).toLowerCase()];
    const yr = yy.length === 4 ? year4(+yy) : yy.length === 2 ? year2(+yy) : null;
    if (mo && yr) push(idx, yr.y, mo, +dd, yr.era, all);
    return blank(all);
  };
  s = s.replace(new RegExp(`(\\d{1,2})\\s*(${TH_ALT})\\.?\\s*(\\d{4}|\\d{2})(?!\\d)`, 'g'), (a, d, m, y, i) => dmy(a, d, m, y, i, true));
  s = s.replace(/(\d{1,2})\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*,?\s*(\d{4})(?!\d)/gi, (a, d, m, y, i) => dmy(a, d, m, y, i, false));
  s = s.replace(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*(\d{1,2})\s*,?\s*(\d{4})(?!\d)/gi, (all, m, d, y, idx) => {
    const yr = year4(+y); const mo = EN_MONTHS[m.slice(0, 3).toLowerCase()];
    if (yr && mo) push(idx, yr.y, mo, +d, yr.era, all);
    return blank(all);
  });

  // 3) Y/M/D：2026/10/25、2569-10-25、115/10/25、115.10.25、民國99/1/5（左邊界用群組，不用 lookbehind）
  s = s.replace(/(^|[^\d\u0001])(\u0001?)\s*(\d{3,4}|\d{1,2}(?=\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{1,2}(?!\d)))\s*([-/.])\s*(\d{1,2})\s*\4\s*(\d{1,2})(?!\d)/g, (all, pre, mk, yy, sep, mm, dd, idx) => {
    const n = +yy; let yr = null;
    if (mk) yr = yearRoc(n);
    else if (yy.length === 4) yr = year4(n);
    else if (yy.length === 3) yr = yy[0] !== '0' ? yearRoc(n) : null;
    // 1–2 位且無民國標記 → 交給 D/M/YY 規則
    if (!yr) return all;
    push(idx + pre.length, yr.y, +mm, +dd, yr.era, all.slice(pre.length).replace(/\u0001/g, '民國'));
    return pre + blank(all.slice(pre.length));
  });

  // 4) D/M/Y：25/10/2026、25.10.2569、25/10/69（泰國／港／英；不可能時對調）
  s.replace(/(^|[^\d])(\d{1,2})\s*([-/.])\s*(\d{1,2})\s*\3\s*(\d{4}|\d{2})(?!\d)/g, (all, pre, a, sep, b, yy, idx) => {
    const yr = yy.length === 4 ? year4(+yy) : year2(+yy);
    if (!yr) return all;
    let d = +a; let mo = +b;
    if (mo > 12 && d <= 12) { d = +b; mo = +a; }
    push(idx + pre.length, yr.y, mo, d, yr.era, all.slice(pre.length));
    return all;
  });

  return out.sort((x, y) => x.idx - y.idx);
}

// 取一個最合理的日期：優先第一個「不需確認」的；都需確認就取第一個並帶旗標
export function detectDate(text, opts = {}) {
  const today = opts.today || todayLocal();
  const c = parseDateCandidates(text, today);
  if (!c.length) return null;
  const pick = c.find((x) => !x.flag) || c[0];
  return { date: pick.date, flag: pick.flag, needsConfirm: !!pick.flag, era: pick.era, raw: pick.raw };
}
