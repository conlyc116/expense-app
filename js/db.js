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
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

export async function get(store, id) { const db = await open(); return wrap(db.transaction(store).objectStore(store).get(id)); }
export async function all(store) { const db = await open(); return wrap(db.transaction(store).objectStore(store).getAll()); }
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
