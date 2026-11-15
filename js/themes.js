/*
 * Slamdance Audio — theme engine.
 *
 * A theme is a CSS file registered in themes/manifest.js, living in its own
 * themes/<id>/ folder. The file is scoped to html[data-theme="<id>"] and may
 * contain the variables below plus any CSS the markup allows. This file only loads packs, applies ids/layouts, and generates
 * CSS for skins made in the Workshop.
 */
(function (root) {
  'use strict';

  var FONTS = {
    heavy: { label: 'Heavy sans', stack: '"Arial Black", "Helvetica Neue", Impact, system-ui, sans-serif' },
    condensed: {
      label: 'Condensed heavy',
      stack:
        'Impact, Haettenschweiler, "Arial Narrow", "DejaVu Sans Condensed", "Liberation Sans Narrow", "Helvetica Neue", sans-serif',
    },
    system: {
      label: 'Clean sans',
      stack: 'ui-sans-serif, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    },
    serif: { label: 'Print serif', stack: 'Georgia, "Times New Roman", Times, serif' },
    mono: { label: 'Monospace', stack: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace' },
    typewriter: { label: 'Typewriter', stack: '"Courier New", ui-monospace, monospace' },
    rounded: { label: 'Rounded', stack: 'Verdana, Geneva, Tahoma, sans-serif' },
  };

  var MONO_STACK = FONTS.mono.stack;

  var VAR_KEYS = [
    '--bg',
    '--bg-2',
    '--panel',
    '--panel-2',
    '--ink',
    '--ink-dim',
    '--ink-faint',
    '--accent',
    '--accent-2',
    '--on-accent',
    '--line',
    '--line-strong',
    '--shadow',
    '--glow',
    '--figure-a',
    '--figure-b',
    '--figure-c',
    '--figure-d',
    '--floor',
    '--radius',
    '--radius-chip',
    '--panel-border',
    '--head-track',
    '--head-rot',
    '--head-skew',
    '--head-style',
    '--head-weight',
    '--head-case',
    '--font-display',
    '--font-body',
    '--font-mono',
  ];

  // ── colour maths ──────────────────────────────────────────
  function clamp255(v) {
    return Math.max(0, Math.min(255, Math.round(v)));
  }

  function parseHex(value) {
    if (typeof value !== 'string') return null;
    var s = value.trim();
    var m = /^#([0-9a-f]{3})$/i.exec(s);
    if (m) {
      return [
        parseInt(m[1][0] + m[1][0], 16),
        parseInt(m[1][1] + m[1][1], 16),
        parseInt(m[1][2] + m[1][2], 16),
      ];
    }
    m = /^#([0-9a-f]{6})$/i.exec(s);
    if (m) {
      return [
        parseInt(m[1].slice(0, 2), 16),
        parseInt(m[1].slice(2, 4), 16),
        parseInt(m[1].slice(4, 6), 16),
      ];
    }
    m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(s);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
    return null;
  }

  function toHex(value) {
    var rgb = parseHex(value);
    if (!rgb) return null;
    return (
      '#' +
      rgb
        .map(function (v) {
          return clamp255(v).toString(16).padStart(2, '0');
        })
        .join('')
    );
  }

  function mix(a, b, t) {
    var ca = parseHex(a) || [0, 0, 0];
    var cb = parseHex(b) || [0, 0, 0];
    var w = Math.max(0, Math.min(1, Number(t) || 0));
    var out = ca.map(function (v, i) {
      return clamp255(v * (1 - w) + cb[i] * w);
    });
    return toHex('rgb(' + out.join(',') + ')');
  }

  function luminance(hex) {
    var rgb = parseHex(hex);
    if (!rgb) return 0;
    var c = rgb.map(function (v) {
      var s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  // ── recipe → CSS variables ────────────────────────────────
  function buildVars(draft) {
    var colors = (draft && draft.colors) || {};
    var bg = toHex(colors.bg) || '#0a0a0c';
    var panel = toHex(colors.panel) || '#15151b';
    var ink = toHex(colors.ink) || '#f5f1e6';
    var accent = toHex(colors.accent) || '#ff3b00';
    var accent2 = toHex(colors.accent2) || '#c8ff00';
    var line = toHex(colors.line) || '#2a2a33';
    var display = FONTS[draft && draft.fontDisplay] || FONTS.heavy;
    var body = FONTS[draft && draft.fontBody] || FONTS.system;

    return {
      '--bg': bg,
      '--bg-2': mix(bg, ink, luminance(bg) > 0.5 ? 0.045 : 0.05),
      '--panel': panel,
      '--panel-2': mix(panel, ink, luminance(panel) > 0.5 ? 0.07 : 0.09),
      '--ink': ink,
      '--ink-dim': mix(ink, bg, 0.36),
      '--ink-faint': mix(ink, bg, 0.56),
      '--accent': accent,
      '--accent-2': accent2,
      '--on-accent': luminance(accent) > 0.55 ? '#0b0b0d' : '#fdf8ea',
      '--line': line,
      '--line-strong': mix(line, ink, 0.26),
      '--shadow': '3px 3px 0 var(--line-strong)',
      '--glow': 'none',
      '--figure-a': accent,
      '--figure-b': accent2,
      '--figure-c': ink,
      '--figure-d': mix(accent, accent2, 0.5),
      '--floor': accent,
      '--radius': '2px',
      '--radius-chip': '2px',
      '--panel-border': '2px',
      '--head-track': '0.02em',
      '--head-rot': '0deg',
      '--head-skew': '0deg',
      '--head-style': 'normal',
      '--head-weight': '900',
      '--head-case': 'uppercase',
      '--font-display': display.stack,
      '--font-body': body.stack,
      '--font-mono':
        draft && (draft.fontBody === 'mono' || draft.fontBody === 'typewriter')
          ? body.stack
          : MONO_STACK,
    };
  }

  // ── manifest ──────────────────────────────────────────────
  // Data only: [{ id, name, layout, file, glyphs? }]. Invalid or duplicate
  // entries are ignored rather than breaking boot.
  var manifest = [];
  var byId = {};

  (function readManifest() {
    var list = root.SD_THEME_MANIFEST;
    if (!Array.isArray(list)) return;
    list.forEach(function (entry) {
      if (!entry || typeof entry !== 'object') return;
      var id = String(entry.id || '').trim();
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || byId[id]) return;
      var theme = {
        id: id,
        name: String(entry.name || id),
        layout: String(entry.layout || 'classic'),
        file: typeof entry.file === 'string' ? entry.file : '',
        glyphs: entry.glyphs ? String(entry.glyphs) : '',
      };
      manifest.push(theme);
      byId[id] = theme;
    });
  })();

  function all() {
    return manifest.slice();
  }

  function get(id) {
    return byId[id] || null;
  }

  function nameOf(id) {
    var theme = get(id);
    return theme ? theme.name : '';
  }

  // ── loading ───────────────────────────────────────────────
  var readyFired = false;

  function markReady() {
    if (readyFired) return;
    readyFired = true;
    API.ready = true;
    if (typeof root.dispatchEvent === 'function' && typeof root.Event === 'function') {
      root.dispatchEvent(new root.Event('sd:themes-ready'));
    }
  }

  function load() {
    if (typeof document === 'undefined') return;
    if (!manifest.length) {
      markReady();
      return;
    }
    var left = manifest.length;
    function tick() {
      if (--left <= 0) markReady();
    }
    manifest.forEach(function (theme) {
      if (!theme.file) {
        tick();
        return;
      }
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = theme.file;
      link.setAttribute('data-theme-css', theme.id);
      link.onload = tick;
      link.onerror = tick;
      document.head.appendChild(link);
    });
    // Local files load instantly; a missing file must not hold boot hostage.
    root.setTimeout(markReady, 3000);
  }

  // ── applying ──────────────────────────────────────────────
  function clearVars() {
    if (typeof document === 'undefined') return;
    VAR_KEYS.forEach(function (key) {
      document.documentElement.style.removeProperty(key);
    });
  }

  function apply(id) {
    if (typeof document === 'undefined') return null;
    var theme = get(id) || get('pit') || manifest[0];
    if (!theme) return null;
    document.documentElement.setAttribute('data-theme', theme.id);
    document.documentElement.setAttribute('data-layout', theme.layout || 'classic');
    clearVars();
    return theme;
  }

  function customStyle(id) {
    if (typeof document === 'undefined') return null;
    return document.getElementById('theme-custom-' + id);
  }

  function applyCustom(id, css, layout) {
    if (typeof document === 'undefined') return null;
    var themeId = String(id || '').trim() || 'custom-preview';
    var style = customStyle(themeId);
    if (!style) {
      style = document.createElement('style');
      style.id = 'theme-custom-' + themeId;
      style.setAttribute('data-custom-theme', '');
      document.head.appendChild(style);
    }
    style.textContent = css || '';
    document.documentElement.setAttribute('data-theme', themeId);
    document.documentElement.setAttribute('data-layout', layout || 'classic');
    clearVars();
    return themeId;
  }

  function removeCustom(id) {
    var style = customStyle(id);
    if (style) style.remove();
  }

  function applyVars(vars, layout) {
    return applyCustom('custom-preview', cssRule('custom-preview', vars), layout);
  }

  // ── CSS generation ────────────────────────────────────────
  function cssRule(id, vars) {
    var lines = Object.keys(vars || {}).map(function (key) {
      return '  ' + key + ': ' + vars[key] + ';';
    });
    return 'html[data-theme="' + id + '"] {\n' + lines.join('\n') + '\n}';
  }

  function themeFile(theme) {
    var id = theme && theme.id ? String(theme.id) : 'custom';
    var name = (theme && theme.name) || 'Custom skin';
    return (
      '/* ' +
      name +
      ' — Slamdance Audio theme.\n' +
      ' * Save as themes/' +
      id +
      '/' +
      id +
      '.css and add it to themes/manifest.js. */\n' +
      cssRule(id, (theme && theme.vars) || {})
    );
  }

  function cssBlock(theme) {
    return themeFile(theme);
  }

  function slug(name) {
    return (
      String(name || 'skin')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32) || 'skin'
    );
  }

  function fontKey(stack) {
    var s = String(stack || '').toLowerCase();
    if (!s) return 'system';
    if (s.indexOf('impact') !== -1 || s.indexOf('condensed') !== -1 || s.indexOf('narrow') !== -1) {
      return 'condensed';
    }
    if (s.indexOf('arial black') !== -1) return 'heavy';
    if (s.indexOf('courier') !== -1) return 'typewriter';
    if (s.indexOf('mono') !== -1) return 'mono';
    if (s.indexOf('georgia') !== -1 || s.indexOf('times') !== -1 || s.indexOf('serif') !== -1) return 'serif';
    if (s.indexOf('verdana') !== -1) return 'rounded';
    return 'system';
  }

  var API = {
    FONTS: FONTS,
    VAR_KEYS: VAR_KEYS,
    all: all,
    get: get,
    nameOf: nameOf,
    load: load,
    apply: apply,
    applyCustom: applyCustom,
    removeCustom: removeCustom,
    applyVars: applyVars,
    buildVars: buildVars,
    cssRule: cssRule,
    themeFile: themeFile,
    cssBlock: cssBlock,
    clearVars: clearVars,
    toHex: toHex,
    mix: mix,
    luminance: luminance,
    fontKey: fontKey,
    slug: slug,
  };

  root.SDThemes = API;
  if (typeof module === 'object' && module.exports) module.exports = API;

  load();
})(typeof globalThis !== 'undefined' ? globalThis : this);
