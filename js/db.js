import { t } from './i18n.js';
// Minimal IndexedDB wrapper. All data stays on this device.
const DB_NAME = 'bt-expense';
const VERSION = 1;
let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('trips')) db.createObjectStore('trips', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('expenses')) {
        const s = db.createObjectStore('expenses', { keyPath: 'id' });
        s.createIndex('tripId', 'tripId');
      }
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error || new Error(t('db.openFail'))); };
    req.onblocked = () => { dbPromise = null; reject(new Error(t('db.blocked'))); };
  });
  return dbPromise;
}

const dbErr = (e, what) => e || new Error(t('db.noReason', { what: t(what) }));
const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(dbErr(req.error, 'db.rwFail')); });
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(dbErr(tx.error, 'db.writeFail')); tx.onabort = () => rej(dbErr(tx.error, 'db.writeAbort')); });

// iOS Safari 偶爾無法把 Blob 寫進 IndexedDB；此時照片以 {buf: ArrayBuffer, type} 儲存，讀出時還原成 blob，其餘程式不需知道。
const fixPhoto = (p) => (p && !p.blob && p.buf ? { ...p, blob: new Blob([p.buf], { type: p.type || 'image/jpeg' }) } : p);
export async function get(store, id) { const db = await open(); const r = await wrap(db.transaction(store).objectStore(store).get(id)); return store === 'photos' ? fixPhoto(r) : r; }
export async function all(store) { const db = await open(); const r = await wrap(db.transaction(store).objectStore(store).getAll()); return store === 'photos' ? r.map(fixPhoto) : r; }
export async function put(store, obj) { const db = await open(); const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(obj); await done(tx); return obj; }
export async function del(store, id) { const db = await open(); const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).delete(id); await done(tx); }
export async function expensesOf(tripId) { const db = await open(); return wrap(db.transaction('expenses').objectStore('expenses').index('tripId').getAll(tripId)); }
export async function putMany(store, list) { const db = await open(); const tx = db.transaction(store, 'readwrite'); const s = tx.objectStore(store); list.forEach((o) => s.put(o)); await done(tx); }
export async function clearAll() { const db = await open(); const tx = db.transaction(['trips', 'expenses', 'photos'], 'readwrite'); ['trips', 'expenses', 'photos'].forEach((s) => tx.objectStore(s).clear()); await done(tx); }

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

export async function deleteTrip(tripId) {
  const exps = await expensesOf(tripId);
  for (const e of exps) { for (const pid of e.photos || []) await del('photos', pid); await del('expenses', e.id); }
  await del('trips', tripId);
}
export async function deleteExpense(e) { for (const pid of e.photos || []) await del('photos', pid); await del('expenses', e.id); }
