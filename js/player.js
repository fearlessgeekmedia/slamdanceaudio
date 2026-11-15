/*
 * Slamdance Audio — playback engine.
 *
 * Two Web Audio decks so crossfade presets are real overlaps, not fade-to-
 * silence. Internet streams use a plain <audio> element on purpose: routing a
 * cross-origin stream through MediaElementSource can silence it on engines
 * that enforce CORS, and a live stream has nothing to crossfade into anyway.
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
  var srcCache = new Map();
  var spectrum = null;
  var timeData = null;
  var radioEl = null;
  var streamMode = false;
  var mediaHooked = false;

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

  function makeDeck() {
    var audio = new Audio();
    audio.preload = 'auto';
    var gain = ctx.createGain();
    gain.gain.value = 1;
    var source = ctx.createMediaElementSource(audio);
    source.connect(gain);
    gain.connect(master);
    var deck = { audio: audio, gain: gain, source: source };
    bindDeck(deck);
    return deck;
  }

  function bindDeck(deck) {
    var a = deck.audio;
    a.addEventListener('timeupdate', function () {
      if (deck !== decks[active] || streamMode) return;
      var duration = a.duration;
      emit('time', {
        time: a.currentTime,
        duration: isFinite(duration) ? duration : 0,
      });
      if (
        crossfade > 0 &&
        !fading &&
        !switching &&
        current &&
        !current.stream &&
        isFinite(duration) &&
        duration > crossfade + 4 &&
        duration - a.currentTime <= crossfade
      ) {
        advance(crossfade);
      }
    });
    a.addEventListener('ended', function () {
      if (deck !== decks[active] || streamMode || fading) return;
      advance(0);
    });
    a.addEventListener('play', function () {
      if (deck === decks[active] && !streamMode) setPlaying(true);
    });
    a.addEventListener('pause', function () {
      if (deck === decks[active] && !streamMode && !switching && !fading) setPlaying(false);
    });
    a.addEventListener('error', function () {
      if (deck === decks[active] && !streamMode) {
        emit('error', new Error('This file could not be played. It may be corrupt or use a codec this browser lacks.'));
      }
    });
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

  function resolveSrc(track) {
    if (track.stream) return Promise.resolve(track.url);
    if (srcCache.has(track.id)) return Promise.resolve(srcCache.get(track.id));
    return root.SDStore.getBlob(track.id).then(function (blob) {
      if (!blob) {
        var err = new Error('Missing file');
        err.code = 'relink';
        throw err;
      }
      var url = URL.createObjectURL(blob);
      srcCache.set(track.id, url);
      return url;
    });
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
    decks.forEach(function (d) {
      try {
        d.audio.pause();
      } catch (e) {
        /* ignore */
      }
      d.gain.gain.value = 1;
    });
    radioEl.src = track.url;
    radioEl.volume = volume;
    emit('track', track);
    emit('time', { time: 0, duration: 0 });
    updateMediaMetadata(track);
    return radioEl.play().then(function () {
      setPlaying(true);
    }).catch(function (err) {
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
    if (ctx.state === 'suspended') {
      try {
        ctx.resume();
      } catch (e) {
        /* resume will happen on the play() promise */
      }
    }
    if (track.stream) return startStream(track);

    var seconds = typeof opts.crossfade === 'number' ? opts.crossfade : current && !current.stream ? crossfade : 0;

    return resolveSrc(track).then(function (url) {
      var previous = current;
      var canFade =
        seconds > 0 &&
        playing &&
        previous &&
        !previous.stream &&
        decks[active].audio.src &&
        !decks[active].audio.paused &&
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
        nextDeck.audio.pause();
        nextDeck.audio.src = url;
        nextDeck.audio.currentTime = 0;
        nextDeck.gain.gain.cancelScheduledValues(ctx.currentTime);
        nextDeck.gain.gain.setValueAtTime(canFade ? 0.0001 : 1, ctx.currentTime);
      } catch (e) {
        /* setting src on a fresh element never throws, but never trust it */
      }
      active = nextActive;

      return nextDeck.audio.play().then(function () {
        if (canFade) {
          var now = ctx.currentTime;
          var end = now + seconds;
          nextDeck.gain.gain.linearRampToValueAtTime(1, end);
          var oldValue = oldDeck.gain.gain.value || 1;
          oldDeck.gain.gain.cancelScheduledValues(now);
          oldDeck.gain.gain.setValueAtTime(oldValue, now);
          oldDeck.gain.gain.linearRampToValueAtTime(0.0001, end);
          setTimeout(function () {
            try {
              oldDeck.audio.pause();
              oldDeck.audio.removeAttribute('src');
              oldDeck.audio.load();
            } catch (e) {
              /* ignore */
            }
            oldDeck.gain.gain.cancelScheduledValues(ctx.currentTime);
            oldDeck.gain.gain.setValueAtTime(1, ctx.currentTime);
            fading = false;
          }, Math.max(240, seconds * 1000 + 90));
        }
        switching = false;
        setPlaying(true);
      }).catch(function (err) {
        switching = false;
        setPlaying(false);
        emit('error', err);
        throw err;
      });
    }).catch(function (err) {
      if (err && err.code === 'relink') {
        emit('error', err);
      }
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
    try {
      ensureGraph();
    } catch (err) {
      emit('error', err);
      return;
    }
    if (ctx.state === 'suspended') ctx.resume();
    if (streamMode) {
      radioEl.play().catch(function (err) {
        emit('error', err);
      });
      return;
    }
    if (current) {
      var deck = decks[active];
      if (deck.audio.src) {
        deck.audio.play().catch(function (err) {
          emit('error', err);
        });
        return;
      }
    }
    if (queueTracks.length) {
      P.playTrack(queueTracks[index >= 0 ? index : 0], { crossfade: 0 }).catch(function () {});
    }
  };

  P.pause = function () {
    if (streamMode) {
      radioEl.pause();
    } else if (decks[active]) {
      decks[active].audio.pause();
    }
    setPlaying(false);
  };

  P.toggle = function () {
    if (playing) P.pause();
    else P.play();
  };

  P.stop = function () {
    fading = false;
    if (streamMode) {
      radioEl.pause();
    } else if (decks[active]) {
      decks[active].audio.pause();
      try {
        decks[active].audio.currentTime = 0;
      } catch (e) {
        /* ignore */
      }
      emit('time', { time: 0, duration: decks[active].audio.duration || 0 });
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
    if (!streamMode && current && decks[active] && decks[active].audio.currentTime > 3) {
      P.seek(0);
      return;
    }
    P.skip(-1);
  };

  P.seek = function (seconds) {
    if (streamMode || !current) return;
    var a = decks[active].audio;
    if (!a.duration || !isFinite(a.duration)) return;
    a.currentTime = Math.max(0, Math.min(a.duration - 0.05, seconds));
    emit('time', { time: a.currentTime, duration: a.duration });
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

  P.position = function () {
    if (streamMode || !decks[active]) return 0;
    return decks[active].audio.currentTime || 0;
  };

  P.duration = function () {
    if (streamMode || !decks[active]) return 0;
    var d = decks[active].audio.duration;
    return isFinite(d) ? d : 0;
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
    if (srcCache.has(id)) {
      try {
        URL.revokeObjectURL(srcCache.get(id));
      } catch (e) {
        /* ignore */
      }
      srcCache.delete(id);
    }
  };

  P.invalidateAll = function () {
    srcCache.forEach(function (url) {
      try {
        URL.revokeObjectURL(url);
      } catch (e) {
        /* ignore */
      }
    });
    srcCache.clear();
  };

  root.addEventListener('pagehide', function () {
    if (!decks.length) return;
    decks.forEach(function (d) {
      try {
        d.audio.pause();
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
  });

  root.SDPlayer = P;
})(window);
