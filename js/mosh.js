/*
 * Slamdance Audio — Mosh Mode visualizer.
 *
 * A canvas pit of pixel figures rendered at 360×200 and stretched by CSS with
 * image-rendering: pixelated. Pogoers bounce, skankers lean, and the circle pit
 * expands as the live intensity climbs. Drawing fades the previous frame so
 * bodies leave a short trail.
 */
(function (root) {
  'use strict';

  var W = 360;
  var H = 200;
  var canvas = null;
  var c = null;
  var signal = null;
  var raf = null;
  var active = false;
  var last = 0;
  var clock = 0;
  var level = 0;
  var intensity = 0;
  var bpm = 0;
  var beatPhase = 0;
  var pulse = 0;
  var figures = [];
  var dust = [];
  var colors = {};
  var reduced = false;
  var FLOOR = H - 26;

  function pick(name, fallback) {
    var cs = getComputedStyle(document.documentElement);
    var v = cs.getPropertyValue(name).trim();
    return v || fallback;
  }

  function refreshColors() {
    colors = {
      a: pick('--figure-a', '#ff3b00'),
      b: pick('--figure-b', '#c8ff00'),
      c: pick('--figure-c', '#f5f1e6'),
      d: pick('--figure-d', '#7a6cff'),
      floor: pick('--floor', '#ff3b00'),
    };
  }

  function resetFigures() {
    var palette = ['a', 'b', 'c', 'd'];
    figures = [];
    for (var i = 0; i < 18; i++) {
      figures.push({
        style: i % 3,
        home: 22 + Math.random() * (W - 44),
        phase: Math.random() * Math.PI * 2,
        speed: 2.1 + Math.random() * 2.6,
        color: palette[i % palette.length],
        orbit: 0.55 + Math.random() * 0.9,
        dir: Math.random() > 0.5 ? 1 : -1,
        big: Math.random() > 0.88,
      });
    }
    dust = [];
  }

  function spawnDust() {
    if (intensity < 52) return;
    dust.push({
      x: 20 + Math.random() * (W - 40),
      y: FLOOR - 2,
      vy: -(18 + Math.random() * 44),
      life: 1,
    });
    if (dust.length > 90) dust.shift();
  }

  function pixelPerson(x, y, lean, color, kick) {
    c.fillStyle = color;
    // head
    c.fillRect(x + 1 + lean, y, 3, 3);
    // torso
    c.fillRect(x + 1 + lean, y + 3, 3, 4);
    // arms
    c.fillRect(x - 1 + lean, y + 3, 2, 1);
    c.fillRect(x + 4 + lean, y + 3, 2, 1);
    // legs
    c.fillRect(x + 1 + lean, y + 7, 1, kick ? 2 : 3);
    c.fillRect(x + 3 + lean, y + 7, 1, kick ? 4 : 3);
  }

  function bandEnergy(spectrum, fraction) {
    if (!spectrum || !spectrum.length) return 0;
    var idx = Math.min(spectrum.length - 1, Math.max(0, Math.floor(fraction * spectrum.length)));
    return spectrum[idx] / 255;
  }

  function draw(sig, dt) {
    if (!c) return;
    var heat = Math.min(1, intensity / 100);

    // Trail: erase most of the previous frame rather than filling a colour,
    // so the transparent canvas works under every skin.
    c.globalCompositeOperation = 'destination-out';
    c.fillStyle = 'rgba(0, 0, 0, 0.52)';
    c.fillRect(0, 0, W, H);
    c.globalCompositeOperation = 'source-over';

    var spec = sig && sig.spectrum ? sig.spectrum : null;
    var beams = [
      { x: W * 0.18, w: 0.3, e: bandEnergy(spec, 0.08) },
      { x: W * 0.5, w: 0.36, e: bandEnergy(spec, 0.2) },
      { x: W * 0.82, w: 0.3, e: bandEnergy(spec, 0.42) },
    ];

    for (var bi = 0; bi < beams.length; bi++) {
      var beam = beams[bi];
      var energy = beam.e || 0;
      if (energy < 0.05 && heat < 0.2) continue;
      var spread = 18 + energy * 40 + heat * 18;
      c.beginPath();
      c.moveTo(W * beam.x - 4, -4);
      c.lineTo(W * beam.x + 4, -4);
      c.lineTo(W * beam.x + spread, FLOOR);
      c.lineTo(W * beam.x - spread, FLOOR);
      c.closePath();
      c.fillStyle = bi === 1 ? colors.b : colors.a;
      c.globalAlpha = 0.035 + energy * 0.09 + heat * 0.02;
      c.fill();
      c.globalAlpha = 1;
    }

    // Dancefloor glow and barricade line.
    c.globalAlpha = 0.18 + level * 0.5;
    c.fillStyle = colors.floor;
    c.fillRect(8, FLOOR, W - 16, 2);
    c.globalAlpha = 0.1;
    c.fillRect(8, FLOOR + 7, W - 16, 1);
    c.globalAlpha = 1;

    // Dust kicked up by the pit.
    for (var d = dust.length - 1; d >= 0; d--) {
      var p = dust[d];
      p.y += p.vy * dt;
      p.vy += 26 * dt;
      p.life -= dt * 0.55;
      if (p.life <= 0) {
        dust.splice(d, 1);
        continue;
      }
      c.globalAlpha = Math.max(0, p.life) * 0.55;
      c.fillStyle = colors.c;
      c.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
    }
    c.globalAlpha = 1;

    var count = Math.min(figures.length, 3 + Math.round(intensity / 6.2));
    for (var i = 0; i < count; i++) {
      var f = figures[i];
      var x = 0;
      var y = 0;
      var lean = 0;
      var kick = 0;

      if (f.style === 0) {
        var t = clock * f.speed + f.phase;
        var hop = Math.abs(Math.sin(t)) * (4 + heat * 30);
        x = f.home + (W / 2 - f.home) * heat * 0.5 * (0.5 + 0.5 * Math.sin(clock * 0.45 + f.phase));
        y = FLOOR - 10 - hop;
        lean = Math.round(Math.sin(t) * heat * 1.6);
      } else if (f.style === 1) {
        var s = Math.sin(clock * f.speed * 0.8 + f.phase);
        x = f.home + s * (3 + heat * 12);
        y = FLOOR - 10 - Math.abs(s) * (2 + heat * 6);
        lean = s > 0 ? 2 : -2;
        kick = 1;
      } else {
        var a = clock * f.orbit * f.dir + f.phase;
        var rx = 16 + heat * (W * 0.34);
        var ry = 4 + heat * 13;
        x = W / 2 + Math.cos(a) * rx;
        y = FLOOR - 10 - Math.abs(Math.sin(a)) * ry - heat * 3;
        lean = Math.round(Math.sin(a * 2) * heat * 2);
        kick = Math.sin(clock * f.speed * 2 + f.phase) > 0 ? 1 : 0;
      }

      var px = Math.round(x);
      var py = Math.round(y);
      pixelPerson(px, py, lean, colors[f.color] || colors.a, kick);
      if (f.big) {
        // a taller one, so the crowd is not uniform
        c.fillRect(px + 1 + lean, py - 2, 3, 2);
        c.fillRect(px + 1 + lean, py + 6, 3, 2);
      }
    }

    // Strobe on the beat when the pit is really going.
    if (pulse > 0.5 && intensity > 68) {
      c.globalAlpha = 0.04 + pulse * 0.05;
      c.fillStyle = colors.a;
      c.fillRect(0, 0, W, H);
      c.globalAlpha = 1;
    }
  }

  function frame(ts) {
    raf = null;
    if (!active) return;
    var dt = last ? Math.min(0.06, (ts - last) / 1000) : 0.016;
    last = ts;
    clock += dt;

    var sig = signal ? signal() : null;
    var targetLevel = sig && typeof sig.level === 'number' ? sig.level : 0;
    level += (targetLevel - level) * Math.min(1, dt * 9);

    var targetIntensity = sig && typeof sig.intensity === 'number' ? sig.intensity : level * 100;
    intensity += (targetIntensity - intensity) * Math.min(1, dt * 3.2);

    bpm = sig && sig.bpm ? sig.bpm : 0;
    if (bpm > 0) {
      beatPhase += (dt * bpm) / 60;
      if (beatPhase >= 1) {
        beatPhase -= Math.floor(beatPhase);
        pulse = 1;
        spawnDust();
      }
    } else if (level > 0.5) {
      pulse = Math.max(pulse, level);
    }
    pulse *= Math.pow(0.02, dt);

    draw(sig, dt);
    raf = requestAnimationFrame(frame);
  }

  function setActive(on) {
    on = !!on;
    if (on === active) return;
    active = on;
    last = 0;
    if (on && !reduced) {
      if (!raf) raf = requestAnimationFrame(frame);
    } else {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      if (on) {
        // Reduced motion: one representative frame, no animation.
        var sig = signal ? signal() : null;
        level = sig && sig.level ? sig.level : 0;
        intensity = sig && sig.intensity ? sig.intensity : 0;
        draw(sig, 0.016);
      }
    }
  }

  function init(canvasEl, signalFn) {
    canvas = canvasEl;
    c = canvas.getContext('2d');
    canvas.width = W;
    canvas.height = H;
    signal = signalFn;
    reduced = !!(
      root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
    refreshColors();
    resetFigures();
    draw({ level: 0, spectrum: null, intensity: 0 }, 0.016);
  }

  root.SDMosh = {
    init: init,
    setActive: setActive,
    refreshColors: refreshColors,
  };
})(window);
