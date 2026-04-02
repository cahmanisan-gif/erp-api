// Raja Vapor POS — Service Worker (offline sync)
// Versi: 1.0

const SYNC_TAG = 'pos-sync';
const DB_NAME  = 'rv_pos_offline';
const DB_VER   = 1;

// ── IndexedDB helpers ────────────────────────────────────────────────────────
function idbOpen() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('pending_trx')) {
        const store = db.createObjectStore('pending_trx', { keyPath: 'local_id' });
        store.createIndex('status', 'status', { unique: false });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

function idbGet(db, store, key) {
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

function idbGetAll(db, store, indexName, value) {
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, 'readonly');
    const os  = tx.objectStore(store);
    const req = indexName ? os.index(indexName).getAll(value) : os.getAll();
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

function idbPut(db, store, data) {
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(data);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

// ── Background Sync handler ──────────────────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(syncAllPending());
  }
});

async function syncAllPending() {
  let db;
  try {
    db = await idbOpen();
    const meta  = await idbGet(db, 'meta', 'auth_token');
    const token = meta?.value;
    if (!token) return;

    const pendings = await idbGetAll(db, 'pending_trx', 'status', 'pending');
    for (const trx of pendings) {
      try {
        const r = await fetch('/api/pos/transaksi', {
          method : 'POST',
          headers: {
            'Content-Type' : 'application/json',
            'Authorization': 'Bearer ' + token,
          },
          body: JSON.stringify(trx.payload),
        });
        const data = await r.json();
        if (data.success) {
          await idbPut(db, 'pending_trx', {
            ...trx,
            status    : 'synced',
            server_id : data.id,
            synced_at : new Date().toISOString(),
          });
          // Beritahu halaman jika masih terbuka
          const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
          clients.forEach(c => c.postMessage({ type: 'TRX_SYNCED', local_id: trx.local_id, server_id: data.id }));
        }
      } catch (_) {
        // Akan dicoba lagi pada sync berikutnya
      }
    }
  } catch (_) {}
}

// ── Install & Activate ───────────────────────────────────────────────────────
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(self.clients.claim()));
