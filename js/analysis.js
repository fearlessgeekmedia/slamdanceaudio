/*
 * Slamdance Audio — decode + measure.
 *
 * One decode per track gives us duration, loudness and a tempo estimate. The
 * Pit Meter score is tempo and loudness combined: fast and loud is chaos,
 * slow and quiet is mellow. Both are documented in the UI so the number never
 * looks like magic.
 */
(function (root) {
  'use strict';

  var ctx = null;

  function getCtx() {
    if (ctx) return ctx;
    var C = root.AudioContext || root.webkitAudioContext;
    if (!C) throw new Error('Web Audio is not available in this browser.');
    ctx = new C();
    return ctx;
  }

  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  /* Static score used for the library. Tempo 55 → 0, 185 → 1; loudness
     -26 dBFS → 0, -8 dBFS → 1. Weighted 45/55 toward loudness. */
  function scoreIntensity(bpm, rmsDb) {
    var tempo = Math.pow(clamp01((bpm - 55) / 130), 0.8);
    var loud = clamp01((rmsDb + 26) / 18);
    return Math.round(100 * (0.45 * tempo + 0.55 * loud));
  }

  /* Live score from the analyser. The floor is lower here because a short
     window of a mix reads quieter than a whole-track RMS. */
  function liveScore(bpm, db) {
    var tempo = Math.pow(clamp01(((bpm || 100) - 55) / 130), 0.8);
    var loud = clamp01((db + 46) / 40);
    return Math.round(100 * (0.45 * tempo + 0.55 * loud));
  }

  function analyzeFile(file) {
    if (!file) return Promise.reject(new Error('No file'));
    return file.arrayBuffer().then(function (buffer) {
      return new Promise(function (resolve, reject) {
        var promise;
        try {
          // Callback form keeps older Safari happy; modern engines also return a promise.
          promise = getCtx().decodeAudioData(buffer, resolve, reject);
        } catch (err) {
          reject(err);
          return;
        }
        if (promise && typeof promise.then === 'function') promise.then(resolve, reject);
      });
    }).then(function (audio) {
      var sr = audio.sampleRate;
      var channels = audio.numberOfChannels;
      var limit = Math.min(audio.length, Math.floor(sr * 240)); // first four minutes
      var mono = new Float32Array(limit);

      for (var ch = 0; ch < channels; ch++) {
        var data = audio.getChannelData(ch);
        for (var i = 0; i < limit; i++) mono[i] += data[i];
      }
      if (channels > 1) {
        for (var m = 0; m < limit; m++) mono[m] /= channels;
      }

      // Whole-track RMS, sampled to keep this cheap on long files.
      var sum = 0;
      var n = 0;
      for (var s = 0; s < limit; s += 7) {
        var v = mono[s];
        sum += v * v;
        n++;
      }
      var rms = Math.sqrt(sum / Math.max(1, n));
      var rmsDb = 20 * Math.log10(rms + 1e-9);

      var tempo = root.SDBpm.detectTempo(mono, sr);
      var bpm = tempo.bpm;

      return {
        duration: audio.duration,
        sampleRate: sr,
        channels: channels,
        rmsDb: Math.round(rmsDb * 10) / 10,
        bpm: bpm,
        confidence: tempo.confidence,
        intensity: scoreIntensity(bpm || 100, rmsDb),
      };
    });
  }

  root.SDAnalysis = {
    analyzeFile: analyzeFile,
    scoreIntensity: scoreIntensity,
    liveScore: liveScore,
  };
})(window);
