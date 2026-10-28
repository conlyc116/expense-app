import * as db from './db.js';
import { CATS, CAT_ZH, CURRENCIES, DEFAULT_RATES, CABINS, LIMITS, PAY_METHODS, NON_CARD_PAY, evaluate, ntdOf, rateOf, curOf, amountOf, hasCard, settleCard, normCur, todayStr, attendeeList, usdRate } from './policy.js';
import { icon, CAT_KEY } from './icons.js';
import { t as tr, LANGS, LANG_NAMES, getLang, setLang, initLang, onLangChange, catLabel, payLabel } from './i18n.js';
import { parseStatement, matchStatement, applyMatches } from './reconcile.js';
import { compressImage, prepareForOcr, dataURLToBlob, setImageWarnHandler, errMsg, stepErr } from './image.js';
import { APP_VERSION } from './version.js';
// ocr.js（→ dateparse.js）改為「用到才載入」：任何一個檔漏傳／路徑錯，只會讓辨識失敗並顯示訊息，不會讓整個 app 起不來。
let ocrMod = null;
async function getOcr() {
  if (!ocrMod) { try { ocrMod = await import('./ocr.js'); } catch (e) { throw new Error(tr('ocr.moduleFail', { msg: e.message || e })); } }
  return ocrMod;
}
const tidy = (s) => { const CJK = '\u3400-\u9fff\uf900-\ufaff'; return s.replace(new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'g'), '$1').replace(/[ \t]+/g, ' ').trim(); };
import { buildXlsx, buildReceiptsZip, buildBackup, shareOrDownload } from './export.js';

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
initLang(); // 第一次開啟依瀏覽器語言；之後用 localStorage 的選擇
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, d = 0) => (n === null || n === undefined || isNaN(n) ? '—' : Number(n).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }));
const amt = (n) => (n === '' || n === null || n === undefined ? '' : Number(n).toLocaleString('zh-TW', { maximumFractionDigits: 2 }));
const h = (k, p) => esc(tr(k, p)); // HTML 樣板用（會跳脫）；toast／confirm／textContent 用 tr()
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
const OCR_LANGS = ['eng', 'chi_sim', 'chi_tra', 'tha'];

function setTop(title, { back = null, action = null, lang = false } = {}) {
  $('#tb-title').textContent = title;
  const lb = $('#tb-lang'); if (lb) { lb.hidden = !lang; lb.textContent = getLang() === 'en' ? '中' : 'EN'; lb.setAttribute('aria-label', tr('lang.switchAria')); lb.onclick = () => setLang(getLang() === 'en' ? 'zh-Hant' : 'en'); }
  const b = $('#tb-back'); b.hidden = !back; b.textContent = tr('common.backBtn'); b.setAttribute('aria-label', tr('common.back')); b.onclick = back ? () => (typeof back === 'function' ? back() : (location.hash = back)) : null;
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

// ---------- language ----------
function applyStaticText() {
  document.title = tr('app.title');
  const m = document.querySelector('meta[name="apple-mobile-web-app-title"]'); if (m) m.setAttribute('content', tr('app.title'));
  const ns = document.querySelector('noscript'); if (ns) ns.textContent = tr('common.noscript');
  const b = $('#tb-back'); if (b) { b.textContent = tr('common.backBtn'); b.setAttribute('aria-label', tr('common.back')); }
}
onLangChange(() => { applyStaticText(); render(); });
applyStaticText();

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
  } catch (err) { console.error(err); view.innerHTML = `<div class="card error">${h('common.errorDetail', { msg: errMsg(err) })}</div>`; }
  finally { window.scrollTo(0, 0); }
}

async function quickAdd() {
  const t = pickTrip(await db.all('trips'));
  if (!t) { location.hash = '#/new-trip'; return; }
  newDraft(t); location.hash = `#/trip/${t.id}/e/new`;
}

// ---------- trips list ----------
async function tripsView() {
  setTop(tr('app.title'), { lang: true, action: { label: '⚙︎', aria: tr('trips.settingsAria'), onClick: () => (location.hash = '#/settings') } });
  const trips = (await db.all('trips')).sort((a, b) => (b.from || '').localeCompare(a.from || ''));
  const today = todayStr();
  const info = [];
  for (const t of trips) { const exps = await db.expensesOf(t.id); info.push({ t, exps, ev: evaluate(t, exps, { lang: getLang() }) }); }
  const ongoing = info.find((x) => x.t.from <= today && today <= x.t.to);
  const initials = (s) => { const w = String(s || '?').trim(); return /^[\x00-\x7f]/.test(w) ? w.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || '?' : w.slice(0, 2); };
  const dlBadge = (dl) => (dl ? `<span class="badge ${dl.daysLeft < 0 || dl.daysLeft <= LIMITS.deadlineDangerDays ? 'b-danger' : dl.daysLeft <= LIMITS.deadlineWarnDays ? 'b-warn' : 'b-info'}">${icon('clock', 'ic-s')}${dl.daysLeft < 0 ? h('trips.overdue') : h('trips.daysLeft', { n: dl.daysLeft })}</span>` : '');
  const cell = ({ t, ev }) => `<a class="cell" href="#/trip/${t.id}" data-trip="${t.id}"><div class="cat-ic c-misc">${esc(initials(t.destination))}</div>
      <div class="main"><div class="l1">${esc(t.destination || tr('common.unnamed'))}</div><div class="l2">${esc(t.from)} – ${esc(t.to)} · ${h('trips.items', { n: ev.totals.count })}</div></div>
      <div class="amt">${dlBadge(ev.deadline)}<div class="a2" style="margin-top:2px">NT$ ${money(ev.totals.business)}</div></div>${icon('right', 'ic-s')}</a>`;
  const hero = ongoing ? (() => { const { t, ev } = ongoing; const warnN = Object.values(ev.byId).flat().filter((w) => w.level !== 'info').length;
    return `<a class="card" href="#/trip/${t.id}" data-trip="${t.id}" data-ongoing="1"><div class="badge b-ok">${h('trips.ongoing')}</div>
      <div class="trip-title" style="margin-top:6px">${esc(t.destination || tr('common.unnamed'))}</div><div class="muted small">${esc(t.from)} – ${esc(t.to)} · ${h('trips.items', { n: ev.totals.count })}</div>
      <div class="sum-total">NT$ ${money(ev.totals.business)}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">${dlBadge(ev.deadline)}${warnN ? `<span class="badge b-warn">${icon('warn', 'ic-s')}${h('trips.needAction', { n: warnN })}</span>` : ''}${ev.totals.estimated ? `<span class="b-unrec">${h('trips.unconfirmed', { n: ev.totals.estimated })}</span>` : ''}</div></a>`; })() : '';
  const rest = info.filter((x) => x !== ongoing);
  view.innerHTML = `<h2 class="large-title">${h('trips.title')}</h2>
    ${trips.length ? hero + (rest.length ? `<div class="section-h"><span>${h(ongoing ? 'trips.others' : 'trips.all')}</span></div><div class="group">${rest.map(cell).join('')}</div>` : '') : `<div class="empty"><div class="empty-icon">🧾</div><p>${h('trips.emptyTitle')}</p><p class="muted">${h('trips.emptyHint')}</p></div>`}
    <p class="privacy">${icon('lock')}${h('trips.privacy')}</p>`;
  const target = ongoing ? ongoing.t : (info[0] || {}).t;
  setBar(target ? `<button class="btn btn-icon" id="new-trip" aria-label="${h('trips.newAria')}">${icon('plus')}${h('trips.new')}</button><button class="btn btn-primary btn-lg" id="bar-camera">${icon('camera')}${h('trips.camera')}</button>` : `<button class="btn btn-primary btn-lg" id="new-trip">${icon('plus')}${h('trips.newTrip')}</button>`, () => {
    $('#new-trip').onclick = () => (location.hash = '#/new-trip');
    if (target) $('#bar-camera').onclick = () => pickPhoto('camera', target);
  });
}

// ---------- trip form ----------
function tripForm(trip) {
  const t = trip || { id: db.uid(), destination: '', from: todayStr(), to: todayStr(), rates: { ...DEFAULT_RATES }, notes: '', createdAt: Date.now() };
  setTop(tr(trip ? 'tripForm.editTitle' : 'tripForm.newTitle'), { back: trip ? `#/trip/${t.id}` : '#/' });
  view.innerHTML = `<form class="card form" id="trip-form">
    <label>${h('tripForm.dest')}<input name="destination" required placeholder="${h('tripForm.destPh')}" value="${esc(t.destination)}"></label>
    <div class="two"><label>${h('tripForm.from')}<input type="date" name="from" required value="${esc(t.from)}"></label>
    <label>${h('tripForm.to')}<input type="date" name="to" required value="${esc(t.to)}"></label></div>
    <label>${h('tripForm.notes')}<textarea name="notes" rows="3" placeholder="${h('tripForm.notesPh')}">${esc(t.notes)}</textarea></label>
    <p class="muted small">${h('tripForm.rateHint')}</p>
    <button class="btn primary block" type="submit">${h(trip ? 'common.save' : 'tripForm.create')}</button>
    ${trip ? `<button class="btn danger block" type="button" id="del-trip">${h('tripForm.delete')}</button>` : ''}
  </form>`;
  $('#trip-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    Object.assign(t, { destination: f.get('destination').trim(), from: f.get('from'), to: f.get('to'), notes: f.get('notes') });
    if (t.to < t.from) { toast(tr('tripForm.dateOrder')); return; }
    await db.put('trips', t);
    location.hash = `#/trip/${t.id}`;
  };
  if (trip) $('#del-trip').onclick = async () => {
    if (!confirm(tr('tripForm.confirmDelete'))) return;
    await db.deleteTrip(t.id); toast(tr('common.deleted')); location.hash = '#/';
  };
}

// ---------- trip view ----------
const LV_ORDER = { error: 0, warn: 1, info: 2 };
async function tripView(trip) {
  setTop(trip.destination || tr('trip.fallbackTitle'), { back: '#/', action: { label: tr('common.edit'), onClick: () => (location.hash = `#/trip/${trip.id}/edit`) } });
  const exps = await db.expensesOf(trip.id);
  const ev = evaluate(trip, exps, { lang: getLang() });
  const sorted = exps.slice().sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.createdAt || 0) - (b.createdAt || 0));
  const groups = {};
  sorted.forEach((e) => (groups[e.date || tr('common.noDate')] = groups[e.date || tr('common.noDate')] || []).push(e));
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
    const [cls, ic] = BN[w.level]; const act = w.key === 'pol.sumEstimated' ? `<button class="act" data-go-reconcile>${h('trip.reconcileBtn')}</button>` : '';
    return `<div class="banner ${cls}" data-level="${w.level}">${icon(ic)}<div style="min-width:0"><div class="bt">${esc(w.msg)}</div></div>${act}</div>`;
  });
  const bannerHtml = banners.length ? `<div class="section-h"><span>${h('trip.attention', { n: banners.length })}</span></div><div class="banners" id="banners">${banners.slice(0, 3).join('')}${banners.length > 3 ? `<details class="more-banners"><summary>${h('trip.moreItems', { n: banners.length - 3 })}</summary><div class="banners">${banners.slice(3).join('')}</div></details>` : ''}</div>` : `<div class="banner bn-ok" id="banners">${icon('ok')}<div><div class="bt">${h('trip.noIssues')}</div></div></div>`;

  view.innerHTML = `
  <section class="card summary" id="summary">
    <div class="muted small">${esc(trip.from)} – ${esc(trip.to)} · ${h('trip.bizCount', { n: ev.totals.count })}</div>
    <div class="sum-total" id="sum-total">NT$ ${money(ev.totals.business)}</div>
    <div class="sum-split"><span>${h('trip.personal')} <b>NT$ ${money(ev.totals.personal)}</b>${h('trip.notClaimed')}</span>${unrec ? `<span class="b-unrec" id="unrec">${icon('card', 'ic-s')}${h('trips.unconfirmed', { n: unrec })}</span>` : ''}</div>
    ${dl ? `<div class="deadline ${dlCls}" id="deadline">${icon('clock', 'ic-s')}<span>${h('trip.deadlineLabel')} <b>${dl.daysLeft < 0 ? h('trip.overdueDays', { n: -dl.daysLeft }) : h('trips.daysLeft', { n: dl.daysLeft })}</b>${h('trip.deadlineNote', { due: dl.due, base: dl.base, days: LIMITS.deadlineDays })}</span></div><div class="meter ${dlCls}"><i style="width:${pct}%"></i></div>` : ''}
  </section>
  ${bannerHtml}
  <section id="list">
  ${sorted.length ? Object.entries(groups).map(([d, list]) => {
    const meals = list.filter((e) => e.business !== false && e.category === 'Meals').reduce((s, e) => { const n = ntdOf(e, trip).ntd || 0; return s + (e.shared ? n / Math.max(2, attendeeList(e).length) : n); }, 0);
    return `<h3 class="day"><span>${esc(d)}</span>${meals ? `<span>${h('trip.mealsDay', { usd: Math.round(meals / usd), cap: LIMITS.mealUsdPerDay })}</span>` : ''}</h3>
    <div class="group">${list.map((e) => itemRow(e, trip, ev.byId[e.id] || [])).join('')}</div>`;
  }).join('') : `<div class="empty small"><p>${h('trip.emptyList')}</p></div>`}
  </section>

  <details class="card" id="rates" ${used.some((c) => !(trip.rates || {})[c]) ? 'open' : ''}>
    <summary>${h('trip.ratesTitle')}</summary>
    <p class="muted small">${h('trip.ratesHint', { receipt: LIMITS.receiptUsd, meal: LIMITS.mealUsdPerDay })}</p>
    ${rateCurs.map((c) => `<label class="rate-row"><span>${esc(c)}${c === 'USD' ? h('trip.usdPolicy') : ''}</span><input type="number" inputmode="decimal" step="any" min="0" data-rate="${esc(c)}" value="${esc((trip.rates || {})[c] ?? '')}" placeholder="${h('trip.ratePh', { v: DEFAULT_RATES[c] ?? '' })}"></label>`).join('')}
    <div class="two"><input id="new-cur" placeholder="${h('trip.otherCurPh')}" maxlength="5" autocapitalize="characters"><button class="btn" id="add-cur">${h('common.add')}</button></div>
  </details>

  <section class="card actions">
    <button class="btn block" id="reconcile">${icon('card')}${h('trip.reconcileAction')}</button>
    <button class="btn btn-tinted block" id="export">${icon('share')}${h('trip.exportAction')}</button>
    <button class="btn block" id="backup">${h('trip.backupAction')}</button>
  </section>
  <p class="privacy">${icon('lock')}${h('trip.privacy')}</p>`;

  setBar(`<button class="btn btn-icon" id="add-library" aria-label="${h('trip.libraryAria')}">${icon('image')}${h('trip.library')}</button><button class="btn btn-icon" id="add-manual" aria-label="${h('trip.manualAria')}">${icon('pencil')}${h('trip.manual')}</button><button class="btn btn-primary btn-lg" id="add-camera">${icon('camera')}${h('trips.camera')}</button>`, () => {
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
    await db.put('trips', trip); toast(tr('trip.rateUpdated')); render();
  }));
  $('#add-cur').onclick = async () => {
    const c = $('#new-cur').value.trim().toUpperCase(); if (!/^[A-Z]{3,5}$/.test(c)) { toast(tr('trip.curInvalid')); return; }
    trip.rates = trip.rates || {}; if (trip.rates[c] === undefined) trip.rates[c] = null; await db.put('trips', trip); render();
  };
}

function itemRow(e, trip, warns) {
  const { ntd, actual } = ntdOf(e, trip);
  const cur = curOf(e);
  const lv = warns.some((w) => w.level === 'error') ? 'error' : warns.some((w) => w.level === 'warn') ? 'warn' : '';
  const biz = e.business !== false; const key = CAT_KEY[e.category] || 'misc';
  const a1 = cur !== 'NTD' ? `${esc(cur)} ${amt(amountOf(e))}` : `NT$ ${money(ntd)}`;
  const a2 = cur === 'NTD' ? '' : !biz ? `<div class="a2">NT$ ${money(ntd)}</div>` : actual ? `<div class="a2 ok">✓ NT$ ${money(ntd)}</div>` : `<div class="a2 est">${h('item.est', { n: money(ntd) })}</div>`;
  const meta = [esc(catLabel(e.category)), e.payMethod ? esc(payLabel(e.payMethod)) : '', (e.photos || []).length ? icon('receipt', 'ic-s') : '', e.shared ? icon('users', 'ic-s') : '', hasCard(e) && settleCard(e.card).merged ? tr('item.merged') : ''].filter(Boolean).join(' · ');
  return `<div class="cell ${biz ? '' : 'personal'} ${lv}" data-id="${e.id}">
    <a class="cell-link" href="#/trip/${trip.id}/e/${e.id}"><span class="cat-ic c-${key}">${icon(key)}</span>
      <div class="main"><div class="l1">${esc(e.description || tr('common.noDesc'))}</div><div class="l2">${meta}</div>
      ${warns.filter((w) => w.level !== 'info').map((w) => `<span class="iw ${w.level}">${LEVEL_ICON[w.level]} ${esc(w.msg)}</span>`).join('')}</div>
      <div class="amt"><div class="a1">${a1}</div>${a2}</div></a>
    <button type="button" class="pp ${biz ? 'biz' : 'priv'}" data-pp="${e.id}" aria-label="${h(biz ? 'item.bizAria' : 'item.privAria')}" aria-pressed="${!biz}">${h(biz ? 'item.biz' : 'item.priv')}</button></div>`;
}

// ---------- photo capture ----------
// 任何錯誤都要讓使用者看得到（不靜默）
// 診斷記錄（最近 30 筆，存 localStorage；設定頁可複製）。包含：時間、版本、步驟、錯誤名稱、訊息、UA
const DIAG_KEY = 'bt-diag';
function diagLog(step, err) {
  try {
    const l = JSON.parse(localStorage.getItem(DIAG_KEY) || '[]');
    l.push({ t: new Date().toISOString(), v: APP_VERSION, step, name: (err && err.name) || typeof err, msg: errMsg(err), ua: navigator.userAgent });
    while (l.length > 30) l.shift();
    localStorage.setItem(DIAG_KEY, JSON.stringify(l));
  } catch (_) { /* ignore */ }
}
let photoErr = ''; // 照片錯誤要留在畫面上（toast 會消失），按「知道了」才關
function showError(title, err) {
  console.error(title, err); diagLog(title, err);
  const msg = `${title}${tr('common.colon')}${errMsg(err)}`;
  try { toast(msg, 8000); } catch (_) { /* ignore */ }
  const st = document.getElementById('ocr-status'); if (st) st.textContent = '⚠️ ' + msg;
}
window.addEventListener('error', (e) => showError(tr('common.errorPrefix'), e.error || e.message));
window.addEventListener('unhandledrejection', (e) => showError(tr('common.errorPrefix'), e.reason));
let photoNotes = []; // 前處理過程的警告（不即時 toast，避免被後面的訊息蓋掉）
setImageWarnHandler((m) => { console.warn(m); photoNotes.push(m); });
const flushNotes = () => { const n = photoNotes; photoNotes = []; return n; };

function pickPhoto(kind, trip, forDraft = false) {
  const input = kind === 'camera' ? $('#file-camera') : $('#file-library');
  input.value = '';
  input.onchange = async () => {
    const files = [...input.files]; if (!files.length) return;
    if (!forDraft) { newDraft(trip); }
    const first = !draft.photos.length;
    let added = 0;
    const notes = [];
    for (const f of files) {
      try { notes.push(...await addPhotoToDraft(f)); added++; photoErr = ''; } catch (err) { showError(tr('photo.errTitle'), err); photoErr = tr('photo.errPanel', { detail: errMsg(err) }); }
    }
    try {
      if (!forDraft) location.hash = `#/trip/${trip.id}/e/new`;
      else await editorView(trip, draftIsNew ? 'new' : draft.id, true);
    } catch (err) { showError(tr('photo.uiErrTitle'), err); }
    if (notes.length) { try { toast('⚠️ ' + notes.join(tr('common.semi')), 9000); } catch (_) { /* ignore */ } }
    if (added && first && settings.autoOcr) runOcr(trip).catch((err) => showError(tr('photo.ocrErrTitle'), err));
  };
  input.click();
}
// 存照片：壓縮版 → 壓縮版的新副本 → 原檔的新副本，逐一嘗試寫入 IndexedDB；任何失敗都記下真正原因。
// （iOS Safari 對「檔案型 Blob」或 canvas 產生的 Blob 偶爾會寫入失敗，重建成記憶體內 Blob 通常可解）
async function addPhotoToDraft(file) {
  flushNotes();
  const notes = [];
  let comp = null;
  try { comp = (await compressImage(file)).blob; } catch (e) { notes.push(tr('photo.compressFail', { msg: errMsg(e) })); diagLog('compress', e); }
  const copy = async (b) => new Blob([await b.arrayBuffer()], { type: b.type || 'image/jpeg' });
  const cands = [];
  if (comp) { cands.push(['compressed', async () => comp], ['compressedCopy', () => copy(comp)]); }
  cands.push(['originalCopy', () => copy(file)], ['original', async () => file], ['buffer', null]);
  const id = db.uid(); let saved = null; const errs = [];
  for (const [name, mk] of cands) {
    try {
      if (name === 'buffer') { // 最後手段：存 ArrayBuffer（Safari 無法存 Blob 時）
        const src = comp || file; const buf = await src.arrayBuffer(); const type = src.type || 'image/jpeg';
        await db.put('photos', { id, buf, type, createdAt: Date.now() }); saved = new Blob([buf], { type });
      } else {
        const b = await mk(); await db.put('photos', { id, blob: b, createdAt: Date.now() }); saved = b;
      }
      if (name !== 'compressed') notes.push(tr('photo.savedAs', { name: tr('photo.cand.' + name) })); break;
    } catch (e) { errs.push(`${tr('photo.cand.' + name)}${tr('common.colon')}${errMsg(e)}`); diagLog('save:' + name, e); }
  }
  if (!saved) throw stepErr('save', new Error(errs.join(tr('common.semi'))));
  notes.push(...flushNotes());
  draft.photos.push(id); draft._newPhotos = (draft._newPhotos || []).concat(id);
  draftPhotoUrls[id] = URL.createObjectURL(saved); ocrSrc[id] = file;
  return notes;
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
  ocrState.running = true; ocrState.status = tr('ocr.preparing'); updateOcrUi();
  try {
    const pid = draft.photos[0];
    const p = await db.get('photos', pid);
    ocrState.status = tr('ocr.preprocessing'); updateOcrUi();
    let src = p.blob;
    try { src = await prepareForOcr(ocrSrc[pid] || p.blob); } catch (e) { console.warn('prepareForOcr failed, using stored photo', errMsg(e)); ocrState.status = tr('ocr.preprocessFail'); updateOcrUi(); src = p.blob; }
    const { recognize, parseReceipt, pickLangs } = await getOcr();
    const langs = pickLangs(settings.ocrLangs, Object.keys(trip.rates || {}));
    const text = await recognize(src, langs, (m) => {
      const pct = m.progress ? ` ${Math.round(m.progress * 100)}%` : '';
      const label = { 'loading tesseract core': tr('ocr.s.core'), 'loading language traineddata': tr('ocr.s.lang'), 'initializing api': tr('ocr.s.init'), 'recognizing text': tr('ocr.s.run') }[m.status] || m.status;
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
    ocrState.status = tr(r.amount ? 'ocr.done' : 'ocr.noAmount');
    if (ocrState.dateFlag) ocrState.status += tr('ocr.dateCheck');
  } catch (err) {
    console.error(err); ocrState.status = tr('ocr.fail', { msg: errMsg(err) }); try { toast(ocrState.status, 8000); } catch (_) { /* ignore */ }
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
  setTop(tr(draftIsNew ? 'exp.newTitle' : 'exp.editTitle'), { back });
  const d = draft;
  const otherCurs = Object.keys(trip.rates || {}).filter((c) => !CURRENCIES.includes(c));
  const curOptions = [...CURRENCIES, ...otherCurs];
  const curVal = d.currency === 'OTHER' && curOptions.includes((d.customCurrency || '').toUpperCase()) ? d.customCurrency.toUpperCase() : d.currency;
  const fb = (n) => (ocrState.filled.has(n) ? 'ocr' : '');

  const biz = d.business !== false;
  view.innerHTML = `<form class="form" id="exp-form" autocomplete="off">
    <section class="card photos">
      ${photoErr ? `<div class="card error small" id="photo-err" role="alert" style="margin:0 0 8px;word-break:break-word">${esc(photoErr)} <button type="button" class="btn small" id="photo-err-x">${h('photo.dismiss')}</button></div>` : ''}
      <div class="thumbs">${d.photos.map((pid) => `<div class="thumb"><img src="${draftPhotoUrls[pid] || ''}" alt="${h('exp.photoAlt')}" data-view="${pid}"><button type="button" class="x" data-rm="${pid}" aria-label="${h('exp.photoRm')}">×</button></div>`).join('')}
      <button type="button" class="thumb add" id="ph-cam">📷<span>${h('exp.cam')}</span></button>
      <button type="button" class="thumb add" id="ph-lib">🖼️<span>${h('exp.lib')}</span></button></div>
      ${d.photos.length ? `<div class="ocr-row"><span id="ocr-status" class="muted small">${esc(ocrState.status || tr('ocr.idle'))}</span>
        <button type="button" class="btn small" id="ocr-run" ${ocrState.running ? 'disabled' : ''}>${h('ocr.run')}</button></div>` : `<p class="muted small">${h('exp.photoHint')}</p>`}
      ${ocrState.text ? `<details><summary class="small">${h('ocr.rawText')}</summary><pre class="ocr-text">${esc(ocrState.text)}</pre></details>` : ''}
    </section>

    <section class="card">
      <div class="seg" role="radiogroup" aria-label="${h('exp.bizAria')}">
        <button type="button" role="radio" aria-checked="${biz}" class="${biz ? 'on' : ''}" data-biz="1">${icon('briefcase', 'ic-s')}${h('exp.biz')}</button>
        <button type="button" role="radio" aria-checked="${!biz}" class="${!biz ? 'on personal' : ''}" data-biz="0">${icon('user', 'ic-s')}${h('exp.priv')}</button>
      </div>
      <div class="amount-row">
        <select name="currency" aria-label="${h('exp.curAria')}" class="${fb('currency')}">${curOptions.map((c) => `<option ${curVal === c ? 'selected' : ''}>${c}</option>`).join('')}<option value="OTHER" ${curVal === 'OTHER' ? 'selected' : ''}>${h('exp.curOther')}</option></select>
        <input name="amount" type="number" inputmode="decimal" step="any" value="${esc(d.amount)}" placeholder="0.00" aria-label="${h('exp.amountAria')}" class="${fb('amount')}">
      </div>
      <label class="${curVal === 'OTHER' ? '' : 'hidden'}" id="custom-cur">${h('exp.customCur')}<input name="customCurrency" maxlength="5" value="${esc(d.customCurrency)}" placeholder="${h('exp.customCurPh')}" autocapitalize="characters"></label>
      <div class="ntd-box fx-line" id="ntd-box"></div>
      <label id="actual-wrap">${h('exp.actualNtd')}<input name="actualNtd" type="number" inputmode="numeric" step="any" value="${esc(d.actualNtd)}" placeholder="${h('exp.actualNtdPh')}"></label>
      <div class="hint-line"><ul class="warnlist" id="live-warn" style="margin:0"></ul></div>
    </section>

    <div class="label">${h('exp.category')} ${ocrState.filled.has('category') ? `<span class="sugg">${icon('sparkle')}${h('exp.suggested')}</span>` : ''}</div>
    <div class="catgrid" id="cats" role="radiogroup" aria-label="${h('exp.categoryAria')}">${CATS.map((c) => { const k = CAT_KEY[c]; const on = d.category === c; return `<button type="button" role="radio" aria-checked="${on}" class="catchip c-${k} ${on ? 'on' : ''}" data-cat="${c}">${icon(k)}<span>${esc(catLabel(c))}</span><b class="tick"></b></button>`; }).join('')}</div>

    <section class="card" style="margin-top:12px">
      <label>${h('exp.date')}<input type="date" name="date" required value="${esc(d.date)}" class="${fb('date')}"></label>
      ${ocrState.dateFlag && ocrState.filled.has('date') ? `<div class="small date-flag" id="date-flag" role="alert" style="color:#b45309;margin:-4px 0 8px">${h('ocr.dateFlag', { raw: ocrState.dateRaw, date: d.date, why: tr(ocrState.dateFlag === 'future' ? 'ocr.dateFuture' : 'ocr.dateOld') })} <button type="button" class="btn small" id="date-ok">${h('ocr.dateOk')}</button></div>` : ''}
      <label>${h('exp.desc')}<input name="description" value="${esc(d.description)}" placeholder="${h('exp.descPh')}" class="${fb('description')}"></label>
    </section>

    <section class="card ${d.category === 'Air ticket' ? '' : 'hidden'}" id="air-box">
      <label>${h('exp.cabin')}<select name="cabin">${CABINS.map((c) => `<option ${d.cabin === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label>${h('exp.legHours')}<input name="legHours" type="number" inputmode="decimal" step="0.25" min="0" value="${esc(d.legHours)}" placeholder="${h('exp.legHoursPh')}"></label>
      <label class="check"><input type="checkbox" name="legUnder5h" ${d.legUnder5h ? 'checked' : ''}> ${h('exp.legUnder5h')}</label>
      <label class="check"><input type="checkbox" name="domestic" ${d.domestic ? 'checked' : ''}> ${h('exp.domestic')}</label>
      <label class="check"><input type="checkbox" name="preApproval" ${d.preApproval ? 'checked' : ''}> ${h('exp.preApproval')}</label>
    </section>
    <section class="card ${d.category === 'Hotel' ? '' : 'hidden'}" id="hotel-box">
      <label>${h('exp.nights')}<input name="nights" type="number" inputmode="numeric" min="1" step="1" value="${esc(d.nights)}"></label>
    </section>
    <section class="card ${d.category === 'Meals' ? '' : 'hidden'}" id="meal-box">
      <label class="check"><input type="checkbox" name="shared" ${d.shared ? 'checked' : ''}> ${h('exp.shared')}</label>
      <div id="shared-box" class="${d.shared ? '' : 'hidden'}">
        <label>${h('exp.attendees')}<input name="attendees" value="${esc(d.attendees)}" placeholder="${h('exp.attendeesPh')}"></label>
        <label class="check"><input type="checkbox" name="seniorPays" ${d.seniorPays ? 'checked' : ''}> ${h('exp.seniorPays')}</label>
        <p class="muted small">${h('exp.clientMeal')}</p>
      </div>
    </section>

    <div class="label">${h('exp.pay')} <span class="muted" style="font-weight:400">${h('exp.payDefault')}</span></div>
    <div class="paychips" id="pays" role="radiogroup" aria-label="${h('exp.payAria')}">${PAY_METHODS.map((m) => `<button type="button" role="radio" aria-checked="${d.payMethod === m}" class="paychip ${d.payMethod === m ? 'on' : ''}" data-pay="${esc(m)}">${esc(payLabel(m))}</button>`).join('')}</div>

    <section class="card" style="margin-top:12px">
      <label class="check"><input type="checkbox" name="receiptSeparate" ${d.receiptSeparate ? 'checked' : ''}> ${h('exp.receiptSeparate')}</label>
      <label>${h('exp.note')}<textarea name="note" rows="2" placeholder="${h('exp.notePh')}">${esc(d.note)}</textarea></label>
    </section>
  </form>`;
  setBar(`${draftIsNew ? '' : `<button type="button" class="btn btn-danger btn-lg" id="del-exp" style="width:96px;flex:none">${h('exp.del')}</button>`}<button type="submit" form="exp-form" class="btn btn-primary btn-lg" id="save-exp">${h('common.save')}</button>`);

  const form = $('#exp-form');
  const refresh = () => {
    syncDraftFromForm();
    const cur = curOf(draft);
    const { ntd, actual } = ntdOf(draft, trip);
    const rate = rateOf(draft, trip);
    $('#ntd-box').innerHTML = draft.amount === '' ? '' : cur === 'NTD' ? `<span class="badge b-ok">${h('exp.ntdBadge')}</span><b>NT$ ${money(ntd)}</b>` :
      `<span class="badge ${actual ? 'b-ok' : 'b-est'}">${h(actual ? 'exp.actualBadge' : 'exp.estBadge')}</span><b>≈ NT$ ${money(ntd)}</b> <span class="muted small">${h('exp.rate', { rate: rate ?? '—' })}${!actual && !(trip.rates || {})[cur] ? h('exp.setRate', { cur }) : ''}</span>`;
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
  form.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => { if (!confirm(tr('exp.confirmRmPhoto'))) return; syncDraftFromForm(); draft.photos = draft.photos.filter((p) => p !== b.dataset.rm); draft._removed = (draft._removed || []).concat(b.dataset.rm); await editorView(trip, draftIsNew ? 'new' : draft.id, true); }));
  form.querySelectorAll('[data-view]').forEach((img) => (img.onclick = () => sheet(`<img class="full" src="${img.src}" alt="${h('exp.receiptAlt')}"><button class="btn block" data-close>${h('common.close')}</button>`)));
  $('#ph-cam').onclick = () => { syncDraftFromForm(); pickPhoto('camera', trip, true); };
  $('#ph-lib').onclick = () => { syncDraftFromForm(); pickPhoto('library', trip, true); };
  const perr = $('#photo-err-x'); if (perr) perr.onclick = () => { photoErr = ''; const b = $('#photo-err'); if (b) b.remove(); };
  const dateOk = $('#date-ok'); if (dateOk) dateOk.onclick = () => { ocrState.dateFlag = null; const f = $('#date-flag'); if (f) f.remove(); };
  const dateIn = form.elements.date; if (dateIn) dateIn.addEventListener('change', () => { ocrState.dateFlag = null; const f = $('#date-flag'); if (f) f.remove(); });
  const ocrBtn = $('#ocr-run'); if (ocrBtn) ocrBtn.onclick = () => { syncDraftFromForm(); runOcr(trip); };
  form.onsubmit = async (ev) => {
    ev.preventDefault(); syncDraftFromForm();
    if (!draft.category) { toast(tr('exp.pickCategory')); return; }
    if (draft.amount === '' || isNaN(+draft.amount)) { toast(tr('exp.enterAmount')); return; }
    const rec = { ...draft }; delete rec._newPhotos; delete rec._removed;
    rec.amount = +rec.amount; rec.actualNtd = rec.actualNtd === '' ? '' : +rec.actualNtd;
    rec.legHours = rec.legHours === '' || rec.legHours === undefined ? '' : +rec.legHours;
    rec.updatedAt = Date.now();
    const prev = draftIsNew ? null : await db.get('expenses', rec.id);
    await db.put('expenses', rec);
    for (const pid of draft._removed || []) await db.del('photos', pid);
    settings.lastPay = rec.payMethod || settings.lastPay; saveSettings();
    const tid = trip.id; draft = null; location.hash = `#/trip/${tid}`;
    toast(tr('common.saved'), 4000, { label: tr('common.undo'), onClick: async () => { if (prev) await db.put('expenses', prev); else await db.deleteExpense(rec); toast(tr('common.undone')); render(); } });
  };
  const delBtn = $('#del-exp');
  if (delBtn) delBtn.onclick = async () => { if (!confirm(tr('exp.confirmDelete'))) return; const e = await db.get('expenses', draft.id); if (e) await db.deleteExpense(e); for (const pid of draft._newPhotos || []) await db.del('photos', pid); draft = null; toast(tr('common.deleted')); location.hash = `#/trip/${trip.id}`; };
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
  const ev = evaluate(trip, [...exps, rec], { lang: getLang() });
  let ws = ev.byId[draft.id] || [];
  if (draft.amount === '') ws = ws.filter((w) => w.key !== 'pol.missingRate'); // 還沒輸入金額時不報「缺匯率或金額」；有金額且真的沒匯率才顯示
  const ul = $('#live-warn'); if (!ul) return;
  ul.innerHTML = draft.business === false ? `<li class="info">${h('exp.personalNote')}</li>` : ws.map((w) => `<li class="${w.level}">${LEVEL_ICON[w.level]} ${esc(w.msg)}</li>`).join('');
}

// ---------- reconcile（design-spec 9.1 對帳）----------
let recState = { res: null, later: new Set(), fileName: '' };
async function reconcileView(trip) {
  setTop(tr('rec.title'), { back: `#/trip/${trip.id}` });
  const exps = await db.expensesOf(trip.id);
  const foreign = exps.filter((e) => e.business !== false && curOf(e) !== 'NTD').sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const sel = (e) => {
    const n = ntdOf(e, trip); const st = n.settle;
    const simple = !st || (st.dupCharges === 0 && st.refund === 0 && !st.fullyRefunded);
    return { n, st, simple, actualVal: hasCard(e) ? (simple ? st.ntd : st.ntd) : e.actualNtd, feeVal: hasCard(e) && simple ? st.fee : '' };
  };
  view.innerHTML = `<section class="card"><h2>${h('rec.importTitle')}</h2>
    <p class="muted small">${h('rec.importHint')}</p>
    <button class="btn btn-tinted block" id="import-stmt">${icon('card')}${h('rec.pickCsv')}</button></section>
    <div id="rec-proposals"></div>
    <div class="section-h"><span>${h('rec.fxHeader')}</span></div>
    ${foreign.length ? foreign.map((e) => { const s = sel(e); const locked = hasCard(e) && !s.simple;
      return `<div class="card rec-row" data-rec="${e.id}"><div><b>${esc(e.date)}</b> ${esc(e.description || catLabel(e.category))}<div class="muted small">${esc(curOf(e))} ${amt(amountOf(e))} · ${s.n.actual ? `<span class="tag actual">${h('rec.reconciled')}</span>` : `<span class="tag est">${h('rec.est')}</span> NT$ ${money(s.n.ntd)}`}${locked ? ` · ${esc(s.st.text)}` : ''}</div>
        ${!s.n.actual && NON_CARD_PAY.includes(e.payMethod) ? `<button class="btn small" data-confirm="${e.id}" style="margin-top:6px">${h('rec.confirmEst')}</button>` : ''}</div>
        <input type="number" inputmode="numeric" step="any" data-actual="${e.id}" value="${esc(s.actualVal)}" placeholder="${h('rec.actualPh')}" aria-label="${h('rec.actualAria')}" ${locked ? 'disabled' : ''}>
        <input type="number" inputmode="numeric" step="any" data-fee="${e.id}" value="${esc(s.feeVal)}" placeholder="${h('rec.feePh')}" aria-label="${h('rec.feeAria')}" ${locked ? 'disabled' : ''}></div>`; }).join('') : `<div class="empty small"><p>${h('rec.noForeign')}</p></div>`}`;

  const save = async (e) => { e.updatedAt = Date.now(); await db.put('expenses', e); };
  view.querySelectorAll('[data-actual],[data-fee]').forEach((inp) => (inp.onchange = async () => {
    const id = inp.dataset.actual || inp.dataset.fee; const row = inp.closest('.rec-row');
    const a = row.querySelector('[data-actual]').value; const f = row.querySelector('[data-fee]').value;
    const e = await db.get('expenses', id);
    if (a === '') { e.actualNtd = ''; delete e.card; }
    else if (f !== '' && +f > 0) { e.card = [{ type: 'charge', amt: +e.amount, ntd: +a - +f, fee: +f }]; e.actualNtd = ''; }   // 有手續費 → 產生 Description 算式
    else { delete e.card; e.actualNtd = +a; }
    await save(e); toast(a === '' ? tr('rec.cleared') : tr('rec.updated', { n: money(+a) })); await render();
  }));
  view.querySelectorAll('[data-confirm]').forEach((b) => (b.onclick = async () => { const e = await db.get('expenses', b.dataset.confirm); e.estConfirmed = true; await save(e); toast(tr('rec.estConfirmed')); await render(); }));
  $('#import-stmt').onclick = () => {
    const i = $('#file-statement'); i.value = '';
    i.onchange = async () => {
      try {
        const rows = parseStatement(await i.files[0].text());
        recState = { res: matchStatement(await db.expensesOf(trip.id), rows), later: new Set(), fileName: i.files[0].name };
        renderProposals(trip);
      } catch (err) { toast(tr('rec.importFail', { msg: errMsg(err) }), 5000); }
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
  box.innerHTML = `<section class="card" id="rec-summary"><h2>${h('rec.resultTitle')} <span class="muted small">${esc(recState.fileName)}</span></h2>
    <div class="fx-line"><span class="badge b-ok">${h('rec.matched', { n: by('matched').length })}</span><span class="badge b-info">${h('rec.merge', { n: merges.length })}</span><span class="badge b-est">${h('rec.private', { n: by('private').length })}</span><span class="b-unrec">${h('rec.nonCard', { n: by('non-card').length })}</span>${open.length ? `<span class="badge b-danger">${h('rec.noReceipt', { n: open.length })}</span>` : ''}</div>
    ${merges.map((m) => { const st = settleCard(m.lines); return `<p class="small" data-merge="${m.expenseId}"><b>${h('rec.mergeLine')}</b> → NT$ ${money(st.ntd)}（${esc(st.text)}）</p>`; }).join('')}
    <button class="btn btn-primary block" id="apply-matches" ${ready.length ? '' : 'disabled'}>${h('rec.apply', { n: ready.length })}${merges.length ? h('rec.applyMerge', { n: merges.length }) : ''}</button></section>
    ${open.map((r) => `<div class="card rec-card" data-unknown="${r.idx}"><b>${esc(r.merchant)}</b> <span class="muted small">${esc(r.txn)}</span>
      <div>${esc(r.ccy)} ${amt(Math.abs(r.amt))} · NT$ ${money(Math.abs(r.ntd) + Math.abs(r.fee))}</div>
      <div class="rec-actions"><button class="btn small" data-unk="biz" data-i="${r.idx}">${h('rec.addBiz')}</button><button class="btn small" data-unk="priv" data-i="${r.idx}">${h('rec.addPriv')}</button><button class="btn small" data-unk="later" data-i="${r.idx}">${h('rec.later')}</button></div></div>`).join('')}`;
  $('#apply-matches').onclick = async () => {
    const exps = await db.expensesOf(trip.id);
    const updated = applyMatches(exps, recState.res, { acceptMerge: true });
    const changed = updated.filter((e, i) => e !== exps[i]);
    await db.putMany('expenses', changed);
    recState.res = { ...recState.res, matches: [] };
    toast(tr('rec.applied', { n: changed.length })); await render();
  };
  box.querySelectorAll('[data-unk]').forEach((b) => (b.onclick = async () => {
    const r = unmatched.find((x) => x.idx === +b.dataset.i);
    if (b.dataset.unk === 'later') { recState.later.add(r.idx); renderProposals(trip); return; }
    const std = CURRENCIES.includes(r.ccy);
    const e = { id: db.uid(), tripId: trip.id, date: r.txn, category: 'Misc', description: r.merchant, currency: std ? r.ccy : 'OTHER', customCurrency: std ? '' : r.ccy, amount: Math.abs(r.amt), actualNtd: '', card: [{ type: 'charge', amt: Math.abs(r.amt), ntd: Math.abs(r.ntd), fee: Math.abs(r.fee) }], business: b.dataset.unk === 'biz', shared: false, attendees: '', seniorPays: true, note: tr('rec.fromStmt', null, 'zh-Hant'), photos: [], receiptSeparate: false, cabin: 'Economy', legUnder5h: false, legHours: '', domestic: false, preApproval: false, nights: '', payMethod: '信用卡', createdAt: Date.now() };
    await db.put('expenses', e); recState.later.add(r.idx);
    toast(tr(b.dataset.unk === 'biz' ? 'rec.addedBiz' : 'rec.addedPriv')); await render();
  }));
}

// ---------- export ----------
function exportSheet(trip, exps) {
  const ev = evaluate(trip, exps);
  const blocking = Object.values(ev.byId).flat().filter((w) => w.level === 'error').length;
  sheet(`<h2>${h('exp.exportTitle')}</h2>
    <p class="muted small">${h('exp.exportHint', { n: ev.totals.count, total: money(ev.totals.business) })}</p>
    ${blocking ? `<p class="error small">${h('exp.blocking', { n: blocking })}</p>` : ''}
    ${ev.totals.estimated ? `<p class="warn small">${h('exp.estWarn', { n: ev.totals.estimated })}</p>` : ''}
    <div class="exp-step" id="x-xlsx"><button class="btn primary block" data-build="xlsx">${h('exp.buildXlsx')}</button></div>
    <div class="exp-step" id="x-zip"><button class="btn block" data-build="zip">${h('exp.buildZip')}</button></div>
    <button class="btn block ghost" data-close>${h('common.close')}</button>`, (el) => {
    el.querySelectorAll('[data-build]').forEach((b) => (b.onclick = async () => {
      b.disabled = true; b.textContent = tr('common.building');
      try {
        const freshExps = await db.expensesOf(trip.id);
        const res = b.dataset.build === 'xlsx' ? await buildXlsx(trip, freshExps, settings) : await buildReceiptsZip(trip, freshExps);
        window.__lastExport = res; // (for automated tests)
        const box = b.parentElement;
        box.innerHTML = `<div class="ready">✅ ${esc(res.name)}<span class="muted small">${b.dataset.build === 'xlsx' ? esc(tr('exp.xlsxMeta', { n: res.count, total: money(res.total) })) : esc(tr('exp.zipMeta', { n: res.count }))}</span></div>
          <button class="btn primary block" data-share>${h('exp.share')}</button>`;
        box.querySelector('[data-share]').onclick = async () => { const r = await shareOrDownload(res.blob, res.name); if (r === 'downloaded') toast(tr('common.downloaded')); };
      } catch (err) { console.error(err); b.disabled = false; b.textContent = tr('common.retry'); toast(tr('exp.exportFail', { msg: errMsg(err) }), 5000); }
    }));
  });
}

function backupSheet(trips, includeAll = false) {
  sheet(`<h2>${h('bk.title')}</h2><p class="muted small">${h(includeAll ? 'bk.hintAll' : 'bk.hintOne')}</p>
    <label class="check"><input type="checkbox" id="bk-photos" checked> ${h('bk.photos')}</label>
    <div class="exp-step"><button class="btn primary block" id="bk-build">${h('bk.build')}</button></div>
    <button class="btn block ghost" data-close>${h('common.close')}</button>`, (el) => {
    $('#bk-build', el).onclick = async (ev) => {
      const b = ev.target; b.disabled = true; b.textContent = tr('common.building');
      const byTrip = {}; for (const t of trips) byTrip[t.id] = await db.expensesOf(t.id);
      const res = await buildBackup(trips, byTrip, $('#bk-photos', el).checked);
      window.__lastExport = res;
      b.parentElement.innerHTML = `<div class="ready">✅ ${esc(res.name)}<span class="muted small">${money(res.blob.size / 1024)} KB</span></div><button class="btn primary block" id="bk-share">${h('bk.shareShort')}</button>`;
      $('#bk-share', el).onclick = () => shareOrDownload(res.blob, res.name);
    };
  });
}

async function restoreFromFile(file) {
  const data = JSON.parse(await file.text());
  if (data.app !== 'bt-expense' || !Array.isArray(data.trips)) throw new Error(tr('bk.notBackup'));
  const existing = new Set((await db.all('trips')).map((t) => t.id));
  const dup = data.trips.filter((t) => existing.has(t.id)).length;
  if (dup && !confirm(tr('bk.confirmOverwrite', { n: dup }))) return;
  await db.putMany('trips', data.trips);
  await db.putMany('expenses', data.expenses || []);
  const photos = [];
  for (const p of data.photos || []) photos.push({ id: p.id, blob: await dataURLToBlob(p.dataURL), createdAt: Date.now() });
  await db.putMany('photos', photos);
  toast(tr('bk.restored', { trips: data.trips.length, exps: (data.expenses || []).length }));
  location.hash = '#/'; render();
}

// ---------- settings ----------
function settingsView() {
  setTop(tr('set.title'), { back: '#/' });
  view.innerHTML = `<section class="card form">
    <h2>${h('lang.label')} / Language</h2>
    <label>${h('lang.label')}<select id="s-lang" aria-label="${h('lang.switchAria')}">${LANGS.map((l) => `<option value="${l}" ${getLang() === l ? 'selected' : ''}>${esc(LANG_NAMES[l])}</option>`).join('')}</select></label>
  </section>
  <section class="card form">
    <h2>${h('set.headerTitle')}</h2>
    <p class="muted small">${h('set.headerHint')}</p>
    <label>${h('set.name')}<input id="s-name" value="${esc(settings.empName)}"></label>
    <label>${h('set.no')}<input id="s-no" value="${esc(settings.empNo)}"></label>
  </section>
  <section class="card form">
    <h2>${h('set.ocrTitle')}</h2>
    <label class="check"><input type="checkbox" id="s-auto" ${settings.autoOcr ? 'checked' : ''}> ${h('set.autoOcr')}</label>
    <div class="label">${h('set.ocrLangs')}</div>
    ${OCR_LANGS.map((k) => `<label class="check"><input type="checkbox" data-lang="${k}" ${settings.ocrLangs.includes(k) ? 'checked' : ''}> ${h('set.langFmt', { name: tr('set.langName.' + k), code: k })}</label>`).join('')}
    <button class="btn block" id="s-precache">${h('set.precache')}</button>
    <span class="muted small" id="s-precache-status"></span>
  </section>
  <section class="card form">
    <h2>${h('set.appearance')}</h2>
    <label>${h('set.theme')}<select id="s-theme"><option value="" ${!settings.theme ? 'selected' : ''}>${h('set.themeSystem')}</option><option value="light" ${settings.theme === 'light' ? 'selected' : ''}>${h('set.themeLight')}</option><option value="dark" ${settings.theme === 'dark' ? 'selected' : ''}>${h('set.themeDark')}</option></select></label>
  </section>
  <section class="card form">
    <h2>${h('set.backupTitle')}</h2>
    <button class="btn block" id="s-backup">${h('set.backupAll')}</button>
    <button class="btn block" id="s-restore">${h('set.restore')}</button>
  </section>
  <section class="card form">
    <h2>${h('set.about')}</h2>
    <p class="small">${h('set.aboutRules', { receipt: LIMITS.receiptUsd, meal: LIMITS.mealUsdPerDay, low: LIMITS.hotelGuideLow, high: LIMITS.hotelGuideHigh })}</p>
    <p class="small muted">${h('set.aboutData')}</p>
    <p class="small" id="s-version">${h('set.version', { v: APP_VERSION })}</p>
    <p class="small muted" id="s-cache">…</p>
    <button class="btn block" id="s-update">${h('set.update')}</button>
    <h2>${h('diag.title')}</h2>
    <pre class="ocr-text" id="s-diag" style="white-space:pre-wrap;word-break:break-all"></pre>
    <button class="btn block" id="s-diag-copy">${h('diag.copy')}</button>
    <button class="btn block" id="s-diag-clear">${h('diag.clear')}</button>
    <button class="btn danger block" id="s-clear">${h('set.clear')}</button>
  </section>`;
  $('#s-name').onchange = (e) => { settings.empName = e.target.value.trim(); saveSettings(); toast(tr('common.savedOk')); };
  $('#s-lang').onchange = (e) => setLang(e.target.value);
  const diagText = () => { let l = []; try { l = JSON.parse(localStorage.getItem(DIAG_KEY) || '[]'); } catch (_) { /* ignore */ } return l; };
  const renderDiag = () => { const l = diagText(); $('#s-diag').textContent = l.length ? l.map((x) => `${x.t} ${x.v} [${x.step}] ${x.name}: ${x.msg}`).join('\n') : tr('diag.empty'); };
  renderDiag();
  (async () => {
    let keys = []; try { keys = (await caches.keys()).filter((k) => k.startsWith('bt-shell-')); } catch (_) { /* ignore */ }
    const el = $('#s-cache'); if (!el) return;
    el.textContent = keys.length ? tr('set.cacheVer', { c: keys.join(', ') }) : tr('set.cacheNone');
    if (keys.length && !keys.includes('bt-shell-' + APP_VERSION)) { el.textContent += ' ' + tr('set.cacheMismatch'); el.style.color = '#b45309'; }
  })();
  $('#s-update').onclick = async (ev) => {
    ev.target.disabled = true; ev.target.textContent = tr('set.updating');
    try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); for (const k of await caches.keys()) if (k.startsWith('bt-shell-')) await caches.delete(k); } catch (err) { showError(tr('common.errorPrefix'), err); }
    location.reload();
  };
  $('#s-diag-copy').onclick = async () => {
    let keys = []; try { keys = await caches.keys(); } catch (_) { /* ignore */ }
    const txt = `app ${APP_VERSION}\ncaches ${keys.join(', ')}\nua ${navigator.userAgent}\n` + diagText().map((x) => JSON.stringify(x)).join('\n');
    try { await navigator.clipboard.writeText(txt); toast(tr('diag.copied')); } catch (_) { $('#s-diag').textContent = txt; const r = document.createRange(); r.selectNodeContents($('#s-diag')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  };
  $('#s-diag-clear').onclick = () => { localStorage.removeItem(DIAG_KEY); renderDiag(); };
  $('#s-no').onchange = (e) => { settings.empNo = e.target.value.trim(); saveSettings(); toast(tr('common.savedOk')); };
  $('#s-auto').onchange = (e) => { settings.autoOcr = e.target.checked; saveSettings(); };
  $('#s-theme').onchange = (e) => { settings.theme = e.target.value; saveSettings(); applyTheme(); };
  view.querySelectorAll('[data-lang]').forEach((c) => (c.onchange = () => {
    settings.ocrLangs = [...view.querySelectorAll('[data-lang]:checked')].map((x) => x.dataset.lang);
    if (!settings.ocrLangs.length) { settings.ocrLangs = ['eng']; c.checked = true; }
    saveSettings();
  }));
  $('#s-precache').onclick = async () => {
    const st = $('#s-precache-status'); const files = ['vendor/tesseract/tesseract.min.js', 'vendor/tesseract/worker.min.js', 'vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js', 'vendor/tesseract/core/tesseract-core-lstm.wasm.js', ...settings.ocrLangs.map((l) => `vendor/tesseract/lang/${l}.traineddata.gz`)];
    try { const c = await caches.open('bt-ocr-v1'); let i = 0; for (const f of files) { st.textContent = tr('set.downloading', { i: ++i, n: files.length }); await c.add(f); } st.textContent = tr('set.offlineReady'); }
    catch (err) { st.textContent = tr('set.downloadFail', { msg: errMsg(err) }); }
  };
  $('#s-backup').onclick = async () => backupSheet(await db.all('trips'), true);
  $('#s-restore').onclick = () => { const i = $('#file-restore'); i.value = ''; i.onchange = async () => { try { await restoreFromFile(i.files[0]); } catch (err) { toast(tr('bk.restoreFail', { msg: errMsg(err) }), 5000); } }; i.click(); };
  $('#s-clear').onclick = async () => { if (!confirm(tr('set.confirmClear'))) return; await db.clearAll(); toast(tr('set.cleared')); location.hash = '#/'; };
}

// ---------- boot ----------
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller; let reloading = false;
  // 新版 service worker 接手後：不在編輯中就自動重新載入；編輯中則提示（避免丟掉未儲存的內容）
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return; reloading = true;
    if (draft || location.hash.includes('/e/')) toast(tr('sw.newVersion'), 60000, { label: tr('sw.reload'), onClick: () => location.reload() });
    else location.reload();
  });
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); }); // iOS 主畫面 App 從背景回來
  }).catch((e) => { console.warn('SW', e); diagLog('sw-register', e); }));
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
window.__app = { db, settings, tidy, version: APP_VERSION };
applyTheme(); applyDynType();
window.addEventListener('resize', applyDynType); document.addEventListener('visibilitychange', applyDynType);
render();
