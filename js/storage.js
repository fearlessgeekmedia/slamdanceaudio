/*
 * Slamdance Audio — local storage.
 *
 * Two layers, because a player that loses your library on reload is not
 * offline-first:
 *   • track metadata + settings in localStorage (small, synchronous)
 *   • audio blobs in IndexedDB, keyed by track id (may be unavailable, e.g.
 *     some browsers on file://) — in that case blobs live in memory for the
 *     session and the UI asks you to re-link a file after a reload.
 */
(function (root) {
  'use strict';

  var KEY = 'slamdance.v1';
  var DB_NAME = 'slamdance-audio';
  var STORE = 'blobs';

  var DEFAULTS = {
    theme: 'pit',
    volume: 0.85,
    crossfade: 0,
    djVoice: true,
    stationName: 'Slamdance Radio',
    showName: 'The Pit',
    shuffle: false,
    repeat: false,
    lastView: 'player',
    customThemes: [],
    layout: { pit: true, grain: true, hero: true, live: true, wide: false },
    collapsedCards: {},
  };

  var state = { tracks: [], settings: Object.assign({}, DEFAULTS) };
  var memBlobs = new Map();
  var dbPromise = null;
  var dbAvailable = null;
  var saveTimer = null;

  function safeParse(raw) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function normalizeTrack(raw) {
    if (!raw || typeof raw !== 'object' || !raw.id) return null;
    return {
      id: String(raw.id),
      stream: !!raw.stream,
      url: typeof raw.url === 'string' ? raw.url : '',
      name: typeof raw.name === 'string' ? raw.name : '',
      title: typeof raw.title === 'string' ? raw.title : '',
      artist: typeof raw.artist === 'string' ? raw.artist : '',
      album: typeof raw.album === 'string' ? raw.album : '',
      genre: typeof raw.genre === 'string' ? raw.genre : '',
      year: typeof raw.year === 'string' ? raw.year : '',
      trackNo: typeof raw.trackNo === 'string' ? raw.trackNo : '',
      tagged: !!raw.tagged,
      scene: typeof raw.scene === 'string' ? raw.scene : '',
      label: typeof raw.label === 'string' ? raw.label : '',
      era: typeof raw.era === 'string' ? raw.era : '',
      notes: typeof raw.notes === 'string' ? raw.notes : '',
      bandcamp: typeof raw.bandcamp === 'string' ? raw.bandcamp : '',
      size: Number(raw.size) || 0,
      lastModified: Number(raw.lastModified) || 0,
      duration: Number(raw.duration) || 0,
      bpm: typeof raw.bpm === 'number' && isFinite(raw.bpm) ? raw.bpm : null,
      confidence: Number(raw.confidence) || 0,
      rmsDb: typeof raw.rmsDb === 'number' && isFinite(raw.rmsDb) ? raw.rmsDb : null,
      intensity: typeof raw.intensity === 'number' && isFinite(raw.intensity) ? raw.intensity : null,
      analyzed: !!raw.analyzed,
      plays: Number(raw.plays) || 0,
      addedAt: Number(raw.addedAt) || Date.now(),
      missing: false,
    };
  }

  function load() {
    var raw = null;
    try {
      raw = localStorage.getItem(KEY);
    } catch (e) {
      raw = null;
    }
    var parsed = raw ? safeParse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.tracks)) {
        state.tracks = parsed.tracks.map(normalizeTrack).filter(Boolean);
      }
      if (parsed.settings && typeof parsed.settings === 'object') {
        state.settings = Object.assign({}, DEFAULTS, parsed.settings);
      }
    }
    return state;
  }

  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      try {
        localStorage.setItem(KEY, JSON.stringify({ tracks: state.tracks, settings: state.settings }));
      } catch (e) {
        // Quota or blocked storage: the session still works, just not persistent.
        console.warn('[storage] could not persist library', e);
      }
    }, 180);
  }

  // ── identity ──────────────────────────────────────────────
  function simpleHash(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function localId(file) {
    return 'loc|' + file.size + '|' + file.lastModified + '|' + simpleHash(file.name + '|' + file.size);
  }

  function streamId(url) {
    return 'str|' + simpleHash(url);
  }

  // ── track records ─────────────────────────────────────────
  function getTrack(id) {
    for (var i = 0; i < state.tracks.length; i++) {
      if (state.tracks[i].id === id) return state.tracks[i];
    }
    return null;
  }

  function upsertTrack(track) {
    var normalized = normalizeTrack(track);
    if (!normalized) return null;
    var existing = getTrack(normalized.id);
    if (existing) {
      Object.keys(normalized).forEach(function (k) {
        if (k === 'missing') return;
        if (normalized[k] !== null && normalized[k] !== '' && normalized[k] !== 0) existing[k] = normalized[k];
      });
      return existing;
    }
    state.tracks.push(normalized);
    return normalized;
  }

  function removeTrack(id) {
    state.tracks = state.tracks.filter(function (t) {
      return t.id !== id;
    });
    memBlobs.delete(id);
    deleteBlob(id);
    save();
  }

  function clearLibrary() {
    var local = state.tracks.filter(function (t) {
      return !t.stream;
    });
    local.forEach(function (t) {
      memBlobs.delete(t.id);
      deleteBlob(t.id);
    });
    state.tracks = state.tracks.filter(function (t) {
      return t.stream;
    });
    save();
  }

  // ── IndexedDB blob layer ──────────────────────────────────
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      var settled = false;
      function finish(db, ok) {
        if (settled) return;
        settled = true;
        dbAvailable = ok;
        resolve(db);
      }
      function fail() {
        finish(null, false);
      }
      try {
        if (!root.indexedDB) {
          fail();
          return;
        }
        var req = root.indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        req.onsuccess = function () {
          finish(req.result, true);
        };
        req.onerror = fail;
        req.onblocked = fail;
        setTimeout(fail, 3000);
      } catch (e) {
        fail();
      }
    });
    return dbPromise;
  }

  function probe() {
    if (dbAvailable !== null) return Promise.resolve(dbAvailable);
    return openDb().then(function (db) {
      return !!db;
    });
  }

  function putBlob(id, blob) {
    memBlobs.set(id, blob);
    return openDb().then(function (db) {
      if (!db) return false;
      return new Promise(function (resolve) {
        try {
          var req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(blob, id);
          req.onsuccess = function () {
            resolve(true);
          };
          req.onerror = function () {
            resolve(false);
          };
        } catch (e) {
          resolve(false);
        }
      });
    });
  }

  function getBlob(id) {
    if (memBlobs.has(id)) return Promise.resolve(memBlobs.get(id));
    return openDb().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        try {
          var req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
          req.onsuccess = function () {
            resolve(req.result || null);
          };
          req.onerror = function () {
            resolve(null);
          };
        } catch (e) {
          resolve(null);
        }
      });
    });
  }

  function hasBlob(id) {
    if (memBlobs.has(id)) return Promise.resolve(true);
    return openDb().then(function (db) {
      if (!db) return false;
      return new Promise(function (resolve) {
        try {
          var store = db.transaction(STORE, 'readonly').objectStore(STORE);
          var req = typeof store.getKey === 'function' ? store.getKey(id) : store.get(id);
          req.onsuccess = function () {
            var found = typeof store.getKey === 'function' ? req.result : req.result;
            resolve(found !== undefined && found !== null);
          };
          req.onerror = function () {
            resolve(false);
          };
        } catch (e) {
          resolve(false);
        }
      });
    });
  }

  function deleteBlob(id) {
    return openDb().then(function (db) {
      if (!db) return;
      try {
        db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id);
      } catch (e) {
        /* nothing to clean up */
      }
    });
  }

  root.SDStore = {
    state: state,
    load: load,
    save: save,
    localId: localId,
    streamId: streamId,
    getTrack: getTrack,
    upsertTrack: upsertTrack,
    removeTrack: removeTrack,
    clearLibrary: clearLibrary,
    putBlob: putBlob,
    getBlob: getBlob,
    hasBlob: hasBlob,
    deleteBlob: deleteBlob,
    probe: probe,
  };
})(window);
