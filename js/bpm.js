/*
 * Slamdance Audio — tempo detection.
 *
 * Pure function, no DOM, no Web Audio. Tuning of the algorithm is verified in
 * tests/selftest.js against synthetic click tracks.
 *
 * Approach: short-time RMS envelope, positive log-energy difference (onset
 * strength), local-mean removal, then normalised autocorrelation over the lag
 * range that corresponds to 60-200 BPM. The winning lag is refined with
 * parabolic interpolation and folded into a musically useful window.
 *
 * This is a decent estimate, not a transcription. It is always editable in the
 * Liner Notes panel, and the UI says "est." wherever it is shown.
 */
(function (root) {
  'use strict';

  var MIN_BPM = 60;
  var MAX_BPM = 200;

  function sumOfSquares(arr, from, to) {
    var s = 0;
    for (var i = from; i < to; i++) s += arr[i] * arr[i];
    return s;
  }

  function detectTempo(samples, sampleRate) {
    if (!samples || !sampleRate || samples.length < sampleRate * 4) {
      return { bpm: null, confidence: 0 };
    }

    // ~11.6 ms hop at 44.1 kHz. Gives ~86 envelope frames per second, which is
    // enough resolution for the 60-200 BPM lag range at a sane cost.
    var hop = Math.max(64, Math.round(sampleRate * 0.0116));
    var frames = Math.floor(samples.length / hop);
    var env = new Float32Array(frames);
    var total = 0;

    for (var i = 0; i < frames; i++) {
      var start = i * hop;
      var sum = 0;
      for (var j = start; j < start + hop; j++) {
        var v = samples[j];
        sum += v * v;
      }
      env[i] = Math.sqrt(sum / hop);
      total += env[i];
    }

    if (total / frames < 1e-4) return { bpm: null, confidence: 0 }; // silence

    // Onset strength: how much louder this frame is than the last, in dB.
    var onset = new Float32Array(frames);
    for (var k = 1; k < frames; k++) {
      var d = Math.log(1e-5 + env[k]) - Math.log(1e-5 + env[k - 1]);
      onset[k] = d > 0 ? d : 0;
    }

    // Remove the slow moving average so sustained loud sections do not swamp
    // the transients.
    var prefix = new Float64Array(frames + 1);
    for (var p = 0; p < frames; p++) prefix[p + 1] = prefix[p] + onset[p];
    var centred = new Float32Array(frames);
    var half = 12;
    for (var c = 0; c < frames; c++) {
      var a = Math.max(0, c - half);
      var b = Math.min(frames, c + half + 1);
      var mean = (prefix[b] - prefix[a]) / (b - a);
      var value = onset[c] - mean;
      centred[c] = value > 0 ? value : 0;
    }

    var fps = sampleRate / hop;
    var minLag = Math.max(2, Math.floor((60 * fps) / MAX_BPM));
    var maxLag = Math.min(frames - 2, Math.ceil((60 * fps) / MIN_BPM));
    if (maxLag - minLag < 4) return { bpm: null, confidence: 0 };

    var lagScores = new Float32Array(maxLag + 2);
    var bestLag = minLag;
    var bestScore = -1;

    for (var lag = minLag; lag <= maxLag; lag++) {
      var num = 0;
      var e1 = 0;
      var e2 = 0;
      var n = frames - lag;
      for (var m = 0; m < n; m++) {
        var x = centred[m];
        var y = centred[m + lag];
        num += x * y;
        e1 += x * x;
        e2 += y * y;
      }
      var denom = Math.sqrt(e1 * e2);
      var score = denom > 1e-12 ? num / denom : 0;
      lagScores[lag] = score;
      if (score > bestScore) {
        bestScore = score;
        bestLag = lag;
      }
    }

    if (bestScore <= 0.01) return { bpm: null, confidence: 0 };

    // A pulse train correlates at every multiple of its period, so the global
    // maximum often lands on a sub-harmonic (the classic half-time error). Take
    // the *fastest* local peak that is nearly as strong as the best one, since
    // that is the pulse a listener taps along to. The fold below still catches
    // genuinely slow readings.
    var chosenLag = bestLag;
    var strongEnough = bestScore * 0.7;
    for (var cl = minLag + 1; cl < maxLag; cl++) {
      if (
        lagScores[cl] >= strongEnough &&
        lagScores[cl] >= lagScores[cl - 1] &&
        lagScores[cl] >= lagScores[cl + 1]
      ) {
        chosenLag = cl;
        break;
      }
    }

    // Parabolic interpolation around the chosen integer lag.
    var y0 = lagScores[chosenLag - 1] || 0;
    var y1 = lagScores[chosenLag];
    var y2 = lagScores[chosenLag + 1] || 0;
    var curve = y0 - 2 * y1 + y2;
    var shift = curve !== 0 ? (0.5 * (y0 - y2)) / curve : 0;
    if (shift > 0.5) shift = 0.5;
    if (shift < -0.5) shift = -0.5;

    var lagRef = chosenLag + shift;
    var bpm = (60 * fps) / lagRef;

    // Fold the reading into one canonical octave. A pulse train correlates at
    // every multiple of its period, so 88 and 176 describe the same beat; the
    // Pit Meter should not swing because the detector picked a different peak.
    // 85-175 keeps common ska and punk tempos on the number people expect.
    while (bpm < 85) bpm *= 2;
    while (bpm >= 175) bpm /= 2;

    return {
      bpm: Math.round(bpm * 10) / 10,
      confidence: Math.round(Math.min(1, Math.max(0, bestScore)) * 100) / 100,
      lag: Math.round(lagRef * 100) / 100,
    };
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { detectTempo: detectTempo };
  } else {
    root.SDBpm = { detectTempo: detectTempo };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
