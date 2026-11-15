/*
 * Slamdance Audio self-test — node tests/selftest.js
 *
 * Covers the two algorithms that are hard to eyeball in a browser: tempo
 * detection and energy-arc ordering. Synthetic audio, no dependencies.
 */
'use strict';

const assert = require('node:assert');
const { detectTempo } = require('../js/bpm.js');
const { buildEnergyArc, arcTargets } = require('../js/arc.js');

const SR = 44100;

function makeTrack(intensity, name) {
  return { title: name || 't' + intensity, intensity };
}

function clickTrack(bpm, seconds, opts) {
  const options = opts || {};
  const out = new Float32Array(Math.floor(SR * seconds));
  const beat = 60 / bpm;
  const beats = Math.floor(seconds / beat);

  // Quiet room tone so the detector is not handed a perfect signal.
  for (let i = 0; i < out.length; i++) out[i] = (Math.random() - 0.5) * 0.002;

  const addKick = (at) => {
    const start = Math.floor(at * SR);
    for (let i = 0; i < SR * 0.14 && start + i < out.length; i++) {
      const t = i / SR;
      const env = Math.exp(-t * 28);
      out[start + i] += Math.sin(2 * Math.PI * 55 * t) * env * 0.55;
    }
  };
  const addSnare = (at) => {
    const start = Math.floor(at * SR);
    for (let i = 0; i < SR * 0.09 && start + i < out.length; i++) {
      const t = i / SR;
      const env = Math.exp(-t * 42);
      out[start + i] += (Math.random() - 0.5) * env * 0.5;
    }
  };
  const addHat = (at) => {
    const start = Math.floor(at * SR);
    for (let i = 0; i < SR * 0.03 && start + i < out.length; i++) {
      const env = Math.exp(-(i / SR) * 120);
      out[start + i] += (Math.random() - 0.5) * env * 0.12;
    }
  };

  for (let b = 0; b < beats; b++) {
    const at = b * beat;
    const inBar = options.bars ? b % 4 : 0;
    if (options.bars) {
      if (inBar === 0 || inBar === 2) addKick(at);
      else addSnare(at);
      addHat(at);
      addHat(at + beat / 2);
    } else {
      addKick(at);
    }
  }
  return out;
}

// A pulse train correlates at every multiple of its period, so a report of the
// half or double tempo is musically the same beat. Anything else is a miss.
function sameBeat(actual, expected) {
  if (actual === null || actual === undefined) return false;
  const ratios = [1, 2, 0.5];
  return ratios.some((r) => Math.abs(actual - expected * r) <= 2);
}

const tempoCases = [88, 100, 120, 150, 168];
let tempoFailures = 0;
let tempoOctaveOnly = 0;

console.log('tempo detection');
for (const bpm of tempoCases) {
  for (const bars of [false, true]) {
    const audio = clickTrack(bpm, 22, { bars });
    const result = detectTempo(audio, SR);
    const exact = result.bpm !== null && Math.abs(result.bpm - bpm) <= 2;
    const ok = sameBeat(result.bpm, bpm);
    if (!ok) tempoFailures++;
    if (ok && !exact) tempoOctaveOnly++;
    console.log(
      `  ${String(bpm).padStart(3)} bpm ${bars ? 'full kit ' : 'click    '}` +
        ` -> ${String(result.bpm).padStart(6)} (conf ${result.confidence})` +
        `${exact ? ' ok' : ok ? ' ok (octave)' : ' MISMATCH'}`
    );
  }
}

const silence = new Float32Array(SR * 5);
assert.strictEqual(detectTempo(silence, SR).bpm, null, 'silence must not report a tempo');
console.log('  silence       -> null ok');

const short = new Float32Array(SR * 2);
assert.strictEqual(detectTempo(short, SR).bpm, null, 'very short input must not report a tempo');
console.log('  short input   -> null ok');

console.log('\nenergy arc');
const tracks = [10, 20, 30, 40, 50, 60, 70, 80, 90, 95].map((v, i) =>
  makeTrack(v, 'track' + i)
);
const arc = buildEnergyArc(tracks);
const profile = arc.map((t) => t.intensity);

assert.strictEqual(arc.length, tracks.length, 'arc must keep every track');
assert.strictEqual(new Set(arc.map((t) => t.title)).size, tracks.length, 'no duplicates');
assert.ok(profile[0] <= 30, 'arc must open mellow, got ' + profile[0]);
assert.strictEqual(
  profile[profile.length - 1],
  Math.max(...profile),
  'arc must close on the hardest track, got ' + profile[profile.length - 1]
);

const body = profile.slice(0, -1);
const bodyPeak = body.indexOf(Math.max(...body));
const bodyPeakPos = bodyPeak / (body.length - 1);
assert.ok(
  bodyPeakPos >= 0.4 && bodyPeakPos <= 0.9,
  'the pre-finale peak should land in the back half, got ' + Math.round(bodyPeakPos * 100) + '%'
);
console.log('  order         ->', profile.join(', '));
console.log('  hub position  ->', Math.round(bodyPeakPos * 100) + '%');

const targets = arcTargets(9);
assert.ok(Math.max(...targets) > 0, 'target shape must be positive');
assert.strictEqual(targets[targets.length - 1], Math.max(...targets), 'closer target must be highest');

const two = buildEnergyArc([makeTrack(70, 'a'), makeTrack(20, 'b')]);
assert.deepStrictEqual(two.map((t) => t.title), ['b', 'a'], 'two-track arc: mellow then hot');

const one = buildEnergyArc([makeTrack(50, 'only')]);
assert.deepStrictEqual(one.map((t) => t.title), ['only'], 'single-track arc passes through');

console.log('\nthemes');
global.window = global;
require('../themes/manifest.js');
const themes = require('../js/themes.js');
const vars = themes.buildVars({
  colors: {
    bg: '#101010',
    panel: '#1b1b1b',
    ink: '#f6f2e3',
    accent: '#e8112d',
    accent2: '#f5c518',
    line: '#2f2f2f',
  },
  fontDisplay: 'heavy',
  fontBody: 'system',
});
assert.strictEqual(
  Object.keys(vars).filter((key) => key.indexOf('--') !== 0).length,
  0,
  'every generated theme value must be a custom property'
);
for (const key of ['--bg', '--panel', '--ink', '--accent', '--accent-2', '--line', '--line-strong', '--ink-dim']) {
  assert.match(vars[key], /^#[0-9a-f]{6}$/, key + ' must be a hex colour, got ' + vars[key]);
}
const fs = require('node:fs');
const path = require('node:path');
const house = themes.all();
assert.strictEqual(house.length, 5, 'five house themes expected, got ' + house.length);
for (const theme of house) {
  assert.ok(theme.layout, theme.id + ' must have a layout');
  assert.ok(theme.file, theme.id + ' must name a CSS file');
  assert.strictEqual(
    theme.file,
    'themes/' + theme.id + '/' + theme.id + '.css',
    theme.id + ' must live in its own theme folder'
  );
  const file = path.join(__dirname, '..', theme.file);
  assert.ok(fs.existsSync(file), theme.file + ' must exist');
  const sheet = fs.readFileSync(file, 'utf8');
  assert.ok(
    sheet.indexOf('html[data-theme="' + theme.id + '"] {') !== -1,
    theme.id + ' must scope its CSS to its own id'
  );
  const declared = (sheet.match(/^\s*--[a-z0-9-]+:/gm) || []).length;
  assert.strictEqual(declared, 31, theme.id + ' must declare 31 variables, got ' + declared);
}
assert.ok(vars['--on-accent'], 'on-accent must be generated');
assert.match(vars['--radius'], /px$/, 'custom skins need a radius, got ' + vars['--radius']);
assert.match(vars['--head-case'], /uppercase|none/, 'custom skins need a heading case');
assert.match(vars['--font-display'], /Arial Black/, 'heavy display stack expected');
assert.strictEqual(themes.toHex('rgb(255, 59, 0)'), '#ff3b00', 'rgb() must normalise to hex');
assert.strictEqual(themes.toHex('#abc'), '#aabbcc', 'short hex must expand');
const block = themes.cssBlock({ id: 'basement-show', name: 'Basement', vars });
assert.ok(block.startsWith('/* Basement'), 'CSS export must start with a comment');
assert.ok(block.indexOf('[data-theme="basement-show"] {') !== -1, 'CSS export selector must carry the id');
assert.strictEqual(block.split('{').length, 2, 'CSS export must contain exactly one block');
const contrast = themes.luminance(vars['--accent']) > 0.55 ? '#0b0b0d' : '#fdf8ea';
assert.strictEqual(vars['--on-accent'], contrast, 'on-accent must contrast with the accent');
console.log('  buildVars     -> ' + Object.keys(vars).length + ' vars ok');
console.log('  cssBlock      -> selector ok');

console.log(
  '\n' +
    (tempoFailures === 0
      ? `all tests passed${tempoOctaveOnly ? ` (${tempoOctaveOnly} octave-equivalent reading(s))` : ''}`
      : tempoFailures + ' tempo mismatch(es)')
);
process.exit(tempoFailures === 0 ? 0 : 1);
