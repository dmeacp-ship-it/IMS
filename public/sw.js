'use strict';

const CACHE_NAME = 'virgo-ims-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/favicon.svg'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.map(function (key) {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  const url = new URL(req.url);

  // Skip non-GET requests and API calls from static caching
  if (req.method !== 'GET' || url.pathname.startsWith('/api/')) {
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      // Offline fallback for POST
      event.respondWith(
        fetch(req.clone()).catch(function (error) {
          return req.clone().text().then(function (bodyText) {
            return saveToOutbox({
              url: req.url,
              method: req.method,
              headers: [...req.headers.entries()],
              body: bodyText,
              timestamp: Date.now()
            });
          }).then(function () {
            // Return a mock success response so the UI thinks it succeeded
            return new Response(JSON.stringify({ offlineSync: true, message: 'Saved offline. Will sync when online.' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            });
          });
        })
      );
    }
    return;
  }

  event.respondWith(
    caches.match(req).then(function (cached) {
      const fetchPromise = fetch(req).then(function (networkResponse) {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(req, clone);
          });
        }
        return networkResponse;
      }).catch(function () {
        return cached;
      });

      return cached || fetchPromise;
    })
  );
});

// Minimal IndexedDB for Outbox
function getOutboxDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('IMS_OUTBOX_DB', 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore('outbox', { autoIncrement: true });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject();
  });
}

function saveToOutbox(reqData) {
  return getOutboxDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readwrite');
      tx.objectStore('outbox').add(reqData);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject();
    });
  });
}

self.addEventListener('sync', function(event) {
  if (event.tag === 'ims-sync') {
    event.waitUntil(flushOutbox());
  }
});

async function flushOutbox() {
  const db = await getOutboxDB();
  const tx = db.transaction('outbox', 'readonly');
  const store = tx.objectStore('outbox');
  const req = store.getAllKeys();
  
  return new Promise((resolve) => {
    req.onsuccess = async (e) => {
      const keys = e.target.result;
      if (!keys || keys.length === 0) return resolve();
      
      for (const key of keys) {
        await new Promise(r => {
          const getReq = db.transaction('outbox', 'readonly').objectStore('outbox').get(key);
          getReq.onsuccess = async (ev) => {
            const data = ev.target.result;
            if (data) {
              try {
                await fetch(data.url, {
                  method: data.method,
                  headers: data.headers,
                  body: data.body
                });
                // Delete on success
                const delTx = db.transaction('outbox', 'readwrite');
                delTx.objectStore('outbox').delete(key);
              } catch (err) {
                // Ignore, keep in queue
              }
            }
            r();
          };
        });
      }
      resolve();
    };
  });
}
