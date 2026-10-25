// On-device OCR with Tesseract.js (lazy-loaded, all files served locally from vendor/).
import { detectDate } from './dateparse.js';
let worker = null; let workerKey = ''; let progressCb = null;

function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('無法載入 ' + src)); document.head.appendChild(s); });
}

export async function recognize(blob, langs, onProgress) {
  progressCb = onProgress;
  if (!window.Tesseract) await loadScript('vendor/tesseract/tesseract.min.js');
  const key = langs.join('+');
  if (!worker || workerKey !== key) {
    if (worker) { try { await worker.terminate(); } catch (_) { /* ignore */ } }
    const base = new URL('vendor/tesseract/', location.href).href;
    worker = await window.Tesseract.createWorker(langs, 1 /* LSTM only */, {
      workerPath: base + 'worker.min.js',
      corePath: base + 'core',
      langPath: base + 'lang',
      gzip: true,
      workerBlobURL: false,
      logger: (m) => progressCb && progressCb(m),
    });
    workerKey = key;
  }
  const { data } = await worker.recognize(blob);
  return data.text || '';
}

// 依行程幣別挑語言組合：eng 一律保留；行程有 THB 自動加 tha，且沒有華語幣別時略過中文（較快、較少誤判）；
// 最多 3 種（iPhone 記憶體／速度）。優先序：eng > 行程相關語言 > 使用者勾選的其他語言。
export function pickLangs(selected, currencies = []) {
  const cur = new Set((currencies || []).map((c) => String(c).toUpperCase()));
  const known = ['eng', 'chi_sim', 'chi_tra', 'tha'];
  const sel = (selected || []).filter((l) => known.includes(l));
  const hasTh = cur.has('THB'); const hasCjk = ['RMB', 'CNY', 'HKD', 'NTD', 'TWD', 'JPY'].some((c) => cur.has(c));
  let out = ['eng'];
  if (hasTh && !sel.includes('tha')) sel.push('tha');
  const chi = sel.filter((l) => l.startsWith('chi_'));
  const skipChi = hasTh && !hasCjk;
  const rest = [...(sel.includes('tha') ? ['tha'] : []), ...(skipChi ? [] : chi)];
  out = out.concat(rest.filter((l) => !out.includes(l)));
  return out.slice(0, 3);
}

export async function terminate() { if (worker) { await worker.terminate(); worker = null; workerKey = ''; } }

// ---------- Parsing heuristics ----------
const CJK = '\u3400-\u9fff\uf900-\ufaff';
const THAI = '\u0e00-\u0e7f';
export function tidy(s) {
  return s.replace(new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'g'), '$1')
    // Tesseract tha 會在泰文字母間插空白（含 \n 以外的空白）；泰文本身不以空白分字，合併之
    .replace(new RegExp(`([${THAI}])[ \\t]+(?=[${THAI}])`, 'g'), '$1').replace(/[ \t]+/g, ' ').trim();
}

function detectCurrency(text, fallback) {
  const t = text;
  const hits = [
    ['THB', /฿|\bTHB\b|บาท/i], ['HKD', /HK\$|\bHKD\b|港幣|港币/i], ['NTD', /NT\$|\bNTD\b|\bTWD\b|新台幣|新臺幣/i],
    ['USD', /US\$|\bUSD\b/i], ['JPY', /\bJPY\b|円/i], ['RMB', /¥|￥|\bRMB\b|\bCNY\b|人民币|人民幣|元|(^|\s)Y\s?\d+\.\d{2}/im],
  ];
  for (const [c, re] of hits) if (re.test(t)) return c;
  return fallback;
}

const NUM_RE = /(^|[^\d.,:])(-?\d{1,3}(?:,\d{3})+|-?\d+)(\.\d{1,2})?(?![\d:])/g; // no lookbehind (older iOS)
function numbersIn(line) {
  const out = [];
  if (/\d{1,2}:\d{2}/.test(line) && !/total|合計|合计|總|总|รวม|付/i.test(line)) return out; // times
  for (const m of line.matchAll(NUM_RE)) {
    const raw = m[2].replace(/,/g, '') + (m[3] || '');
    const v = Math.abs(parseFloat(raw));
    if (!isFinite(v) || v === 0 || v >= 1e6) continue;
    if (!m[3] && m[2].replace(/[-,]/g, '').length >= 7) continue; // phone / id numbers
    out.push({ v, dec: !!m[3] });
  }
  return out;
}

function detectAmount(text) {
  const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const strong = /grand\s*total|amount\s*due|total\s*due|net\s*total|實付|实付|實收|实收|應付|应付|應收|应收|支付金額|支付金额|付款金額|付款金额|總計|总计|總額|总额|合計|合计|ยอดสุทธิ|ยอดรวม|รวมทั้งสิ้น|รวมเงิน/i;
  const medium = /\btotal\b|\bamount\b|金額|金额|รวม|paid|payment|消費|消费/i;
  const weak = /sub\s*total|小計|小计|vat|tax|稅|税|change|找零|現金|现金|cash/i;
  let best = null;
  lines.forEach((line, i) => {
    let score = strong.test(line) ? 3 : medium.test(line) ? 2 : 0;
    if (weak.test(line) && score < 3) score = Math.min(score, 1) - (/(change|找零)/i.test(line) ? 2 : 0);
    if (score <= 0) return;
    let nums = numbersIn(line);
    if (!nums.length && lines[i + 1]) nums = numbersIn(lines[i + 1]);
    if (!nums.length) return;
    const v = nums[nums.length - 1].v;
    if (!best || score > best.score || (score === best.score && v > best.v)) best = { v, score };
  });
  if (best) return best.v;
  const all = lines.flatMap(numbersIn);
  const dec = all.filter((n) => n.dec);
  const pool = dec.length ? dec : all;
  if (!pool.length) return null;
  return Math.max(...pool.map((n) => n.v));
}

function detectMerchant(text) {
  const lines = text.split(/\n/).map(tidy).filter(Boolean);
  const bad = /receipt|invoice|tax|收據|收据|發票|发票|統一編號|电话|電話|tel|date|日期|order|訂單|订单|ใบเสร็จ|ใบกำกับ/i;
  for (const l of lines.slice(0, 8)) {
    const letters = l.replace(/[^A-Za-z\u0E00-\u0E7F\u3400-\u9fff]/g, '');
    if (letters.length < 2) continue;
    if (bad.test(l)) continue;
    if (/\d{4,}/.test(l) && letters.length < 4) continue;
    return l.slice(0, 60);
  }
  return '';
}

export function parseReceipt(raw, defaultCurrency, opts = {}) {
  const text = raw.split('\n').map(tidy).join('\n');
  const dt = detectDate(text, { today: opts.today });
  return {
    date: dt ? dt.date : null,
    dateFlag: dt ? dt.flag : null,          // 'old' | 'future' | null → UI 請使用者確認
    dateEra: dt ? dt.era : null,            // 'CE' | 'BE' | 'ROC'
    dateRaw: dt ? dt.raw : '',
    amount: detectAmount(text),
    currency: detectCurrency(text, defaultCurrency),
    merchant: detectMerchant(text),
  };
}
