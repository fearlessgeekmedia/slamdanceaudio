/*
 * Slamdance Audio — playback engine.
 *
 * Local files are decoded once into an AudioBuffer and played with
 * AudioBufferSourceNodes. Routing an <audio> element through
 * createMediaElementSource() made WebKitGTK drop buffers mid-song and reject
 * play() outright for blobs it had already decoded for the BPM analysis, so the
 * element path is only used for internet streams. Two decks still give real
 * crossfades, and the analyser sees the same signal as the speakers.
 */
(function (root) {
  'use strict';

  var P = {};
  var ctx = null;
  var master = null;
  var analyser = null;
  var decks = [];
  var active = 0;
  var queue = [];
  var queueTracks = [];
  var index = -1;
  var current = null;
  var playing = false;
  var fading = false;
  var switching = false;
  var crossfade = 0;
  var volume = 0.85;
  var resolver = null;
  var listeners = {};
  var spectrum = null;
  var timeData = null;
  var radioEl = null;
  var streamMode = false;
  var mediaHooked = false;
  var ticker = null;
  var playToken = 0;
  var pendingLoads = 0;

  function emit(name, payload) {
    (listeners[name] || []).forEach(function (fn) {
      try {
        fn(payload);
      } catch (e) {
        console.error('[player] listener failed', e);
      }
    });
  }

  P.on = function (name, fn) {
    (listeners[name] = listeners[name] || []).push(fn);
    return P;
  };

  function setPlaying(value) {
    if (playing === value) return;
    playing = value;
    emit('state', { playing: playing });
  }

  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  /* WebKitGTK never settles play() when GStreamer has no decoder or audio
     sink for a stream, which used to leave the transport stuck mid-switch.
     Streams are the only media elements left, so this still covers them. */
  var START_TIMEOUT = 12000;

  function startAudio(audio) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        try {
          audio.pause();
        } catch (e) {
          /* a pipeline that never started may refuse to pause */
        }
        var err = new Error(
          'Audio did not start. The system may be missing GStreamer plugins or an audio output.'
        );
        err.code = 'play-timeout';
        reject(err);
      }, START_TIMEOUT);
      audio.play().then(
        function (value) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(value);
        },
        function (err) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  // ── decoded decks ─────────────────────────────────────────
  function makeDeck() {
    var gain = ctx.createGain();
    gain.gain.value = 1;
    gain.connect(master);
    return {
      gain: gain,
      source: null,
      buffer: null,
      trackId: null,
      offset: 0,
      duration: 0,
      startedAt: 0,
      playing: false,
    };
  }

  function stopSource(deck) {
    if (!deck || !deck.source) return;
    var src = deck.source;
    deck.source = null;
    src.onended = null;
    try {
      src.stop();
    } catch (e) {
      /* already stopped */
    }
    try {
      src.disconnect();
    } catch (e) {
      /* already disconnected */
    }
  }

  function deckPosition(deck) {
    if (!deck || !deck.buffer) return 0;
    if (!deck.playing) return deck.offset || 0;
    return Math.min(deck.duration || 0, (deck.offset || 0) + Math.max(0, ctx.currentTime - deck.startedAt));
  }

  /* A deck is done when its buffer runs out. WebKitGTK does not reliably
     dispatch ended on a buffer source — the engine bundled in the AppImage
     never does — so tick() also lands the deck once its own clock passes the
     buffer length. Both routes come through here, and stopping the source
     first means only one of them can advance the queue. */
  function finishDeck(deck) {
    if (!deck || !deck.playing) return;
    deck.playing = false;
    deck.offset = deck.duration || 0;
    stopSource(deck);
    if (deck === decks[active] && !streamMode && !fading && !switching) advance(0);
  }

  function startDeck(deck, buffer, offset, trackId) {
    stopSource(deck);
    deck.buffer = buffer;
    deck.trackId = trackId || null;
    deck.duration = buffer.duration || 0;
    var start = Number(offset) || 0;
    if (start < 0) start = 0;
    if (start > deck.duration - 0.05) start = 0;
    deck.offset = start;
    var src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(deck.gain);
    src.onended = function () {
      if (deck.source !== src) return;
      finishDeck(deck);
    };
    deck.source = src;
    deck.startedAt = ctx.currentTime;
    deck.playing = true;
    try {
      src.start(0, start);
    } catch (e) {
      deck.playing = false;
      throw e;
    }
  }

  function pauseDeck(deck) {
    if (!deck) return;
    if (deck.playing) {
      deck.offset = deckPosition(deck);
      deck.playing = false;
    }
    stopSource(deck);
  }

  function emitTime() {
    if (streamMode) return;
    var deck = decks[active];
    if (!deck || !deck.buffer) return;
    emit('time', { time: deckPosition(deck), duration: deck.duration || 0 });
  }

  function tick() {
    if (!playing || streamMode) return;
    var deck = decks[active];
    if (!deck || !deck.playing) return;
    var position = deckPosition(deck);
    var duration = deck.duration || 0;
    emit('time', { time: position, duration: duration });
    if (
      crossfade > 0 &&
      !fading &&
      !switching &&
      current &&
      !current.stream &&
      duration > crossfade + 4 &&
      duration - position <= crossfade
    ) {
      advance(crossfade);
      return;
    }

    // Backstop for engines that never dispatch ended — see finishDeck().
    if (duration > 0 && position >= duration - 0.02) finishDeck(deck);
  }

  function ensureGraph() {
    if (ctx) return;
    var C = root.AudioContext || root.webkitAudioContext;
    if (!C) throw new Error('Web Audio is not available in this browser.');
    ctx = new C();
    master = ctx.createGain();
    master.gain.value = volume;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.75;
    master.connect(analyser);
    analyser.connect(ctx.destination);
    spectrum = new Uint8Array(analyser.frequencyBinCount);
    timeData = new Float32Array(analyser.fftSize);

    decks.push(makeDeck());
    decks.push(makeDeck());

    radioEl = new Audio();
    radioEl.preload = 'none';
    radioEl.volume = volume;
    radioEl.addEventListener('play', function () {
      if (streamMode) setPlaying(true);
    });
    radioEl.addEventListener('pause', function () {
      if (streamMode) setPlaying(false);
    });
    radioEl.addEventListener('error', function () {
      if (streamMode) emit('error', new Error('That stream did not open. Check the URL, or try http instead of https.'));
    });
    radioEl.addEventListener('ended', function () {
      if (streamMode && !fading) advance(0);
    });

    ticker = setInterval(tick, 200);
    hookMediaSession();
  }

  function hookMediaSession() {
    if (mediaHooked || !('mediaSession' in navigator)) return;
    mediaHooked = true;
    try {
      navigator.mediaSession.setActionHandler('play', function () {
        P.toggle();
      });
      navigator.mediaSession.setActionHandler('pause', function () {
        P.pause();
      });
      navigator.mediaSession.setActionHandler('previoustrack', function () {
        P.prev();
      });
      navigator.mediaSession.setActionHandler('nexttrack', function () {
        P.skip(1);
      });
    } catch (e) {
      /* older engines expose mediaSession without handlers */
    }
  }

  function updateMediaMetadata(track) {
    if (!('mediaSession' in navigator) || typeof root.MediaMetadata !== 'function') return;
    try {
      navigator.mediaSession.metadata = new root.MediaMetadata({
        title: track.title || track.name || 'Slamdance Audio',
        artist: track.artist || 'Unknown artist',
        album: track.album || track.scene || (track.stream ? 'Internet radio' : 'Local library'),
      });
    } catch (e) {
      /* metadata is a nicety */
    }
  }

  function decodeBytes(bytes) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        var err = new Error('This file took too long to decode. It may be corrupt.');
        err.code = 'decode';
        reject(err);
      }, 20000);

      function ok(value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }

      function bad() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        var err = new Error('This file could not be decoded. It may be corrupt or use a codec this system lacks.');
        err.code = 'decode';
        reject(err);
      }

      try {
        var promise = ctx.decodeAudioData(bytes, ok, bad);
        if (promise && typeof promise.then === 'function') promise.then(ok, bad);
      } catch (e) {
        bad();
      }
    });
  }

  function loadBuffer(track) {
    return root.SDStore.getBlob(track.id)
      .then(function (blob) {
        if (!blob) {
          var err = new Error('Missing file');
          err.code = 'relink';
          throw err;
        }
        if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
        return new Response(blob).arrayBuffer();
      })
      .then(decodeBytes);
  }

  function advance(seconds) {
    var next = resolver ? resolver(current) : null;
    if (!next) {
      setPlaying(false);
      emit('queueend', {});
      return;
    }
    fading = seconds > 0;
    P.playTrack(next, { crossfade: seconds }).catch(function () {
      fading = false;
    });
  }

  function startStream(track) {
    streamMode = true;
    current = track;
    var qi = queue.indexOf(track.id);
    if (qi >= 0) index = qi;
    decks.forEach(function (deck) {
      pauseDeck(deck);
      deck.gain.gain.value = 1;
    });
    radioEl.src = track.url;
    radioEl.volume = volume;
    emit('track', track);
    emit('time', { time: 0, duration: 0 });
    updateMediaMetadata(track);
    return startAudio(radioEl)
      .then(function () {
        setPlaying(true);
      })
      .catch(function (err) {
        setPlaying(false);
        emit('error', err);
        throw err;
      });
  }

  P.playTrack = function (track, opts) {
    opts = opts || {};
    if (!track) return Promise.reject(new Error('No track'));
    try {
      ensureGraph();
    } catch (err) {
      emit('error', err);
      return Promise.reject(err);
    }
    // A cold start decodes slowly; a second play request must not be overtaken
    // by the first one landing late, and the newest request wins outright.
    var token = ++playToken;
    if (ctx.state === 'suspended') {
      try {
        ctx.resume();
      } catch (e) {
        /* resume will happen on the next user gesture */
      }
    }
    if (track.stream) return startStream(track);

    var seconds = typeof opts.crossfade === 'number' ? opts.crossfade : current && !current.stream ? crossfade : 0;

    pendingLoads++;
    var settled = false;
    function settle() {
      if (settled) return;
      settled = true;
      pendingLoads = Math.max(0, pendingLoads - 1);
    }
    return loadBuffer(track)
      .then(function (buffer) {
        settle();
        if (token !== playToken) return;
        var previous = current;
        var canFade =
          seconds > 0 &&
          playing &&
          previous &&
          !previous.stream &&
          decks[active].playing &&
          !fading &&
          !switching;

        streamMode = false;
        if (radioEl && !radioEl.paused) {
          try {
            radioEl.pause();
          } catch (e) {
            /* a stream that refuses to pause will be replaced on the next play */
          }
        }
        current = track;
        var qi = queue.indexOf(track.id);
        if (qi >= 0) index = qi;
        emit('track', track);
        updateMediaMetadata(track);

        var nextActive = canFade ? 1 - active : active;
        var nextDeck = decks[nextActive];
        var oldDeck = decks[active];

        switching = true;
        try {
          nextDeck.gain.gain.cancelScheduledValues(ctx.currentTime);
          nextDeck.gain.gain.setValueAtTime(canFade ? 0.0001 : 1, ctx.currentTime);
        } catch (e) {
          /* a fresh gain node cannot fail, but never trust it */
        }
        startDeck(nextDeck, buffer, 0, track.id);
        active = nextActive;

        if (canFade) {
          var now = ctx.currentTime;
          var end = now + seconds;
          nextDeck.gain.gain.linearRampToValueAtTime(1, end);
          var oldValue = oldDeck.gain.gain.value || 1;
          oldDeck.gain.gain.cancelScheduledValues(now);
          oldDeck.gain.gain.setValueAtTime(oldValue, now);
          oldDeck.gain.gain.linearRampToValueAtTime(0.0001, end);
          setTimeout(function () {
            if (active === nextActive) {
              pauseDeck(oldDeck);
              oldDeck.buffer = null;
              oldDeck.trackId = null;
              oldDeck.offset = 0;
              oldDeck.duration = 0;
            }
            try {
              oldDeck.gain.gain.cancelScheduledValues(ctx.currentTime);
              oldDeck.gain.gain.setValueAtTime(1, ctx.currentTime);
            } catch (e) {
              /* ignore */
            }
            fading = false;
          }, Math.max(240, seconds * 1000 + 90));
        }

        switching = false;
        setPlaying(true);
        emitTime();
      })
      .catch(function (err) {
        settle();
        if (token !== playToken) throw err;
        switching = false;
        fading = false;
        setPlaying(false);
        emit('error', err);
        throw err;
      });
  };

  P.setNextResolver = function (fn) {
    resolver = fn;
  };

  P.setQueue = function (tracks, startIndex) {
    queueTracks = (tracks || []).slice();
    queue = queueTracks.map(function (t) {
      return t.id;
    });
    index = typeof startIndex === 'number' ? startIndex : -1;
    emit('queue', queueTracks);
  };

  P.queue = function () {
    return queueTracks.slice();
  };

  P.play = function () {
    // A track is already decoding; starting another from the top of the queue
    // is what made the first click jump to the first song.
    if (pendingLoads > 0) return;
    try {
      ensureGraph();
    } catch (err) {
      emit('error', err);
      return;
    }
    if (ctx.state === 'suspended') ctx.resume();
    if (streamMode) {
      startAudio(radioEl).catch(function (err) {
        emit('error', err);
      });
      return;
    }
    if (current) {
      var deck = decks[active];
      if (deck && deck.buffer) {
        if (!deck.playing) startDeck(deck, deck.buffer, deck.offset, deck.trackId);
        setPlaying(true);
        emitTime();
        return;
      }
      P.playTrack(current, { crossfade: 0 }).catch(function () {});
      return;
    }
    if (queueTracks.length) {
      P.playTrack(queueTracks[index >= 0 ? index : 0], { crossfade: 0 }).catch(function () {});
    }
  };

  P.pause = function () {
    if (streamMode) {
      radioEl.pause();
    } else {
      pauseDeck(decks[active]);
      emitTime();
    }
    setPlaying(false);
  };

  P.toggle = function () {
    if (playing) P.pause();
    else P.play();
  };

  P.stop = function () {
    fading = false;
    switching = false;
    if (streamMode) {
      radioEl.pause();
    } else {
      var deck = decks[active];
      pauseDeck(deck);
      if (deck) {
        deck.offset = 0;
        emit('time', { time: 0, duration: deck.duration || 0 });
      }
    }
    setPlaying(false);
    emit('stopped', {});
  };

  P.skip = function (delta) {
    if (!queueTracks.length) return;
    var i = index < 0 ? 0 : index + delta;
    if (i < 0) i = queueTracks.length - 1;
    if (i >= queueTracks.length) i = 0;
    index = i;
    P.playTrack(queueTracks[i], { crossfade: 0 }).catch(function () {});
  };

  P.next = function () {
    P.skip(1);
  };

  P.prev = function () {
    if (!streamMode && current && P.position() > 3) {
      P.seek(0);
      return;
    }
    P.skip(-1);
  };

  P.seek = function (seconds) {
    if (streamMode || !current) return;
    var deck = decks[active];
    if (!deck || !deck.buffer) return;
    var target = Math.max(0, Math.min((deck.duration || 0) - 0.05, Number(seconds) || 0));
    if (deck.playing) startDeck(deck, deck.buffer, target, deck.trackId);
    else deck.offset = target;
    emit('time', { time: target, duration: deck.duration || 0 });
  };

  P.setVolume = function (v) {
    volume = clamp01(Number(v) || 0);
    if (master) master.gain.value = volume;
    if (radioEl) radioEl.volume = volume;
  };

  P.getVolume = function () {
    return volume;
  };

  P.setCrossfade = function (seconds) {
    crossfade = Math.max(0, Number(seconds) || 0);
  };

  P.getCrossfade = function () {
    return crossfade;
  };

  P.context = function () {
    ensureGraph();
    if (ctx && ctx.state === 'suspended') ctx.resume();
    return ctx;
  };

  P.output = function () {
    ensureGraph();
    return master;
  };

  P.now = function () {
    return current;
  };

  P.isPlaying = function () {
    return playing;
  };

  P.isStream = function () {
    return streamMode;
  };

  P.isLoading = function () {
    return pendingLoads > 0;
  };

  P.position = function () {
    if (streamMode) return 0;
    return deckPosition(decks[active]);
  };

  P.duration = function () {
    if (streamMode || !decks[active]) return 0;
    return decks[active].duration || 0;
  };

  P.getDb = function () {
    if (!analyser || !playing) return -90;
    analyser.getFloatTimeDomainData(timeData);
    var sum = 0;
    for (var i = 0; i < timeData.length; i++) sum += timeData[i] * timeData[i];
    var rms = Math.sqrt(sum / timeData.length);
    return 20 * Math.log10(rms + 1e-8);
  };

  P.getLevel01 = function () {
    var db = P.getDb();
    return clamp01((db + 46) / 40);
  };

  P.getSpectrum = function () {
    if (!analyser) return null;
    analyser.getByteFrequencyData(spectrum);
    return spectrum;
  };

  P.invalidate = function (id) {
    decks.forEach(function (deck) {
      if (deck.trackId === id) {
        pauseDeck(deck);
        deck.buffer = null;
        deck.trackId = null;
        deck.offset = 0;
        deck.duration = 0;
      }
    });
  };

  P.invalidateAll = function () {
    decks.forEach(function (deck) {
      pauseDeck(deck);
      deck.buffer = null;
      deck.trackId = null;
      deck.offset = 0;
      deck.duration = 0;
    });
  };

  root.addEventListener('pagehide', function () {
    if (!decks.length) return;
    decks.forEach(function (deck) {
      try {
        pauseDeck(deck);
      } catch (e) {
        /* ignore */
      }
    });
    if (radioEl) {
      try {
        radioEl.pause();
      } catch (e) {
        /* ignore */
      }
    }
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  });

  root.SDPlayer = P;
})(window);
