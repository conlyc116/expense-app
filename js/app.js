import * as db from './db.js';
import { CATS, CAT_ZH, CURRENCIES, DEFAULT_RATES, CABINS, LIMITS, PAY_METHODS, NON_CARD_PAY, evaluate, ntdOf, rateOf, curOf, amountOf, hasCard, settleCard, normCur, todayStr, attendeeList, usdRate } from './policy.js';
import { icon, CAT_KEY } from './icons.js';
import { parseStatement, matchStatement, applyMatches } from './reconcile.js';
import { compressImage, prepareForOcr, dataURLToBlob, setImageWarnHandler } from './image.js';
// ocr.js（→ dateparse.js）改為「用到才載入」：任何一個檔漏傳／路徑錯，只會讓辨識失敗並顯示訊息，不會讓整個 app 起不來。
let ocrMod = null;
async function getOcr() {
  if (!ocrMod) { try { ocrMod = await import('./ocr.js'); } catch (e) { throw new Error('辨識模組載入失敗（ocr.js／dateparse.js 可能未部署）：' + (e.message || e)); } }
  return ocrMod;
}
const tidy = (s) => { const CJK = '\u3400-\u9fff\uf900-\ufaff'; return s.replace(new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'g'), '$1').replace(/[ \t]+/g, ' ').trim(); };
import { buildXlsx, buildReceiptsZip, buildBackup, shareOrDownload } from './export.js';

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, d = 0) => (n === null || n === undefined || isNaN(n) ? '—' : Number(n).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }));
const amt = (n) => (n === '' || n === null || n === undefined ? '' : Number(n).toLocaleString('zh-TW', { maximumFractionDigits: 2 }));
const LEVEL_ICON = { error: '⛔', warn: '⚠️', info: 'ℹ️' };
let toastTimer;
function toast(msg, ms = 2600, action = null) {
  const t = $('#toast'); t.textContent = '';
  const s = document.createElement('span'); s.textContent = msg; t.append(s);
  if (action) { const b = document.createElement('button'); b.type = 'button'; b.id = 'toast-action'; b.textContent = action.label; b.onclick = () => { t.classList.remove('show'); action.onClick(); }; t.append(b); }
  t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
// 底部操作列（design-spec 6.2）：每個畫面最多 3 個按鈕，右側主要動作
function setBar(html, onMount) {
  const bar = $('#bar');
  if (!html) { bar.hidden = true; bar.innerHTML = ''; document.body.classList.remove('has-bar'); return; }
  bar.innerHTML = html; bar.hidden = false; document.body.classList.add('has-bar'); onMount && onMount(bar);
}
const pickTrip = (trips) => { const today = todayStr(); return trips.find((t) => t.from <= today && today <= t.to) || trips.slice().sort((a, b) => (b.from || '').localeCompare(a.from || ''))[0]; };
function applyTheme() { const t = settings.theme; if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
function applyDynType() { const px = parseFloat(getComputedStyle(document.documentElement).fontSize); document.documentElement.classList.toggle('ax', px >= 23); }

const SETTINGS_KEY = 'bt-settings';
const settings = Object.assign({ empName: '', empNo: '', ocrLangs: ['eng', 'chi_sim'], autoOcr: true, theme: '', lastPay: '信用卡', checkMarks: true }, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
const OCR_LANGS = [['eng', '英文'], ['chi_sim', '簡體中文'], ['chi_tra', '繁體中文'], ['tha', '泰文']];

function setTop(title, { back = null, action = null } = {}) {
  $('#tb-title').textContent = title;
  const b = $('#tb-back'); b.hidden = !back; b.onclick = back ? () => (typeof back === 'function' ? back() : (location.hash = back)) : null;
  const a = $('#tb-action'); a.hidden = !action; if (action) { a.textContent = action.label; a.onclick = action.onClick; a.setAttribute('aria-label', action.aria || action.label); }
}
function sheet(html, onMount) {
  const root = $('#sheet-root');
  root.innerHTML = `<div class="sheet-backdrop"></div><div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => { root.innerHTML = ''; };
  root.querySelector('.sheet-backdrop').onclick = close;
  root.querySelectorAll('[data-close]').forEach((b) => (b.onclick = close));
  onMount && onMount(root.querySelector('.sheet'), close);
  return close;
}

// ---------- state ----------
let draft = null;       // expense being edited
let draftIsNew = false;
let draftPhotoUrls = {};
let ocrState = { running: false, status: '', text: '', filled: new Set(), dateFlag: null, dateRaw: '' };
let ocrSrc = {}; // photoId → 原始檔（僅記憶體，供 OCR 前處理；不入庫）

// ---------- router ----------
window.addEventListener('hashchange', render);
async function render() {
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/');
  $('#sheet-root').innerHTML = ''; setBar(null);
  if (draft && parts[2] !== 'e') await discardDraftIfNew(); // e.g. iOS swipe-back out of an unsaved new expense
  try {
    if (!h) return await tripsView();
    if (parts[0] === 'settings') return settingsView();
    if (parts[0] === 'quick') return await quickAdd();   // PWA 捷徑「拍小票」：直接進進行中行程的新增頁
    if (parts[0] === 'new-trip') return tripForm(null);
    if (parts[0] === 'trip' && parts[1]) {
      const trip = await db.get('trips', parts[1]);
      if (!trip) { location.hash = '#/'; return; }
      if (!parts[2]) return await tripView(trip);
      if (parts[2] === 'edit') return tripForm(trip);
      if (parts[2] === 'reconcile') return await reconcileView(trip);
      if (parts[2] === 'e') return await editorView(trip, parts[3]);
    }
    location.hash = '#/';
  } catch (err) { console.error(err); view.innerHTML = `<div class="card error">發生錯誤：${esc(err.message)}</div>`; }
  finally { window.scrollTo(0, 0); }
}

async function quickAdd() {
  const t = pickTrip(await db.all('trips'));
  if (!t) { location.hash = '#/new-trip'; return; }
  newDraft(t); location.hash = `#/trip/${t.id}/e/new`;
}

// ---------- trips list ----------
async function tripsView() {
  setTop('出差報帳', { action: { label: '⚙︎', aria: '設定', onClick: () => (location.hash = '#/settings') } });
  const trips = (await db.all('trips')).sort((a, b) => (b.from || '').localeCompare(a.from || ''));
  const today = todayStr();
  const info = [];
  for (const t of trips) { const exps = await db.expensesOf(t.id); info.push({ t, exps, ev: evaluate(t, exps) }); }
  const ongoing = info.find((x) => x.t.from <= today && today <= x.t.to);
  const initials = (s) => { const w = String(s || '?').trim(); return /^[\x00-\x7f]/.test(w) ? w.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || '?' : w.slice(0, 2); };
  const dlBadge = (dl) => (dl ? `<span class="badge ${dl.daysLeft < 0 || dl.daysLeft <= LIMITS.deadlineDangerDays ? 'b-danger' : dl.daysLeft <= LIMITS.deadlineWarnDays ? 'b-warn' : 'b-info'}">${icon('clock', 'ic-s')}${dl.daysLeft < 0 ? '已逾期' : `剩 ${dl.daysLeft} 天`}</span>` : '');
  const cell = ({ t, ev }) => `<a class="cell" href="#/trip/${t.id}" data-trip="${t.id}"><div class="cat-ic c-misc">${esc(initials(t.destination))}</div>
      <div class="main"><div class="l1">${esc(t.destination || '（未命名）')}</div><div class="l2">${esc(t.from)} – ${esc(t.to)} · ${ev.totals.count} 筆</div></div>
      <div class="amt">${dlBadge(ev.deadline)}<div class="a2" style="margin-top:2px">NT$ ${money(ev.totals.business)}</div></div>${icon('right', 'ic-s')}</a>`;
  const hero = ongoing ? (() => { const { t, ev } = ongoing; const warnN = Object.values(ev.byId).flat().filter((w) => w.level !== 'info').length;
    return `<a class="card" href="#/trip/${t.id}" data-trip="${t.id}" data-ongoing="1"><div class="badge b-ok">進行中 · 新增會自動記到這裡</div>
      <div class="trip-title" style="margin-top:6px">${esc(t.destination || '（未命名）')}</div><div class="muted small">${esc(t.from)} – ${esc(t.to)} · ${ev.totals.count} 筆</div>
      <div class="sum-total">NT$ ${money(ev.totals.business)}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">${dlBadge(ev.deadline)}${warnN ? `<span class="badge b-warn">${icon('warn', 'ic-s')}${warnN} 項需處理</span>` : ''}${ev.totals.estimated ? `<span class="b-unrec">${ev.totals.estimated} 筆未對實扣</span>` : ''}</div></a>`; })() : '';
  const rest = info.filter((x) => x !== ongoing);
  view.innerHTML = `<h2 class="large-title">行程</h2>
    ${trips.length ? hero + (rest.length ? `<div class="section-h"><span>${ongoing ? '其他行程' : '全部行程'}</span></div><div class="group">${rest.map(cell).join('')}</div>` : '') : `<div class="empty"><div class="empty-icon">🧾</div><p>還沒有出差紀錄</p><p class="muted">新增一趟出差，出差中隨手拍收據，回來一鍵匯出公司 Excel。</p></div>`}
    <p class="privacy">${icon('lock')}資料只存在這支手機，不會上傳。換手機前請到設定「備份」。</p>`;
  const target = ongoing ? ongoing.t : (info[0] || {}).t;
  setBar(target ? `<button class="btn btn-icon" id="new-trip" aria-label="新增出差">${icon('plus')}新增</button><button class="btn btn-primary btn-lg" id="bar-camera">${icon('camera')}拍小票</button>` : `<button class="btn btn-primary btn-lg" id="new-trip">${icon('plus')}新增出差</button>`, () => {
    $('#new-trip').onclick = () => (location.hash = '#/new-trip');
    if (target) $('#bar-camera').onclick = () => pickPhoto('camera', target);
  });
}

// ---------- trip form ----------
function tripForm(trip) {
  const t = trip || { id: db.uid(), destination: '', from: todayStr(), to: todayStr(), rates: { ...DEFAULT_RATES }, notes: '', createdAt: Date.now() };
  setTop(trip ? '編輯出差' : '新增出差', { back: trip ? `#/trip/${t.id}` : '#/' });
  view.innerHTML = `<form class="card form" id="trip-form">
    <label>目的地（會填入 Excel 的 Destination）<input name="destination" required placeholder="例：Shenzhen, China / Bangkok, Thailand" value="${esc(t.destination)}"></label>
    <div class="two"><label>出發日<input type="date" name="from" required value="${esc(t.from)}"></label>
    <label>回程日<input type="date" name="to" required value="${esc(t.to)}"></label></div>
    <label>備註（每行一條，會列在 Excel 的 NOTES）<textarea name="notes" rows="3" placeholder="例：Premium economy pre-approved by manager via Slack (screenshot attached).">${esc(t.notes)}</textarea></label>
    <p class="muted small">匯率可在出差頁面的「匯率」裡調整。</p>
    <button class="btn primary block" type="submit">${trip ? '儲存' : '建立出差'}</button>
    ${trip ? '<button class="btn danger block" type="button" id="del-trip">刪除這趟出差</button>' : ''}
  </form>`;
  $('#trip-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    Object.assign(t, { destination: f.get('destination').trim(), from: f.get('from'), to: f.get('to'), notes: f.get('notes') });
    if (t.to < t.from) { toast('回程日不能早於出發日'); return; }
    await db.put('trips', t);
    location.hash = `#/trip/${t.id}`;
  };
  if (trip) $('#del-trip').onclick = async () => {
    if (!confirm('確定刪除這趟出差和所有收據照片？此動作無法復原。建議先備份。')) return;
    await db.deleteTrip(t.id); toast('已刪除'); location.hash = '#/';
  };
}

// ---------- trip view ----------
const LV_ORDER = { error: 0, warn: 1, info: 2 };
async function tripView(trip) {
  setTop(trip.destination || '出差', { back: '#/', action: { label: '編輯', onClick: () => (location.hash = `#/trip/${trip.id}/edit`) } });
  const exps = await db.expensesOf(trip.id);
  const ev = evaluate(trip, exps);
  const sorted = exps.slice().sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.createdAt || 0) - (b.createdAt || 0));
  const groups = {};
  sorted.forEach((e) => (groups[e.date || '未填日期'] = groups[e.date || '未填日期'] || []).push(e));
  const usd = usdRate(trip);
  const used = [...new Set(exps.map(curOf))].filter((c) => c !== 'NTD');
  const rateCurs = [...new Set(['USD', ...used, ...Object.keys(trip.rates || {})])];
  const dl = ev.deadline;
  const dlCls = dl ? (dl.daysLeft < 0 || dl.daysLeft <= LIMITS.deadlineDangerDays ? 'error' : dl.daysLeft <= LIMITS.deadlineWarnDays ? 'warn' : '') : '';
  const pct = dl ? Math.min(100, Math.max(0, Math.round(((LIMITS.deadlineDays - dl.daysLeft) / LIMITS.deadlineDays) * 100))) : 0;
  const unrec = exps.filter((e) => e.business !== false && curOf(e) !== 'NTD' && !ntdOf(e, trip).actual).length;
  // 警示 banner：danger > warning > info；超過 3 則收合
  const BN = { error: ['bn-danger', 'stop'], warn: ['bn-warn', 'warn'], info: ['bn-info', 'sparkle'] };
  const banners = ev.summary.slice().sort((a, b) => LV_ORDER[a.level] - LV_ORDER[b.level]).map((w) => {
    const [cls, ic] = BN[w.level]; const act = /估算/.test(w.msg) ? '<button class="act" data-go-reconcile>對帳</button>' : '';
    return `<div class="banner ${cls}" data-level="${w.level}">${icon(ic)}<div style="min-width:0"><div class="bt">${esc(w.msg)}</div></div>${act}</div>`;
  });
  const bannerHtml = banners.length ? `<div class="section-h"><span>需處理 · ${banners.length}</span></div><div class="banners" id="banners">${banners.slice(0, 3).join('')}${banners.length > 3 ? `<details class="more-banners"><summary>還有 ${banners.length - 3} 項</summary><div class="banners">${banners.slice(3).join('')}</div></details>` : ''}</div>` : `<div class="banner bn-ok" id="banners">${icon('ok')}<div><div class="bt">目前沒有政策問題</div></div></div>`;

  view.innerHTML = `
  <section class="card summary" id="summary">
    <div class="muted small">${esc(trip.from)} – ${esc(trip.to)} · ${ev.totals.count} 筆公務</div>
    <div class="sum-total" id="sum-total">NT$ ${money(ev.totals.business)}</div>
    <div class="sum-split"><span>私人 <b>NT$ ${money(ev.totals.personal)}</b>（不請款）</span>${unrec ? `<span class="b-unrec" id="unrec">${icon('card', 'ic-s')}${unrec} 筆未對實扣</span>` : ''}</div>
    ${dl ? `<div class="deadline ${dlCls}" id="deadline">${icon('clock', 'ic-s')}<span>報帳期限 <b>${dl.daysLeft < 0 ? `已逾期 ${-dl.daysLeft} 天` : `剩 ${dl.daysLeft} 天`}</b>（${dl.due} 到期 · 最早費用日 ${dl.base} 起算 60 天）</span></div><div class="meter ${dlCls}"><i style="width:${pct}%"></i></div>` : ''}
  </section>
  ${bannerHtml}
  <section id="list">
  ${sorted.length ? Object.entries(groups).map(([d, list]) => {
    const meals = list.filter((e) => e.business !== false && e.category === 'Meals').reduce((s, e) => { const n = ntdOf(e, trip).ntd || 0; return s + (e.shared ? n / Math.max(2, attendeeList(e).length) : n); }, 0);
    return `<h3 class="day"><span>${esc(d)}</span>${meals ? `<span>個人餐費 ≈ USD ${Math.round(meals / usd)} / ${LIMITS.mealUsdPerDay}</span>` : ''}</h3>
    <div class="group">${list.map((e) => itemRow(e, trip, ev.byId[e.id] || [])).join('')}</div>`;
  }).join('') : '<div class="empty small"><p>還沒有費用。出差中每筆花費拍一下收據或付款截圖就好。</p></div>'}
  </section>

  <details class="card" id="rates" ${used.some((c) => !(trip.rates || {})[c]) ? 'open' : ''}>
    <summary>💱 匯率（估算台幣用，可隨時改）</summary>
    <p class="muted small">1 單位外幣 = ? 台幣。刷卡入帳後填「實扣台幣」會取代估算。USD 匯率用來換算政策門檻（收據 USD ${LIMITS.receiptUsd}、餐費 USD ${LIMITS.mealUsdPerDay}/天）。</p>
    ${rateCurs.map((c) => `<label class="rate-row"><span>${esc(c)}${c === 'USD' ? '（政策換算）' : ''}</span><input type="number" inputmode="decimal" step="any" min="0" data-rate="${esc(c)}" value="${esc((trip.rates || {})[c] ?? '')}" placeholder="例 ${DEFAULT_RATES[c] ?? ''}"></label>`).join('')}
    <div class="two"><input id="new-cur" placeholder="其他幣別，例 SGD" maxlength="5" autocapitalize="characters"><button class="btn" id="add-cur">加入</button></div>
  </details>

  <section class="card actions">
    <button class="btn block" id="reconcile">${icon('card')}對帳：匯入卡帳／填實扣台幣</button>
    <button class="btn btn-tinted block" id="export">${icon('share')}匯出公司 Excel／收據</button>
    <button class="btn block" id="backup">💾 備份這趟（JSON）</button>
  </section>
  <p class="privacy">${icon('lock')}資料只存在這支手機</p>`;

  setBar(`<button class="btn btn-icon" id="add-library" aria-label="相簿或截圖">${icon('image')}相簿</button><button class="btn btn-icon" id="add-manual" aria-label="手動輸入">${icon('pencil')}手動</button><button class="btn btn-primary btn-lg" id="add-camera">${icon('camera')}拍小票</button>`, () => {
    $('#add-camera').onclick = () => pickPhoto('camera', trip);
    $('#add-library').onclick = () => pickPhoto('library', trip);
    $('#add-manual').onclick = () => { newDraft(trip); location.hash = `#/trip/${trip.id}/e/new`; };
  });
  $('#reconcile').onclick = () => (location.hash = `#/trip/${trip.id}/reconcile`);
  view.querySelectorAll('[data-go-reconcile]').forEach((b) => (b.onclick = () => (location.hash = `#/trip/${trip.id}/reconcile`)));
  $('#export').onclick = () => exportSheet(trip, exps);
  $('#backup').onclick = () => backupSheet([trip]);
  // 公／私一鍵切換（不進編輯頁；私人不計入請款但仍參與對帳）
  view.querySelectorAll('[data-pp]').forEach((b) => (b.onclick = async () => {
    const e = exps.find((x) => x.id === b.dataset.pp); if (!e) return;
    e.business = e.business === false; e.updatedAt = Date.now(); await db.put('expenses', e);
    const y = window.scrollY; await render(); window.scrollTo(0, y);
  }));
  view.querySelectorAll('[data-rate]').forEach((inp) => (inp.onchange = async () => {
    trip.rates = trip.rates || {}; const v = inp.value === '' ? undefined : +inp.value;
    if (v === undefined) delete trip.rates[inp.dataset.rate]; else trip.rates[inp.dataset.rate] = v;
    await db.put('trips', trip); toast('匯率已更新'); render();
  }));
  $('#add-cur').onclick = async () => {
    const c = $('#new-cur').value.trim().toUpperCase(); if (!/^[A-Z]{3,5}$/.test(c)) { toast('請輸入 3 碼幣別，例 SGD'); return; }
    trip.rates = trip.rates || {}; if (trip.rates[c] === undefined) trip.rates[c] = null; await db.put('trips', trip); render();
  };
}

function itemRow(e, trip, warns) {
  const { ntd, actual } = ntdOf(e, trip);
  const cur = curOf(e);
  const lv = warns.some((w) => w.level === 'error') ? 'error' : warns.some((w) => w.level === 'warn') ? 'warn' : '';
  const biz = e.business !== false; const key = CAT_KEY[e.category] || 'misc';
  const a1 = cur !== 'NTD' ? `${esc(cur)} ${amt(amountOf(e))}` : `NT$ ${money(ntd)}`;
  const a2 = cur === 'NTD' ? '' : !biz ? `<div class="a2">NT$ ${money(ntd)}</div>` : actual ? `<div class="a2 ok">✓ NT$ ${money(ntd)}</div>` : `<div class="a2 est">估 NT$ ${money(ntd)}</div>`;
  const meta = [esc(e.category), e.payMethod ? esc(e.payMethod) : '', (e.photos || []).length ? icon('receipt', 'ic-s') : '', e.shared ? icon('users', 'ic-s') : '', hasCard(e) && settleCard(e.card).merged ? '已合併' : ''].filter(Boolean).join(' · ');
  return `<div class="cell ${biz ? '' : 'personal'} ${lv}" data-id="${e.id}">
    <a class="cell-link" href="#/trip/${trip.id}/e/${e.id}"><span class="cat-ic c-${key}">${icon(key)}</span>
      <div class="main"><div class="l1">${esc(e.description || '（未填說明）')}</div><div class="l2">${meta}</div>
      ${warns.filter((w) => w.level !== 'info').map((w) => `<span class="iw ${w.level}">${LEVEL_ICON[w.level]} ${esc(w.msg)}</span>`).join('')}</div>
      <div class="amt"><div class="a1">${a1}</div>${a2}</div></a>
    <button type="button" class="pp ${biz ? 'biz' : 'priv'}" data-pp="${e.id}" aria-label="${biz ? '公事（點一下改為私人）' : '私人（點一下改為公事）'}" aria-pressed="${!biz}">${biz ? '公' : '私'}</button></div>`;
}

// ---------- photo capture ----------
// 任何錯誤都要讓使用者看得到（不靜默）
function showError(title, err) {
  console.error(title, err);
  const msg = `${title}：${(err && err.message) || err}`;
  try { toast(msg, 8000); } catch (_) { /* ignore */ }
  const st = document.getElementById('ocr-status'); if (st) st.textContent = '⚠️ ' + msg;
}
window.addEventListener('error', (e) => showError('發生錯誤', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => showError('發生錯誤', e.reason));
setImageWarnHandler((m) => { console.warn(m); try { toast('⚠️ ' + m, 5000); } catch (_) { /* ignore */ } });

function pickPhoto(kind, trip, forDraft = false) {
  const input = kind === 'camera' ? $('#file-camera') : $('#file-library');
  input.value = '';
  input.onchange = async () => {
    const files = [...input.files]; if (!files.length) return;
    if (!forDraft) { newDraft(trip); }
    const first = !draft.photos.length;
    let added = 0;
    for (const f of files) {
      try { await addPhotoToDraft(f); added++; } catch (err) { showError('照片處理失敗', err); }
    }
    try {
      if (!forDraft) location.hash = `#/trip/${trip.id}/e/new`;
      else await editorView(trip, draftIsNew ? 'new' : draft.id, true);
    } catch (err) { showError('畫面更新失敗', err); }
    if (added && first && settings.autoOcr) runOcr(trip).catch((err) => showError('辨識失敗', err));
  };
  input.click();
}
async function addPhotoToDraft(file) {
  const { blob } = await compressImage(file);
  const id = db.uid();
  await db.put('photos', { id, blob, createdAt: Date.now() });
  draft.photos.push(id); draft._newPhotos = (draft._newPhotos || []).concat(id);
  draftPhotoUrls[id] = URL.createObjectURL(blob); ocrSrc[id] = file;
}
function newDraft(trip) {
  const main = Object.keys(trip.rates || {}).find((c) => c !== 'USD' && trip.rates[c]) || 'NTD';
  const today = todayStr();
  draft = { id: db.uid(), tripId: trip.id, date: today >= trip.from && today <= trip.to ? today : trip.from, category: '', description: '', currency: main, customCurrency: '', amount: '', actualNtd: '', business: true, shared: false, attendees: '', seniorPays: true, note: '', photos: [], receiptSeparate: false, cabin: 'Economy', legUnder5h: false, legHours: '', domestic: false, preApproval: false, nights: '', payMethod: settings.lastPay || '信用卡', createdAt: Date.now() };
  draftIsNew = true; draftPhotoUrls = {}; ocrState = { running: false, status: '', text: '', filled: new Set(), dateFlag: null, dateRaw: '' };
}

function guessCategory(text) {
  const t = text.toLowerCase();
  if (/hotel|resort|inn\b|酒店|飯店|饭店|旅館|住宿|宾馆|โรงแรม|check-?in|room/.test(t)) return 'Hotel';
  if (/didi|滴滴|grab|uber|taxi|計程車|出租车|高德|amap|bolt|lyft|地铁|地鐵|mtr|bts|mrt|train|railway|高铁|高鐵|airport transfer|接送|shuttle|toll|parking|停車/.test(t)) return 'Transportation';
  if (/esim|roaming|漫遊|漫游|sim|中華電信|data plan|ais|dtac|true move/.test(t)) return 'Communication';
  if (/airline|airways|boarding|e-?ticket|機票|机票|航空|flight/.test(t)) return 'Air ticket';
  if (/restaurant|bistro|diner|grill|noodle|cafe|coffee|餐厅|餐廳|餐|飯|饭|麵|面|食|bar|pub|kitchen|burger|mcdonald|starbucks|ร้านอาหาร|อาหาร|烧烤|燒烤|奶茶|茶/.test(t)) return 'Meals';
  return '';
}

async function runOcr(trip) {
  if (!draft || !draft.photos.length || ocrState.running) return;
  ocrState.running = true; ocrState.status = '準備辨識…'; updateOcrUi();
  try {
    const pid = draft.photos[0];
    const p = await db.get('photos', pid);
    ocrState.status = '影像前處理…'; updateOcrUi();
    let src = p.blob;
    try { src = await prepareForOcr(ocrSrc[pid] || p.blob); } catch (e) { console.warn('prepareForOcr failed, using stored photo', e); ocrState.status = '前處理失敗，改用原圖辨識…'; updateOcrUi(); src = p.blob; }
    const { recognize, parseReceipt, pickLangs } = await getOcr();
    const langs = pickLangs(settings.ocrLangs, Object.keys(trip.rates || {}));
    const text = await recognize(src, langs, (m) => {
      const pct = m.progress ? ` ${Math.round(m.progress * 100)}%` : '';
      const label = { 'loading tesseract core': '載入辨識引擎', 'loading language traineddata': '載入語言資料（第一次較久）', 'initializing api': '初始化', 'recognizing text': '辨識中' }[m.status] || m.status;
      ocrState.status = label + pct; updateOcrUi();
    });
    ocrState.text = text;
    const main = Object.keys(trip.rates || {}).find((c) => c !== 'USD' && trip.rates[c]) || 'NTD';
    const r = parseReceipt(text, draft.currency || main);
    ocrState.dateFlag = r.date ? r.dateFlag : null; ocrState.dateRaw = r.dateRaw || '';
    const form = $('#exp-form');
    const fill = (name, val) => {
      if (val === null || val === undefined || val === '') return;
      const el = form && form.elements[name];
      if (el && el.value && !ocrState.filled.has(name) && name !== 'currency' && name !== 'date') return; // don't override what user typed
      if (el) { el.value = val; el.classList.add('ocr'); }
      draft[name] = val; ocrState.filled.add(name);
    };
    if (r.date) fill('date', r.date);
    if (r.amount) fill('amount', r.amount);
    if (r.currency) { const c = CURRENCIES.includes(r.currency) ? r.currency : 'OTHER'; fill('currency', c); }
    const cat = guessCategory(text.split('\n').map(tidy).join('\n'));
    if (cat && !draft.category) { draft.category = cat; ocrState.filled.add('category'); }
    if (r.merchant && !draft.description) {
      const prefix = { Meals: 'Meal - ', Transportation: 'Taxi - ', Hotel: 'Hotel - ' }[draft.category] || '';
      fill('description', prefix + r.merchant);
    }
    ocrState.status = r.amount ? '✅ 已帶入辨識結果，請核對' : '辨識完成，但沒找到金額，請手動輸入';
    if (ocrState.dateFlag) ocrState.status += '；⚠️ 日期請確認';
  } catch (err) {
    console.error(err); ocrState.status = '⚠️ 辨識失敗：' + ((err && err.message) || err) + '（可手動輸入）'; try { toast(ocrState.status, 8000); } catch (_) { /* ignore */ }
  } finally {
    ocrState.running = false;
    if (location.hash.includes('/e/')) { syncDraftFromForm(); await editorView(trip, draftIsNew ? 'new' : draft.id, true); }
  }
}
function updateOcrUi() { const el = $('#ocr-status'); if (el) el.textContent = ocrState.status; }

// ---------- expense editor ----------
async function editorView(trip, eid, keepDraft = false) {
  if (!keepDraft || !draft) {
    if (eid === 'new') { if (!draft || draft.tripId !== trip.id || !draftIsNew) newDraft(trip); }
    else {
      const e = await db.get('expenses', eid); if (!e) { location.hash = `#/trip/${trip.id}`; return; }
      if (!draft || draft.id !== e.id) { draft = { ...e, photos: [...(e.photos || [])] }; draftIsNew = false; draftPhotoUrls = {}; ocrState = { running: false, status: '', text: '', filled: new Set(), dateFlag: null, dateRaw: '' }; }
    }
  }
  for (const pid of draft.photos) if (!draftPhotoUrls[pid]) { const p = await db.get('photos', pid); if (p) draftPhotoUrls[pid] = URL.createObjectURL(p.blob); }
  const back = async () => { await discardDraftIfNew(); location.hash = `#/trip/${trip.id}`; };
  setTop(draftIsNew ? '新增費用' : '編輯費用', { back });
  const d = draft;
  const otherCurs = Object.keys(trip.rates || {}).filter((c) => !CURRENCIES.includes(c));
  const curOptions = [...CURRENCIES, ...otherCurs];
  const curVal = d.currency === 'OTHER' && curOptions.includes((d.customCurrency || '').toUpperCase()) ? d.customCurrency.toUpperCase() : d.currency;
  const fb = (n) => (ocrState.filled.has(n) ? 'ocr' : '');

  const biz = d.business !== false;
  view.innerHTML = `<form class="form" id="exp-form" autocomplete="off">
    <section class="card photos">
      <div class="thumbs">${d.photos.map((pid) => `<div class="thumb"><img src="${draftPhotoUrls[pid] || ''}" alt="收據照片" data-view="${pid}"><button type="button" class="x" data-rm="${pid}" aria-label="移除照片">×</button></div>`).join('')}
      <button type="button" class="thumb add" id="ph-cam">📷<span>拍照</span></button>
      <button type="button" class="thumb add" id="ph-lib">🖼️<span>相簿</span></button></div>
      ${d.photos.length ? `<div class="ocr-row"><span id="ocr-status" class="muted small">${esc(ocrState.status || '可以用辨識帶入日期、店家、幣別、金額')}</span>
        <button type="button" class="btn small" id="ocr-run" ${ocrState.running ? 'disabled' : ''}>🔍 辨識</button></div>` : '<p class="muted small">收據或付款截圖（支付寶、微信、Grab…）都可以。</p>'}
      ${ocrState.text ? `<details><summary class="small">辨識原文</summary><pre class="ocr-text">${esc(ocrState.text)}</pre></details>` : ''}
    </section>

    <section class="card">
      <div class="seg" role="radiogroup" aria-label="公務或私人">
        <button type="button" role="radio" aria-checked="${biz}" class="${biz ? 'on' : ''}" data-biz="1">${icon('briefcase', 'ic-s')}公事</button>
        <button type="button" role="radio" aria-checked="${!biz}" class="${!biz ? 'on personal' : ''}" data-biz="0">${icon('user', 'ic-s')}私人（不報）</button>
      </div>
      <div class="amount-row">
        <select name="currency" aria-label="幣別" class="${fb('currency')}">${curOptions.map((c) => `<option ${curVal === c ? 'selected' : ''}>${c}</option>`).join('')}<option value="OTHER" ${curVal === 'OTHER' ? 'selected' : ''}>其他…</option></select>
        <input name="amount" type="number" inputmode="decimal" step="any" value="${esc(d.amount)}" placeholder="0.00" aria-label="原幣金額" class="${fb('amount')}">
      </div>
      <label class="${curVal === 'OTHER' ? '' : 'hidden'}" id="custom-cur">其他幣別代碼<input name="customCurrency" maxlength="5" value="${esc(d.customCurrency)}" placeholder="例 SGD" autocapitalize="characters"></label>
      <div class="ntd-box fx-line" id="ntd-box"></div>
      <label id="actual-wrap">刷卡實扣台幣（含國外手續費，入帳後再填）<input name="actualNtd" type="number" inputmode="numeric" step="any" value="${esc(d.actualNtd)}" placeholder="選填，填了會取代估算"></label>
      <div class="hint-line"><ul class="warnlist" id="live-warn" style="margin:0"></ul></div>
    </section>

    <div class="label">類別 Category ${ocrState.filled.has('category') ? `<span class="sugg">${icon('sparkle')}依收據建議</span>` : ''}</div>
    <div class="catgrid" id="cats" role="radiogroup" aria-label="類別">${CATS.map((c) => { const k = CAT_KEY[c]; const on = d.category === c; return `<button type="button" role="radio" aria-checked="${on}" class="catchip c-${k} ${on ? 'on' : ''}" data-cat="${c}">${icon(k)}<span>${c}</span><b class="tick"></b></button>`; }).join('')}</div>

    <section class="card" style="margin-top:12px">
      <label>日期<input type="date" name="date" required value="${esc(d.date)}" class="${fb('date')}"></label>
      ${ocrState.dateFlag && ocrState.filled.has('date') ? `<div class="small date-flag" id="date-flag" role="alert" style="color:#b45309;margin:-4px 0 8px">⚠️ 辨識到「${esc(ocrState.dateRaw)}」→ ${esc(d.date)}，${ocrState.dateFlag === 'future' ? '晚於今天' : '早於一年前'}，請確認日期 <button type="button" class="btn small" id="date-ok">日期無誤</button></div>` : ''}
      <label>說明 Description（英文為佳，會印在 Excel）<input name="description" value="${esc(d.description)}" placeholder="例：Dinner - Penny Black Pub / Taxi (Grab)" class="${fb('description')}"></label>
    </section>

    <section class="card ${d.category === 'Air ticket' ? '' : 'hidden'}" id="air-box">
      <label>艙等<select name="cabin">${CABINS.map((c) => `<option ${d.cabin === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label>航程時數（小時，可填 2.75；用於「&lt; 5 小時只能經濟艙」檢查）<input name="legHours" type="number" inputmode="decimal" step="0.25" min="0" value="${esc(d.legHours)}" placeholder="例 3.5"></label>
      <label class="check"><input type="checkbox" name="legUnder5h" ${d.legUnder5h ? 'checked' : ''}> 沒填時數時：有航段飛行時間 &lt; 5 小時</label>
      <label class="check"><input type="checkbox" name="domestic" ${d.domestic ? 'checked' : ''}> 國內機票（門檻 USD 1,500；國際 USD 4,000）</label>
      <label class="check"><input type="checkbox" name="preApproval" ${d.preApproval ? 'checked' : ''}> 已附書面事前核准（pre-approval attached）</label>
    </section>
    <section class="card ${d.category === 'Hotel' ? '' : 'hidden'}" id="hotel-box">
      <label>住宿晚數<input name="nights" type="number" inputmode="numeric" min="1" step="1" value="${esc(d.nights)}"></label>
    </section>
    <section class="card ${d.category === 'Meals' ? '' : 'hidden'}" id="meal-box">
      <label class="check"><input type="checkbox" name="shared" ${d.shared ? 'checked' : ''}> 多人用餐（同事／客戶）</label>
      <div id="shared-box" class="${d.shared ? '' : 'hidden'}">
        <label>出席者（全部列出，含自己；逗號分隔）<input name="attendees" value="${esc(d.attendees)}" placeholder="例：Bruce Yeh, Andy Liu"></label>
        <label class="check"><input type="checkbox" name="seniorPays" ${d.seniorPays ? 'checked' : ''}> 我是出席者中職級最高、由我付款</label>
        <p class="muted small">客戶餐請在說明或備註寫商務目的。</p>
      </div>
    </section>

    <div class="label">付款 <span class="muted" style="font-weight:400">· 預設上次</span></div>
    <div class="paychips" id="pays" role="radiogroup" aria-label="付款工具">${PAY_METHODS.map((m) => `<button type="button" role="radio" aria-checked="${d.payMethod === m}" class="paychip ${d.payMethod === m ? 'on' : ''}" data-pay="${m}">${m}</button>`).join('')}</div>

    <section class="card" style="margin-top:12px">
      <label class="check"><input type="checkbox" name="receiptSeparate" ${d.receiptSeparate ? 'checked' : ''}> 收據另外附（紙本／信用卡帳單截圖）</label>
      <label>備註<textarea name="note" rows="2" placeholder="選填">${esc(d.note)}</textarea></label>
    </section>
  </form>`;
  setBar(`${draftIsNew ? '' : `<button type="button" class="btn btn-danger btn-lg" id="del-exp" style="width:96px;flex:none">刪除</button>`}<button type="submit" form="exp-form" class="btn btn-primary btn-lg" id="save-exp">儲存</button>`);

  const form = $('#exp-form');
  const refresh = () => {
    syncDraftFromForm();
    const cur = curOf(draft);
    const { ntd, actual } = ntdOf(draft, trip);
    const rate = rateOf(draft, trip);
    $('#ntd-box').innerHTML = cur === 'NTD' ? `<span class="badge b-ok">✓ 台幣</span><b>NT$ ${money(ntd)}</b>` :
      `<span class="badge ${actual ? 'b-ok' : 'b-est'}">${actual ? '✓ 實扣' : '估'}</span><b>≈ NT$ ${money(ntd)}</b> <span class="muted small">匯率 ${rate ?? '—'}${!actual && !(trip.rates || {})[cur] ? `（請先在出差頁設定 ${esc(cur)} 匯率）` : ''}</span>`;
    $('#actual-wrap').classList.toggle('hidden', cur === 'NTD');
    $('#custom-cur').classList.toggle('hidden', form.elements.currency.value !== 'OTHER');
    ['air-box', 'hotel-box', 'meal-box'].forEach((id, i) => $('#' + id).classList.toggle('hidden', draft.category !== ['Air ticket', 'Hotel', 'Meals'][i]));
    $('#shared-box').classList.toggle('hidden', !draft.shared);
    liveWarn(trip);
  };
  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);
  form.querySelectorAll('[data-biz]').forEach((b) => (b.onclick = () => { draft.business = b.dataset.biz === '1'; form.querySelectorAll('[data-biz]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); }); b.classList.toggle('personal', !draft.business); refresh(); }));
  form.querySelectorAll('[data-pay]').forEach((b) => (b.onclick = () => { draft.payMethod = b.dataset.pay; form.querySelectorAll('[data-pay]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); }); }));
  form.querySelectorAll('[data-cat]').forEach((b) => (b.onclick = () => { draft.category = b.dataset.cat; form.querySelectorAll('[data-cat]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); }); refresh(); }));
  form.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => { if (!confirm('移除這張照片？')) return; syncDraftFromForm(); draft.photos = draft.photos.filter((p) => p !== b.dataset.rm); draft._removed = (draft._removed || []).concat(b.dataset.rm); await editorView(trip, draftIsNew ? 'new' : draft.id, true); }));
  form.querySelectorAll('[data-view]').forEach((img) => (img.onclick = () => sheet(`<img class="full" src="${img.src}" alt="收據"><button class="btn block" data-close>關閉</button>`)));
  $('#ph-cam').onclick = () => { syncDraftFromForm(); pickPhoto('camera', trip, true); };
  $('#ph-lib').onclick = () => { syncDraftFromForm(); pickPhoto('library', trip, true); };
  const dateOk = $('#date-ok'); if (dateOk) dateOk.onclick = () => { ocrState.dateFlag = null; const f = $('#date-flag'); if (f) f.remove(); };
  const dateIn = form.elements.date; if (dateIn) dateIn.addEventListener('change', () => { ocrState.dateFlag = null; const f = $('#date-flag'); if (f) f.remove(); });
  const ocrBtn = $('#ocr-run'); if (ocrBtn) ocrBtn.onclick = () => { syncDraftFromForm(); runOcr(trip); };
  form.onsubmit = async (ev) => {
    ev.preventDefault(); syncDraftFromForm();
    if (!draft.category) { toast('請選類別'); return; }
    if (draft.amount === '' || isNaN(+draft.amount)) { toast('請輸入金額'); return; }
    const rec = { ...draft }; delete rec._newPhotos; delete rec._removed;
    rec.amount = +rec.amount; rec.actualNtd = rec.actualNtd === '' ? '' : +rec.actualNtd;
    rec.legHours = rec.legHours === '' || rec.legHours === undefined ? '' : +rec.legHours;
    rec.updatedAt = Date.now();
    const prev = draftIsNew ? null : await db.get('expenses', rec.id);
    await db.put('expenses', rec);
    for (const pid of draft._removed || []) await db.del('photos', pid);
    settings.lastPay = rec.payMethod || settings.lastPay; saveSettings();
    const tid = trip.id; draft = null; location.hash = `#/trip/${tid}`;
    toast('已存', 4000, { label: '復原', onClick: async () => { if (prev) await db.put('expenses', prev); else await db.deleteExpense(rec); toast('已復原'); render(); } });
  };
  const delBtn = $('#del-exp');
  if (delBtn) delBtn.onclick = async () => { if (!confirm('刪除這筆費用？')) return; const e = await db.get('expenses', draft.id); if (e) await db.deleteExpense(e); for (const pid of draft._newPhotos || []) await db.del('photos', pid); draft = null; toast('已刪除'); location.hash = `#/trip/${trip.id}`; };
  refresh();
}

function syncDraftFromForm() {
  const form = $('#exp-form'); if (!form || !draft) return;
  const el = form.elements;
  for (const n of ['date', 'description', 'amount', 'actualNtd', 'customCurrency', 'attendees', 'note', 'cabin', 'nights', 'legHours']) if (el[n]) draft[n] = el[n].value;
  const c = el.currency.value;
  if (CURRENCIES.includes(c) || c === 'OTHER') draft.currency = c; else { draft.currency = 'OTHER'; draft.customCurrency = c; }
  if (draft.currency !== 'OTHER') draft.customCurrency = '';
  for (const n of ['shared', 'seniorPays', 'legUnder5h', 'domestic', 'preApproval', 'receiptSeparate']) if (el[n]) draft[n] = el[n].checked;
}
async function discardDraftIfNew() {
  if (!draft) return;
  if (!draftIsNew) { draft = null; return; }
  for (const pid of draft._newPhotos || []) await db.del('photos', pid);
  draft = null;
}
async function liveWarn(trip) {
  const exps = (await db.expensesOf(trip.id)).filter((e) => e.id !== draft.id);
  const rec = { ...draft, amount: draft.amount === '' ? NaN : +draft.amount };
  const ev = evaluate(trip, [...exps, rec]);
  const ws = ev.byId[draft.id] || [];
  const ul = $('#live-warn'); if (!ul) return;
  ul.innerHTML = draft.business === false ? '<li class="info">🛍️ 私人消費：不會匯出到報帳單</li>' : ws.map((w) => `<li class="${w.level}">${LEVEL_ICON[w.level]} ${esc(w.msg)}</li>`).join('');
}

// ---------- reconcile（design-spec 9.1 對帳）----------
let recState = { res: null, later: new Set(), fileName: '' };
async function reconcileView(trip) {
  setTop('對帳', { back: `#/trip/${trip.id}` });
  const exps = await db.expensesOf(trip.id);
  const foreign = exps.filter((e) => e.business !== false && curOf(e) !== 'NTD').sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const sel = (e) => {
    const n = ntdOf(e, trip); const st = n.settle;
    const simple = !st || (st.dupCharges === 0 && st.refund === 0 && !st.fullyRefunded);
    return { n, st, simple, actualVal: hasCard(e) ? (simple ? st.ntd : st.ntd) : e.actualNtd, feeVal: hasCard(e) && simple ? st.fee : '' };
  };
  view.innerHTML = `<section class="card"><h2>匯入卡帳</h2>
    <p class="muted small">CSV 欄位：post_date, txn_date, merchant_on_statement, original_ccy, original_amt, twd_charged, fx_fee_twd。依「交易日 ±3 天＋原幣金額＋幣別」自動配對；同商家同額的重複扣款與退款會建議合併。檔案只在這支手機上處理。</p>
    <button class="btn btn-tinted block" id="import-stmt">${icon('card')}選擇卡帳 CSV</button></section>
    <div id="rec-proposals"></div>
    <div class="section-h"><span>外幣費用 · 手動填實扣</span></div>
    ${foreign.length ? foreign.map((e) => { const s = sel(e); const locked = hasCard(e) && !s.simple;
      return `<div class="card rec-row" data-rec="${e.id}"><div><b>${esc(e.date)}</b> ${esc(e.description || CAT_ZH[e.category])}<div class="muted small">${esc(curOf(e))} ${amt(amountOf(e))} · ${s.n.actual ? `<span class="tag actual">✓ 已對帳</span>` : `<span class="tag est">估</span> NT$ ${money(s.n.ntd)}`}${locked ? ` · ${esc(s.st.text)}` : ''}</div>
        ${!s.n.actual && NON_CARD_PAY.includes(e.payMethod) ? `<button class="btn small" data-confirm="${e.id}" style="margin-top:6px">確認估計為最終</button>` : ''}</div>
        <input type="number" inputmode="numeric" step="any" data-actual="${e.id}" value="${esc(s.actualVal)}" placeholder="實扣 NT$" aria-label="實扣台幣" ${locked ? 'disabled' : ''}>
        <input type="number" inputmode="numeric" step="any" data-fee="${e.id}" value="${esc(s.feeVal)}" placeholder="手續費" aria-label="其中手續費" ${locked ? 'disabled' : ''}></div>`; }).join('') : '<div class="empty small"><p>沒有外幣費用。</p></div>'}`;

  const save = async (e) => { e.updatedAt = Date.now(); await db.put('expenses', e); };
  view.querySelectorAll('[data-actual],[data-fee]').forEach((inp) => (inp.onchange = async () => {
    const id = inp.dataset.actual || inp.dataset.fee; const row = inp.closest('.rec-row');
    const a = row.querySelector('[data-actual]').value; const f = row.querySelector('[data-fee]').value;
    const e = await db.get('expenses', id);
    if (a === '') { e.actualNtd = ''; delete e.card; }
    else if (f !== '' && +f > 0) { e.card = [{ type: 'charge', amt: +e.amount, ntd: +a - +f, fee: +f }]; e.actualNtd = ''; }   // 有手續費 → 產生 Description 算式
    else { delete e.card; e.actualNtd = +a; }
    await save(e); toast(a === '' ? '已清除，改回估算' : `已更新 NT$ ${money(+a)}`); await render();
  }));
  view.querySelectorAll('[data-confirm]').forEach((b) => (b.onclick = async () => { const e = await db.get('expenses', b.dataset.confirm); e.estConfirmed = true; await save(e); toast('已確認估計為最終'); await render(); }));
  $('#import-stmt').onclick = () => {
    const i = $('#file-statement'); i.value = '';
    i.onchange = async () => {
      try {
        const rows = parseStatement(await i.files[0].text());
        recState = { res: matchStatement(await db.expensesOf(trip.id), rows), later: new Set(), fileName: i.files[0].name };
        renderProposals(trip);
      } catch (err) { toast('匯入失敗：' + err.message, 5000); }
    };
    i.click();
  };
  if (recState.res) renderProposals(trip);
}

function renderProposals(trip) {
  const box = $('#rec-proposals'); if (!box || !recState.res) return;
  const { matches, unmatched } = recState.res;
  const by = (s) => matches.filter((m) => m.status === s);
  const ready = matches.filter((m) => m.lines.length);
  const merges = by('merge');
  const open = unmatched.filter((r) => !recState.later.has(r.idx));
  box.innerHTML = `<section class="card" id="rec-summary"><h2>配對結果 <span class="muted small">${esc(recState.fileName)}</span></h2>
    <div class="fx-line"><span class="badge b-ok">✓ 已配對 ${by('matched').length}</span><span class="badge b-info">建議合併 ${merges.length}</span><span class="badge b-est">私人 ${by('private').length}</span><span class="b-unrec">非卡支付 ${by('non-card').length}</span>${open.length ? `<span class="badge b-danger">找不到小票 ${open.length}</span>` : ''}</div>
    ${merges.map((m) => { const st = settleCard(m.lines); return `<p class="small" data-merge="${m.expenseId}"><b>建議合併</b> → NT$ ${money(st.ntd)}（${esc(st.text)}）</p>`; }).join('')}
    <button class="btn btn-primary block" id="apply-matches" ${ready.length ? '' : 'disabled'}>套用 ${ready.length} 筆配對${merges.length ? `（含 ${merges.length} 筆合併）` : ''}</button></section>
    ${open.map((r) => `<div class="card rec-card" data-unknown="${r.idx}"><b>${esc(r.merchant)}</b> <span class="muted small">${esc(r.txn)}</span>
      <div>${esc(r.ccy)} ${amt(Math.abs(r.amt))} · NT$ ${money(Math.abs(r.ntd) + Math.abs(r.fee))}</div>
      <div class="rec-actions"><button class="btn small" data-unk="biz" data-i="${r.idx}">公事補登</button><button class="btn small" data-unk="priv" data-i="${r.idx}">私人</button><button class="btn small" data-unk="later" data-i="${r.idx}">稍後</button></div></div>`).join('')}`;
  $('#apply-matches').onclick = async () => {
    const exps = await db.expensesOf(trip.id);
    const updated = applyMatches(exps, recState.res, { acceptMerge: true });
    const changed = updated.filter((e, i) => e !== exps[i]);
    await db.putMany('expenses', changed);
    recState.res = { ...recState.res, matches: [] };
    toast(`已套用 ${changed.length} 筆配對`); await render();
  };
  box.querySelectorAll('[data-unk]').forEach((b) => (b.onclick = async () => {
    const r = unmatched.find((x) => x.idx === +b.dataset.i);
    if (b.dataset.unk === 'later') { recState.later.add(r.idx); renderProposals(trip); return; }
    const std = CURRENCIES.includes(r.ccy);
    const e = { id: db.uid(), tripId: trip.id, date: r.txn, category: 'Misc', description: r.merchant, currency: std ? r.ccy : 'OTHER', customCurrency: std ? '' : r.ccy, amount: Math.abs(r.amt), actualNtd: '', card: [{ type: 'charge', amt: Math.abs(r.amt), ntd: Math.abs(r.ntd), fee: Math.abs(r.fee) }], business: b.dataset.unk === 'biz', shared: false, attendees: '', seniorPays: true, note: '由卡帳補登', photos: [], receiptSeparate: false, cabin: 'Economy', legUnder5h: false, legHours: '', domestic: false, preApproval: false, nights: '', payMethod: '信用卡', createdAt: Date.now() };
    await db.put('expenses', e); recState.later.add(r.idx);
    toast(b.dataset.unk === 'biz' ? '已補登為公事（Misc，請確認類別）' : '已記為私人（不請款）'); await render();
  }));
}

// ---------- export ----------
function exportSheet(trip, exps) {
  const ev = evaluate(trip, exps);
  const blocking = Object.values(ev.byId).flat().filter((w) => w.level === 'error').length;
  sheet(`<h2>匯出</h2>
    <p class="muted small">只匯出公務費用（${ev.totals.count} 筆，NT$ ${money(ev.totals.business)}）。台幣和總額都寫成數字，iPhone 預覽也看得到。</p>
    ${blocking ? `<p class="error small">⛔ 有 ${blocking} 筆缺匯率或金額，會以空白匯出。</p>` : ''}
    ${ev.totals.estimated ? `<p class="warn small">⚠️ ${ev.totals.estimated} 筆台幣仍是估算，送件前建議先填實扣金額。</p>` : ''}
    <div class="exp-step" id="x-xlsx"><button class="btn primary block" data-build="xlsx">📊 產生公司 Excel</button></div>
    <div class="exp-step" id="x-zip"><button class="btn block" data-build="zip">🗂️ 產生收據照片 ZIP（依 No. 命名）</button></div>
    <button class="btn block ghost" data-close>關閉</button>`, (el) => {
    el.querySelectorAll('[data-build]').forEach((b) => (b.onclick = async () => {
      b.disabled = true; b.textContent = '產生中…';
      try {
        const freshExps = await db.expensesOf(trip.id);
        const res = b.dataset.build === 'xlsx' ? await buildXlsx(trip, freshExps, settings) : await buildReceiptsZip(trip, freshExps);
        window.__lastExport = res; // (for automated tests)
        const box = b.parentElement;
        box.innerHTML = `<div class="ready">✅ ${esc(res.name)}<span class="muted small">${b.dataset.build === 'xlsx' ? `${res.count} 筆 · Total NT$ ${money(res.total)}` : `${res.count} 張照片`}</span></div>
          <button class="btn primary block" data-share>⬆️ 分享／儲存到「檔案」</button>`;
        box.querySelector('[data-share]').onclick = async () => { const r = await shareOrDownload(res.blob, res.name); if (r === 'downloaded') toast('已下載'); };
      } catch (err) { console.error(err); b.disabled = false; b.textContent = '重試'; toast('匯出失敗：' + err.message, 5000); }
    }));
  });
}

function backupSheet(trips, includeAll = false) {
  sheet(`<h2>備份</h2><p class="muted small">備份檔（JSON）包含${includeAll ? '所有出差' : '這趟出差'}的資料，可存到「檔案」或 iCloud，換手機時用「還原」匯回。</p>
    <label class="check"><input type="checkbox" id="bk-photos" checked> 包含收據照片（檔案較大）</label>
    <div class="exp-step"><button class="btn primary block" id="bk-build">產生備份檔</button></div>
    <button class="btn block ghost" data-close>關閉</button>`, (el) => {
    $('#bk-build', el).onclick = async (ev) => {
      const b = ev.target; b.disabled = true; b.textContent = '產生中…';
      const byTrip = {}; for (const t of trips) byTrip[t.id] = await db.expensesOf(t.id);
      const res = await buildBackup(trips, byTrip, $('#bk-photos', el).checked);
      window.__lastExport = res;
      b.parentElement.innerHTML = `<div class="ready">✅ ${esc(res.name)}<span class="muted small">${money(res.blob.size / 1024)} KB</span></div><button class="btn primary block" id="bk-share">⬆️ 分享／儲存</button>`;
      $('#bk-share', el).onclick = () => shareOrDownload(res.blob, res.name);
    };
  });
}

async function restoreFromFile(file) {
  const data = JSON.parse(await file.text());
  if (data.app !== 'bt-expense' || !Array.isArray(data.trips)) throw new Error('不是這個工具的備份檔');
  const existing = new Set((await db.all('trips')).map((t) => t.id));
  const dup = data.trips.filter((t) => existing.has(t.id)).length;
  if (dup && !confirm(`有 ${dup} 趟出差已存在，要用備份檔覆蓋嗎？`)) return;
  await db.putMany('trips', data.trips);
  await db.putMany('expenses', data.expenses || []);
  const photos = [];
  for (const p of data.photos || []) photos.push({ id: p.id, blob: await dataURLToBlob(p.dataURL), createdAt: Date.now() });
  await db.putMany('photos', photos);
  toast(`已還原 ${data.trips.length} 趟出差、${(data.expenses || []).length} 筆費用`);
  location.hash = '#/'; render();
}

// ---------- settings ----------
function settingsView() {
  setTop('設定', { back: '#/' });
  view.innerHTML = `<section class="card form">
    <h2>報帳單表頭（選填）</h2>
    <p class="muted small">只存在這支手機，匯出時填入 Employee Name／Number；留空則由你在 Excel 自己填。</p>
    <label>姓名 Employee Name<input id="s-name" value="${esc(settings.empName)}"></label>
    <label>員工編號 Employee Number<input id="s-no" value="${esc(settings.empNo)}"></label>
  </section>
  <section class="card form">
    <h2>收據辨識（OCR，在手機上執行）</h2>
    <label class="check"><input type="checkbox" id="s-auto" ${settings.autoOcr ? 'checked' : ''}> 拍照後自動辨識</label>
    <div class="label">辨識語言（選越多越慢；第一次使用每種語言約下載 1–3 MB）</div>
    ${OCR_LANGS.map(([k, n]) => `<label class="check"><input type="checkbox" data-lang="${k}" ${settings.ocrLangs.includes(k) ? 'checked' : ''}> ${n}（${k}）</label>`).join('')}
    <button class="btn block" id="s-precache">⬇️ 預先下載辨識資料（出國前在 Wi-Fi 下按一次）</button>
    <span class="muted small" id="s-precache-status"></span>
  </section>
  <section class="card form">
    <h2>外觀</h2>
    <label>主題<select id="s-theme"><option value="" ${!settings.theme ? 'selected' : ''}>跟隨系統</option><option value="light" ${settings.theme === 'light' ? 'selected' : ''}>淺色</option><option value="dark" ${settings.theme === 'dark' ? 'selected' : ''}>深色</option></select></label>
  </section>
  <section class="card form">
    <h2>備份／還原</h2>
    <button class="btn block" id="s-backup">💾 備份全部出差（JSON）</button>
    <button class="btn block" id="s-restore">📥 從備份檔還原</button>
  </section>
  <section class="card form">
    <h2>關於</h2>
    <p class="small">規則依 Butterfly T&E Policy（2026-03-17）＋台灣流程：60 天內送件、單筆 &gt; USD ${LIMITS.receiptUsd} 附收據、個人餐費每日 USD ${LIMITS.mealUsdPerDay}、航程 &lt; 5 小時經濟艙（豪經須事前核准）、住宿一般城市 USD ${LIMITS.hotelGuideLow}–${LIMITS.hotelGuideHigh}／晚、多人用餐由職級最高者付並列出席者、私人消費不報。實際以公司最新政策為準。</p>
    <p class="small muted">所有資料（含照片）只存在本機瀏覽器，不會上傳。清除 Safari 網站資料或刪除主畫面 App 會一併刪除，請定期備份。</p>
    <button class="btn danger block" id="s-clear">清除這支手機上的全部資料</button>
  </section>`;
  $('#s-name').onchange = (e) => { settings.empName = e.target.value.trim(); saveSettings(); toast('已儲存'); };
  $('#s-no').onchange = (e) => { settings.empNo = e.target.value.trim(); saveSettings(); toast('已儲存'); };
  $('#s-auto').onchange = (e) => { settings.autoOcr = e.target.checked; saveSettings(); };
  $('#s-theme').onchange = (e) => { settings.theme = e.target.value; saveSettings(); applyTheme(); };
  view.querySelectorAll('[data-lang]').forEach((c) => (c.onchange = () => {
    settings.ocrLangs = [...view.querySelectorAll('[data-lang]:checked')].map((x) => x.dataset.lang);
    if (!settings.ocrLangs.length) { settings.ocrLangs = ['eng']; c.checked = true; }
    saveSettings();
  }));
  $('#s-precache').onclick = async () => {
    const st = $('#s-precache-status'); const files = ['vendor/tesseract/tesseract.min.js', 'vendor/tesseract/worker.min.js', 'vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js', 'vendor/tesseract/core/tesseract-core-lstm.wasm.js', ...settings.ocrLangs.map((l) => `vendor/tesseract/lang/${l}.traineddata.gz`)];
    try { const c = await caches.open('bt-ocr-v1'); let i = 0; for (const f of files) { st.textContent = `下載中 ${++i}/${files.length}…`; await c.add(f); } st.textContent = '✅ 已可離線辨識'; }
    catch (err) { st.textContent = '下載失敗：' + err.message; }
  };
  $('#s-backup').onclick = async () => backupSheet(await db.all('trips'), true);
  $('#s-restore').onclick = () => { const i = $('#file-restore'); i.value = ''; i.onchange = async () => { try { await restoreFromFile(i.files[0]); } catch (err) { toast('還原失敗：' + err.message, 5000); } }; i.click(); };
  $('#s-clear').onclick = async () => { if (!confirm('確定清除全部出差、費用和照片？建議先備份。')) return; await db.clearAll(); toast('已清除'); location.hash = '#/'; };
}

// ---------- boot ----------
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e)));
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
window.__app = { db, settings, tidy };
applyTheme(); applyDynType();
window.addEventListener('resize', applyDynType); document.addEventListener('visibilitychange', applyDynType);
render();
