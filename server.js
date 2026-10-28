import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const SAVES_FILE = path.join(__dirname, '.game-saves.json');

function readAllSaves() {
  try {
    if (!fs.existsSync(SAVES_FILE)) return {};
    const raw = fs.readFileSync(SAVES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeAllSaves(savesObj) {
  try {
    fs.writeFileSync(SAVES_FILE, JSON.stringify(savesObj, null, 2), 'utf8');
  } catch (_) {}
}

function getScopeFromProxyTarget(host, targetPath) {
  const cleanSegments = (targetPath || '/')
    .split('?')[0]
    .split('/')
    .filter(Boolean);
  const gameFolder = cleanSegments[0] || 'root';
  return `${host}__${gameFolder}`.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function buildSaveBootstrapScript(scope, savedEntry) {
  const safeScope = JSON.stringify(scope);
  const safeData = JSON.stringify({
    localStorage: savedEntry?.localStorage || {},
    idbfs: savedEntry?.idbfs || {},
  }).replace(/</g, '\\u003c');

  return `<script>
(function() {
  var SCOPE = ${safeScope};
  var INITIAL_SAVE = ${safeData};

  // Block popup/ad windows so level transitions always stay in the current tab
  window.open = function() { return null; };

  // Per-game isolated localStorage backed by first-party storage + server disk sync
  var PREFIX = 'vp_ls::' + SCOPE + '::';
  var gameMap = Object.assign({}, INITIAL_SAVE.localStorage || {});
  var nativeLS = null;

  try {
    var testKey = '__vp_ls_test__';
    window.localStorage.setItem(testKey, '1');
    window.localStorage.removeItem(testKey);
    nativeLS = window.localStorage;
    // Merge any newer keys stored in browser first-party localStorage for this game
    for (var i = 0; i < nativeLS.length; i++) {
      var rawKey = nativeLS.key(i);
      if (rawKey && rawKey.indexOf(PREFIX) === 0) {
        var shortKey = rawKey.slice(PREFIX.length);
        var val = nativeLS.getItem(rawKey);
        if (val !== null) {
          gameMap[shortKey] = val;
        }
      }
    }
    // Ensure server-restored keys are also written into browser localStorage
    Object.keys(gameMap).forEach(function(k) {
      try { nativeLS.setItem(PREFIX + k, String(gameMap[k])); } catch (_) {}
    });
  } catch (e) {
    nativeLS = null;
  }

  var apiMethods = {
    getItem: function(k) {
      var key = String(k);
      return Object.prototype.hasOwnProperty.call(gameMap, key) ? gameMap[key] : null;
    },
    setItem: function(k, v) {
      var key = String(k);
      var val = String(v);
      gameMap[key] = val;
      if (nativeLS) {
        try { nativeLS.setItem(PREFIX + key, val); } catch (_) {}
      }
      scheduleSync();
    },
    removeItem: function(k) {
      var key = String(k);
      delete gameMap[key];
      if (nativeLS) {
        try { nativeLS.removeItem(PREFIX + key); } catch (_) {}
      }
      scheduleSync();
    },
    clear: function() {
      Object.keys(gameMap).forEach(function(k) {
        delete gameMap[k];
        if (nativeLS) {
          try { nativeLS.removeItem(PREFIX + k); } catch (_) {}
        }
      });
      scheduleSync();
    },
    key: function(index) {
      var keys = Object.keys(gameMap);
      return keys[index] !== undefined ? keys[index] : null;
    }
  };

  var storageProxy = new Proxy(gameMap, {
    get: function(target, prop) {
      if (prop === 'length') return Object.keys(target).length;
      if (Object.prototype.hasOwnProperty.call(apiMethods, prop)) return apiMethods[prop];
      if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(target, prop)) {
        return target[prop];
      }
      return undefined;
    },
    set: function(_target, prop, value) {
      if (typeof prop === 'string' && !Object.prototype.hasOwnProperty.call(apiMethods, prop) && prop !== 'length') {
        apiMethods.setItem(prop, value);
      }
      return true;
    },
    deleteProperty: function(_target, prop) {
      if (typeof prop === 'string') {
        apiMethods.removeItem(prop);
      }
      return true;
    }
  });

  try {
    Object.defineProperty(window, 'localStorage', {
      get: function() { return storageProxy; },
      configurable: true
    });
  } catch (_) {}

  function snapshotLocalStorage() {
    return Object.assign({}, gameMap);
  }

  function uint8ToBase64(bytes) {
    var binary = '';
    var chunkSize = 0x8000;
    for (var i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function base64ToUint8(b64) {
    var binary = atob(b64);
    var out = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }

  var idbfsCache = Object.assign({}, INITIAL_SAVE.idbfs || {});

  // Pre-hydrate Emscripten / Unity WebGL /idbfs IndexedDB store
  (function restoreIdbfs() {
    var keys = Object.keys(idbfsCache);
    if (!keys.length || !window.indexedDB) return;
    try {
      var req = window.indexedDB.open('/idbfs', 21);
      req.onupgradeneeded = function(e) {
        var db = e.target.result;
        var store = db.objectStoreNames.contains('FILE_DATA')
          ? req.transaction.objectStore('FILE_DATA')
          : db.createObjectStore('FILE_DATA');
        if (!store.indexNames.contains('timestamp')) {
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
      req.onsuccess = function(e) {
        try {
          var db = e.target.result;
          if (!db.objectStoreNames.contains('FILE_DATA')) { db.close(); return; }
          var tx = db.transaction(['FILE_DATA'], 'readwrite');
          var store = tx.objectStore('FILE_DATA');
          keys.forEach(function(fileKey) {
            var getReq = store.get(fileKey);
            getReq.onsuccess = function() {
              if (!getReq.result && idbfsCache[fileKey]) {
                var item = idbfsCache[fileKey];
                store.put({
                  timestamp: new Date(item.timestamp || Date.now()),
                  mode: item.mode || 33206,
                  contents: base64ToUint8(item.contentsBase64 || '')
                }, fileKey);
              }
            };
          });
          tx.oncomplete = function() { db.close(); };
        } catch (_) {}
      };
    } catch (_) {}
  })();

  var syncTimer = null;
  function flushSaveNow() {
    clearTimeout(syncTimer);
    syncTimer = null;
    var payload = JSON.stringify({
      localStorage: snapshotLocalStorage(),
      idbfs: idbfsCache
    });
    try {
      fetch('/api/saves/' + encodeURIComponent(SCOPE), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true
      }).then(function() {
        try {
          window.parent.postMessage({ type: 'VP_GAME_SAVED', scope: SCOPE, timestamp: Date.now() }, '*');
        } catch (_) {}
      }).catch(function() {});
    } catch (_) {}
  }

  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(flushSaveNow, 300);
  }

  // Hook IndexedDB writes so Unity WebGL / Godot / Emscripten IDBFS saves sync automatically
  if (window.IDBObjectStore && window.IDBObjectStore.prototype) {
    var origPut = IDBObjectStore.prototype.put;
    var origAdd = IDBObjectStore.prototype.add;
    var origDelete = IDBObjectStore.prototype.delete;

    function captureIdbRecord(store, val, key) {
      try {
        if (store.name === 'FILE_DATA' && typeof key === 'string' && val && val.contents) {
          var bytes = val.contents instanceof Uint8Array
            ? val.contents
            : new Uint8Array(val.contents.buffer || val.contents);
          idbfsCache[key] = {
            timestamp: val.timestamp ? new Date(val.timestamp).getTime() : Date.now(),
            mode: val.mode || 33206,
            contentsBase64: uint8ToBase64(bytes)
          };
          scheduleSync();
        }
      } catch (_) {}
    }

    IDBObjectStore.prototype.put = function(val, key) {
      captureIdbRecord(this, val, key);
      return arguments.length > 1 ? origPut.call(this, val, key) : origPut.call(this, val);
    };
    IDBObjectStore.prototype.add = function(val, key) {
      captureIdbRecord(this, val, key);
      return arguments.length > 1 ? origAdd.call(this, val, key) : origAdd.call(this, val);
    };
    IDBObjectStore.prototype.delete = function(key) {
      try {
        if (this.name === 'FILE_DATA' && typeof key === 'string' && idbfsCache[key]) {
          delete idbfsCache[key];
          scheduleSync();
        }
      } catch (_) {}
      return origDelete.call(this, key);
    };
  }

  window.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') flushSaveNow();
  });
  window.addEventListener('pagehide', flushSaveNow);
  window.addEventListener('beforeunload', flushSaveNow);
})();
</script>`;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  // Save Persistence API
  app.get('/api/saves/:scope', (req, res) => {
    const saves = readAllSaves();
    res.json(saves[req.params.scope] || { localStorage: {}, idbfs: {} });
  });

  app.post('/api/saves/:scope', (req, res) => {
    const scope = req.params.scope;
    const saves = readAllSaves();
    const existing = saves[scope] || { localStorage: {}, idbfs: {} };

    const incomingLS =
      req.body && typeof req.body.localStorage === 'object' && req.body.localStorage !== null
        ? req.body.localStorage
        : existing.localStorage;
    const incomingIdbfs =
      req.body && typeof req.body.idbfs === 'object' && req.body.idbfs !== null
        ? { ...existing.idbfs, ...req.body.idbfs }
        : existing.idbfs;

    saves[scope] = {
      localStorage: incomingLS,
      idbfs: incomingIdbfs,
      updatedAt: new Date().toISOString(),
    };
    writeAllSaves(saves);
    res.json({ ok: true, updatedAt: saves[scope].updatedAt });
  });

  // Same-Origin Game Proxy so cross-origin games run first-party and persist all saves
  app.use('/game-proxy', async (req, res) => {
    const match = req.url.match(/^\/(https?)\/([^/]+)(\/.*)?$/);
    if (!match) {
      res.status(400).send('Invalid game proxy URL');
      return;
    }

    const [, proto, host, restPath = '/'] = match;
    const upstreamUrl = `${proto}://${host}${restPath}`;

    // Block known external popup/ad scripts injected by game mirrors
    if (host.includes('ubg235.pages.dev') || restPath.includes('ubg235_game')) {
      res.setHeader('Content-Type', 'application/javascript');
      res.send('// ad script blocked');
      return;
    }

    try {
      const upstreamRes = await fetch(upstreamUrl, {
        method: req.method,
        headers: {
          'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
          Accept: req.headers['accept'] || '*/*',
        },
        redirect: 'follow',
      });

      const contentType = upstreamRes.headers.get('content-type') || 'application/octet-stream';
      res.status(upstreamRes.status);
      res.setHeader('Content-Type', contentType);

      const cacheControl = upstreamRes.headers.get('cache-control');
      if (cacheControl && !contentType.includes('text/html')) {
        res.setHeader('Cache-Control', cacheControl);
      } else if (contentType.includes('text/html')) {
        res.setHeader('Cache-Control', 'no-store');
      }

      if (contentType.includes('text/html')) {
        let html = await upstreamRes.text();
        // Neutralize external popup loader reference
        html = html.replace(/https:\/\/ubg235\.pages\.dev\/[^\s"'<>]+/g, 'about:blank');

        const scope = getScopeFromProxyTarget(host, restPath);
        const allSaves = readAllSaves();
        const bootstrap = buildSaveBootstrapScript(scope, allSaves[scope]);

        if (/<head[^>]*>/i.test(html)) {
          html = html.replace(/<head[^>]*>/i, (tag) => `${tag}${bootstrap}`);
        } else {
          html = `${bootstrap}${html}`;
        }

        const buf = Buffer.from(html, 'utf8');
        res.setHeader('Content-Length', buf.length);
        res.send(buf);
        return;
      }

      const arrayBuf = await upstreamRes.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      res.setHeader('Content-Length', buf.length);
      res.send(buf);
    } catch (err) {
      res.status(502).send('Failed to load upstream game resource.');
    }
  });

  // Fallback for root-relative asset requests originating inside a proxied game iframe
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/api/') || req.path.startsWith('/game-proxy/') || req.path.startsWith('/@') || req.path.startsWith('/node_modules/')) {
      return next();
    }
    const localPublicPath = path.join(__dirname, 'public', req.path);
    const localRootPath = path.join(__dirname, req.path);
    if (fs.existsSync(localPublicPath) || fs.existsSync(localRootPath)) {
      return next();
    }
    const referer = req.headers.referer || '';
    const refMatch = referer.match(/\/game-proxy\/(https?)\/([^/]+)\//);
    if (refMatch) {
      const [, proto, host] = refMatch;
      res.redirect(307, `/game-proxy/${proto}/${host}${req.originalUrl}`);
      return;
    }
    next();
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`VaultPlay server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
