/*
 * Slamdance Audio — energy arc.   * Given a pile of tracks, order them so a set rises to a peak about two
   * thirds of the way through, then closes on a banger. Pure functions so the
   * shape can be tested without a browser.
 */
(function (root) {
  'use strict';

  function intensityOf(track) {
    var v = track && typeof track.intensity === 'number' ? track.intensity : 0;
    if (v !== v) return 0; // NaN
    return Math.max(0, Math.min(100, v));
  }

  // Target shape over the set. x^1.6 pushes the apex to roughly 65% of the set;
  // the opener is pulled down (warm-up) and the closer is forced to the top
  // (finale) so the night ends on the hardest thing you have.
  function arcTargets(n) {
    var targets = [];
    for (var k = 0; k < n; k++) {
      var x = (k + 1) / (n + 1);
      var hump = Math.sin(Math.PI * Math.pow(x, 1.6));
      targets.push(Math.pow(Math.max(0, hump), 0.9));
    }
    if (n >= 4) targets[0] *= 0.55;
    if (n >= 2) {
      var max = 0;
      for (var i = 0; i < targets.length - 1; i++) {
        if (targets[i] > max) max = targets[i];
      }
      targets[n - 1] = Math.max(targets[n - 1], max + 0.2);
    }
    return targets;
  }

  function buildEnergyArc(tracks) {
    var list = Array.isArray(tracks) ? tracks.slice() : [];
    if (list.length < 2) return list;

    var sorted = list.slice().sort(function (a, b) {
      return intensityOf(a) - intensityOf(b);
    });

    var targets = arcTargets(sorted.length);
    var slots = targets
      .map(function (v, k) {
        return { k: k, v: v };
      })
      .sort(function (a, b) {
        return a.v - b.v;
      });

    var out = new Array(sorted.length);
    for (var i = 0; i < sorted.length; i++) out[slots[i].k] = sorted[i];
    return out;
  }

  function arcProfile(tracks) {
    return (tracks || []).map(intensityOf);
  }

  function band(score) {
    var s = intensityOf({ intensity: score });
    if (s >= 85) return { key: 'chaos', label: 'Chaos' };
    if (s >= 65) return { key: 'hot', label: 'Hot' };
    if (s >= 40) return { key: 'mid', label: 'Mid' };
    return { key: 'mellow', label: 'Mellow' };
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = {
      buildEnergyArc: buildEnergyArc,
      arcTargets: arcTargets,
      arcProfile: arcProfile,
      band: band,
      intensityOf: intensityOf,
    };
  } else {
    root.SDArc = {
      buildEnergyArc: buildEnergyArc,
      arcTargets: arcTargets,
      arcProfile: arcProfile,
      band: band,
      intensityOf: intensityOf,
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
