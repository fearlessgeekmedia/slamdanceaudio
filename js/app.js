/*
 * Slamdance Audio — UI.
 *
 * Classic script, no build step, no framework. Everything is wired by id so the
 * whole app runs from a double-clicked index.html.
 */
(function () {
  'use strict';

  var S = window.SDStore;
  var P = window.SDPlayer;
  var A = window.SDAnalysis;
  var Arc = window.SDArc;
  var Themes = window.SDThemes;
  var Metadata = window.SDMetadata;

  var settings = { customThemes: [] };
  var queue = [];
  var current = null;
  var lastTrack = null;
  var libraryView = [];
  var arcTracks = [];
  var moshOn = false;
  var analyzing = false;
  var pendingRelink = null;
  var notesTrackId = null;
  var seekDragging = false;
  var editingThemeId = null;
  var filters = { search: '', sort: 'added', heat: 'all', scene: null };
  var radio = { on: false, scope: 'all', scene: null, streamId: null, recent: [] };
  var VIEWS = ['player', 'library', 'pit', 'arc', 'radio', 'internet', 'notes', 'themes'];
  var LAYOUT_DEFAULTS = { pit: true, grain: true, hero: true, live: true, wide: false };
  var CARD_KEYS = ['hero', 'live', 'dropzone', 'queue'];
  var cutoutActive = false;

  // ── tiny helpers ──────────────────────────────────────────
  function $(id) {
    return document.getElementById(id);
  }

  function on(el, evt, fn) {
    if (el) el.addEventListener(evt, fn);
  }

  function setText(id, value) {
    var el = $(id);
    if (el) el.textContent = value;
  }

  // Use the authored empty-state heading rather than a second hardcoded copy.
  var idleTitle = ($('np-title') && $('np-title').textContent.trim()) || 'Audio';

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function setWidth(id, pct) {
    var el = $(id);
    if (el) el.style.width = clamp(Number(pct) || 0, 0, 100) + '%';
  }

  function fmtTime(sec) {
    var total = Math.max(0, Math.floor(Number(sec) || 0));
    var minutes = Math.floor(total / 60);
    var seconds = total % 60;
    return minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
  }

  function fmtSize(bytes) {
    var b = Number(bytes) || 0;
    if (!b) return '';
    if (b < 1024 * 1024) return Math.max(1, Math.round(b / 1024)) + ' KB';
    return (b / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function extOf(name) {
    var match = /\.([a-z0-9]+)$/i.exec(name || '');
    return match ? match[1].toUpperCase() : 'AUDIO';
  }

  function localTracks() {
    return S.state.tracks.filter(function (track) {
      return !track.stream;
    });
  }

  function streamTracks() {
    return S.state.tracks.filter(function (track) {
      return track.stream;
    });
  }

  function scoreOr(track, fallback) {
    return typeof track.intensity === 'number' ? track.intensity : fallback;
  }

  function toast(message, kind) {
    var host = $('toasts');
    if (!host) return;
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' is-' + kind : '');
    el.textContent = message;
    host.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .3s ease';
      el.style.opacity = '0';
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 320);
    }, 4200);
  }

  // ── views ─────────────────────────────────────────────────
  function setView(name, silent) {
    if (VIEWS.indexOf(name) === -1) name = 'player';
    Array.prototype.forEach.call(document.querySelectorAll('.panel'), function (panel) {
      panel.classList.toggle('is-active', panel.getAttribute('data-panel') === name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.nav-btn'), function (btn) {
      btn.classList.toggle('is-active', btn.getAttribute('data-view') === name);
    });
    var views = $('views');
    if (views) views.scrollTop = 0;
    settings.lastView = name;
    if (!silent) S.save();
    if (name === 'library') renderLibrary();
    if (name === 'pit') renderPitPanel();
    if (name === 'arc') renderArc();
    if (name === 'radio' || name === 'internet') {
      renderStations();
      renderRadioPanelState();
    }
    if (name === 'notes') renderNotes(true);
    if (name === 'themes') {
      renderCustomThemes();
      if (!$('theme-name').value) syncEditor();
    }
  }

  // ── themes ────────────────────────────────────────────────
  // Punk's ransom-note headings need each letter boxed separately. Only that
  // skin splits the text; every other skin restores the original nodes.
  function splitCutout(el) {
    if (el.getAttribute('data-cutout') === 'on') return;
    el.setAttribute('aria-label', el.textContent.trim());
    el.setAttribute('data-cutout', 'on');

    // Keep count badges and other element children live so their text can
    // still be updated while the heading is split.
    var original = Array.prototype.slice.call(el.childNodes);
    var restore = [];
    el.textContent = '';
    original.forEach(function (node) {
      if (node.nodeType === 3) {
        restore.push(node);
        Array.prototype.forEach.call(node.nodeValue, function (ch) {
          var span = document.createElement('span');
          span.className = /\s/.test(ch) ? 'cut cut-space' : 'cut';
          span.setAttribute('aria-hidden', 'true');
          span.textContent = /\s/.test(ch) ? '\u00A0' : ch;
          el.appendChild(span);
        });
      } else if (node.nodeType === 1) {
        restore.push(node);
        el.appendChild(node);
      }
    });
    el._cutoutNodes = restore;
  }

  function unsplitCutout(el) {
    if (el.getAttribute('data-cutout') !== 'on') return;
    el.textContent = '';
    (el._cutoutNodes || []).forEach(function (node) {
      el.appendChild(node);
    });
    delete el._cutoutNodes;
    el.removeAttribute('data-cutout');
    el.removeAttribute('data-cutout-text');
    el.removeAttribute('aria-label');
  }

  function applyCutout(on) {
    cutoutActive = on;
    Array.prototype.forEach.call(
      document.querySelectorAll('.brand-main, .np-title, .block-head h2, .card h3, .preview-title'),
      function (el) {
        if (on) splitCutout(el);
        else unsplitCutout(el);
      }
    );
  }

  function setHeroTitle(value) {
    var el = $('np-title');
    if (!el) return;
    unsplitCutout(el);
    el.textContent = value;
    if (cutoutActive) splitCutout(el);
  }

  function layoutOn(key) {
    var saved = settings.layout || {};
    return typeof saved[key] === 'boolean' ? saved[key] : LAYOUT_DEFAULTS[key];
  }

  function applyLayout() {
    var root = document.documentElement;
    root.classList.toggle('hide-pit', !layoutOn('pit'));
    root.classList.toggle('hide-grain', !layoutOn('grain'));
    root.classList.toggle('hide-hero', !layoutOn('hero'));
    root.classList.toggle('hide-live', !layoutOn('live'));
    root.classList.toggle('wide', layoutOn('wide'));
    Object.keys(LAYOUT_DEFAULTS).forEach(function (key) {
      var box = $('ly-' + key);
      if (box) box.checked = layoutOn(key);
    });
  }

  function setLayout(key, value) {
    if (!settings.layout || typeof settings.layout !== 'object') settings.layout = {};
    settings.layout[key] = !!value;
    S.save();
    applyLayout();
  }

  function applyCards() {
    var collapsed = settings.collapsedCards || {};
    CARD_KEYS.forEach(function (key) {
      var card = document.querySelector('[data-card="' + key + '"]');
      if (!card) return;
      var closed = !!collapsed[key];
      card.classList.toggle('is-collapsed', closed);
      var btn = card.querySelector('[data-card-toggle="' + key + '"]');
      if (!btn) return;
      var label = btn.getAttribute('data-card-label') || 'card';
      btn.setAttribute('aria-expanded', String(!closed));
      btn.textContent = closed ? '+' : '\u2212';
      btn.title = (closed ? 'Open ' : 'Close ') + label;
      btn.setAttribute('aria-label', btn.title);
    });
  }

  function setCardCollapsed(key, closed) {
    if (!settings.collapsedCards || typeof settings.collapsedCards !== 'object') {
      settings.collapsedCards = {};
    }
    settings.collapsedCards[key] = !!closed;
    S.save();
    applyCards();
  }

  function applyThemeId(id, persist) {
    var customs = settings.customThemes || [];
    var custom = null;
    for (var i = 0; i < customs.length; i++) {
      if (customs[i].id === id) {
        custom = customs[i];
        break;
      }
    }
    var theme;
    var effective;
    if (custom) {
      effective = Themes.applyCustom(
        custom.id,
        custom.css || Themes.cssRule(custom.id, custom.vars),
        custom.layout || 'classic'
      );
      theme = custom;
    } else {
      theme = Themes.apply(id) || Themes.get('pit');
      effective = theme ? theme.id : 'pit';
    }
    applyCutout(!!theme && theme.glyphs === 'ransom');
    if (persist) {
      settings.theme = effective;
      S.save();
    }
    var select = $('theme-select');
    if (select) select.value = effective;
    if (window.SDMosh) window.SDMosh.refreshColors();
    setText('theme-status', custom ? 'Custom · ' + custom.name : theme ? theme.name : 'Mosh Pit');
    if (arcTracks.length) renderArc();
  }

  function fillThemeSelects() {
    var select = $('theme-select');
    if (select) {
      select.textContent = '';
      var house = document.createElement('optgroup');
      house.label = 'House skins';
      Themes.all().forEach(function (theme) {
        var option = document.createElement('option');
        option.value = theme.id;
        option.textContent = theme.name;
        house.appendChild(option);
      });
      select.appendChild(house);

      var customs = settings.customThemes || [];
      if (customs.length) {
        var mine = document.createElement('optgroup');
        mine.label = 'Your skins';
        customs.forEach(function (theme) {
          var option = document.createElement('option');
          option.value = theme.id;
          option.textContent = theme.name;
          mine.appendChild(option);
        });
        select.appendChild(mine);
      }
      var add = document.createElement('option');
      add.value = '__import';
      add.textContent = '＋ Import theme…';
      select.appendChild(add);
      select.value = settings.theme;
      if (!select.value) select.value = 'pit';
    }

    var base = $('theme-base');
    if (base) {
      base.textContent = '';
      Themes.all().forEach(function (theme) {
        var option = document.createElement('option');
        option.value = theme.id;
        option.textContent = theme.name;
        base.appendChild(option);
      });
      base.value = Themes.get(settings.theme) ? settings.theme : 'pit';
    }

    ['tc-font-display', 'tc-font-body'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.textContent = '';
      Object.keys(Themes.FONTS).forEach(function (key) {
        var option = document.createElement('option');
        option.value = key;
        option.textContent = Themes.FONTS[key].label;
        el.appendChild(option);
      });
    });
  }

  function syncEditor() {
    var cs = getComputedStyle(document.documentElement);
    function color(name, fallback) {
      return Themes.toHex(cs.getPropertyValue(name).trim()) || fallback;
    }
    $('tc-bg').value = color('--bg', '#0a0a0c');
    $('tc-panel').value = color('--panel', '#15151b');
    $('tc-ink').value = color('--ink', '#f5f1e6');
    $('tc-accent').value = color('--accent', '#ff3b00');
    $('tc-accent2').value = color('--accent-2', '#c8ff00');
    $('tc-line').value = color('--line', '#2a2a33');
    $('tc-font-display').value = Themes.fontKey(cs.getPropertyValue('--font-display'));
    $('tc-font-body').value = Themes.fontKey(cs.getPropertyValue('--font-body'));
  }

  function readDraft() {
    return {
      name: ($('theme-name').value || '').trim() || 'Untitled skin',
      colors: {
        bg: $('tc-bg').value,
        panel: $('tc-panel').value,
        ink: $('tc-ink').value,
        accent: $('tc-accent').value,
        accent2: $('tc-accent2').value,
        line: $('tc-line').value,
      },
      fontDisplay: $('tc-font-display').value || 'heavy',
      fontBody: $('tc-font-body').value || 'system',
    };
  }

  function previewDraft() {
    var draft = readDraft();
    Themes.applyVars(Themes.buildVars(draft));
    applyCutout(false);
    if (window.SDMosh) window.SDMosh.refreshColors();
    setText('theme-status', 'Preview · ' + draft.name);
    if (arcTracks.length) renderArc();
  }

  function saveThemeDraft() {
    var draft = readDraft();
    var id = editingThemeId || 'custom-' + Date.now().toString(36);
    var vars = Themes.buildVars(draft);
    var theme = {
      id: id,
      name: draft.name,
      layout: 'classic',
      colors: draft.colors,
      fontDisplay: draft.fontDisplay,
      fontBody: draft.fontBody,
      vars: vars,
      css: Themes.cssRule(id, vars),
    };
    var list = settings.customThemes || (settings.customThemes = []);
    var replaced = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === theme.id) {
        list[i] = theme;
        replaced = true;
        break;
      }
    }
    if (!replaced) list.push(theme);
    editingThemeId = theme.id;
    settings.theme = theme.id;
    S.save();
    fillThemeSelects();
    renderCustomThemes();
    applyThemeId(theme.id, false);
    setText('theme-status', 'Saved · ' + theme.name);
    showThemeCss();
    toast('Skin "' + theme.name + '" saved to your list.', 'good');
  }

  function loadThemeIntoEditor(theme) {
    editingThemeId = theme.id;
    $('theme-name').value = theme.name;
    var colors = theme.colors || {};
    $('tc-bg').value = Themes.toHex(colors.bg || theme.vars['--bg']);
    $('tc-panel').value = Themes.toHex(colors.panel || theme.vars['--panel']);
    $('tc-ink').value = Themes.toHex(colors.ink || theme.vars['--ink']);
    $('tc-accent').value = Themes.toHex(colors.accent || theme.vars['--accent']);
    $('tc-accent2').value = Themes.toHex(colors.accent2 || theme.vars['--accent-2']);
    $('tc-line').value = Themes.toHex(colors.line || theme.vars['--line']);
    $('tc-font-display').value = theme.fontDisplay || Themes.fontKey(theme.vars['--font-display']);
    $('tc-font-body').value = theme.fontBody || Themes.fontKey(theme.vars['--font-body']);
    Themes.applyCustom(
      theme.id,
      theme.css || Themes.cssRule(theme.id, theme.vars),
      theme.layout || 'classic'
    );
    applyCutout(false);
    if (window.SDMosh) window.SDMosh.refreshColors();
    setText('theme-status', 'Editing · ' + theme.name);
    setView('themes');
  }

  function deleteCustomTheme(id) {
    settings.customThemes = (settings.customThemes || []).filter(function (theme) {
      return theme.id !== id;
    });
    if (editingThemeId === id) {
      editingThemeId = null;
      $('theme-name').value = '';
    }
    if (settings.theme === id) settings.theme = 'pit';
    Themes.removeCustom(id);
    S.save();
    fillThemeSelects();
    renderCustomThemes();
    applyThemeId(settings.theme, false);
    syncEditor();
    toast('Skin deleted.');
  }

  function importOptions() {
    return {
      reservedIds: Themes.all()
        .map(function (theme) {
          return theme.id;
        })
        .concat('custom-preview'),
    };
  }

  function importFailed(error) {
    console.warn('[theme import]', error);
    setText('theme-status', 'Import failed');
    toast((error && error.message) || 'Could not read that theme.', 'bad');
  }

  function installImportedTheme(theme) {
    theme.source = 'imported';
    var list = settings.customThemes || (settings.customThemes = []);
    var replaced = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === theme.id) {
        list[i] = theme;
        replaced = true;
        break;
      }
    }
    if (!replaced) list.push(theme);
    settings.theme = theme.id;
    S.save();
    fillThemeSelects();
    renderCustomThemes();
    applyThemeId(theme.id, false);
    setText('theme-status', (replaced ? 'Updated · ' : 'Imported · ') + theme.name);
    toast('Theme "' + theme.name + '" ' + (replaced ? 'updated' : 'added') + '.', 'good');
    if (theme.warnings && theme.warnings.length) {
      console.warn('[theme import]', theme.warnings.join(' '));
      toast(theme.warnings[0], 'bad');
    }
  }

  function importThemeFiles(files) {
    if (!window.SDThemeImport) {
      importFailed(new Error('The theme importer did not load.'));
      return;
    }
    if (!files || !files.length) return;
    setText('theme-status', 'Reading theme…');
    window.SDThemeImport.fromFiles(files, importOptions()).then(installImportedTheme, importFailed);
  }

  function importThemeArchive(file) {
    if (!window.SDThemeImport) {
      importFailed(new Error('The theme importer did not load.'));
      return;
    }
    if (!file) return;
    setText('theme-status', 'Reading theme…');
    file
      .arrayBuffer()
      .then(function (buffer) {
        return window.SDThemeImport.fromSdt(buffer, importOptions());
      })
      .then(installImportedTheme, importFailed);
  }

  function renderCustomThemes() {
    var host = $('custom-themes');
    if (!host) return;
    host.textContent = '';
    var list = settings.customThemes || [];
    var empty = $('custom-empty');
    if (empty) empty.hidden = list.length > 0;
    list.forEach(function (theme) {
      var row = document.createElement('div');
      row.className = 'custom-theme';

      var swatch = document.createElement('span');
      swatch.className = 'ct-swatch';
      swatch.style.background = (theme.vars && theme.vars['--accent']) || '#777';

      var name = document.createElement('button');
      name.type = 'button';
      name.className = 'ct-name';
      name.textContent = theme.name;
      name.title = 'Apply this skin';
      name.addEventListener('click', function () {
        settings.theme = theme.id;
        S.save();
        fillThemeSelects();
        renderCustomThemes();
        applyThemeId(theme.id, false);
      });

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-btn';
      remove.textContent = '×';
      remove.title = 'Delete this skin';
      remove.addEventListener('click', function () {
        deleteCustomTheme(theme.id);
      });

      if (theme.source === 'imported') {
        name.title = 'Imported CSS theme';
        row.append(swatch, name, remove);
      } else {
        var edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'icon-btn';
        edit.textContent = 'edit';
        edit.addEventListener('click', function () {
          loadThemeIntoEditor(theme);
        });
        row.append(swatch, name, edit, remove);
      }
      host.appendChild(row);
    });
  }

  function showThemeCss() {
    var draft = readDraft();
    $('theme-css').value = Themes.themeFile({
      id: editingThemeId || Themes.slug(draft.name),
      name: draft.name,
      vars: Themes.buildVars(draft),
    });
  }

  function copyThemeCss() {
    var textarea = $('theme-css');
    if (!textarea.value) showThemeCss();
    textarea.select();
    function done() {
      toast('Theme CSS copied — save it in its own folder under themes/ and add it to themes/manifest.js.', 'good');
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(textarea.value).then(done, function () {
          try {
            document.execCommand('copy');
            done();
          } catch (e) {
            toast('Select the box and copy it manually.', 'bad');
          }
        });
      } else {
        document.execCommand('copy');
        done();
      }
    } catch (e) {
      toast('Select the box and copy it manually.', 'bad');
    }
  }

  // ── library import ────────────────────────────────────────
  function cleanName(name) {
    var base = String(name || '')
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    base = base.replace(/^\d{1,2}\s*[-.)]\s*/, '');
    return base || String(name || 'Untitled');
  }

  // Fill only blank fields from the file's tags, so a later re-import cannot
  // overwrite a title or credit the user edited by hand.
  function applyTags(track, tags) {
    if (!track || !tags) return false;
    track = S.getTrack(track.id);
    if (!track) return false;
    var changed = false;
    var fallback = cleanName(track.name);
    if (tags.title && (!track.title || track.title === fallback)) {
      track.title = tags.title;
      changed = true;
    }
    ['artist', 'album', 'genre', 'year'].forEach(function (key) {
      if (tags[key] && !track[key]) {
        track[key] = tags[key];
        changed = true;
      }
    });
    if (tags.track && !track.trackNo) {
      track.trackNo = tags.track;
      changed = true;
    }
    var firstRead = !track.tagged;
    track.tagged = true;
    return changed || firstRead;
  }

  // The same song often arrives twice — a rip from one place, the album copy
  // from another. Matching tags keep that to one row in the library.
  function songIdentity(track) {
    function norm(value) {
      return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    }
    var title = norm(track.title || cleanName(track.name));
    var artist = norm(track.artist);
    if (!title || !artist) return '';
    return title + '\u0000' + artist;
  }

  function sameSong(a, b) {
    if (!a || !b || a.id === b.id) return false;
    var key = songIdentity(a);
    if (!key || key !== songIdentity(b)) return false;
    var albumA = String(a.album || '').trim().toLowerCase();
    var albumB = String(b.album || '').trim().toLowerCase();
    if (albumA && albumB && albumA !== albumB) return false;
    if (a.duration > 0 && b.duration > 0 && Math.abs(a.duration - b.duration) > 3) return false;
    return true;
  }

  // Fold a freshly imported file into the row that is already in the library,
  // so plays, liner notes and analysis survive the swap.
  function foldImportInto(track, file) {
    var locals = localTracks();
    for (var i = 0; i < locals.length; i++) {
      var keep = locals[i];
      if (!sameSong(track, keep)) continue;

      S.putBlob(keep.id, file);
      P.invalidate(keep.id);
      keep.missing = false;
      keep.size = track.size;
      keep.lastModified = track.lastModified;
      keep.name = track.name;
      if (!keep.duration && track.duration) keep.duration = track.duration;
      if (!keep.title) keep.title = track.title;
      if (!keep.artist) keep.artist = track.artist;
      if (!keep.album && track.album) keep.album = track.album;

      queue = queue.filter(function (item) {
        return item.id !== track.id;
      });
      if (current && current.id === track.id) current = keep;

      S.removeTrack(track.id);
      return keep;
    }
    return null;
  }

  // ── folder browser ────────────────────────────────────────
  // The platform folder chooser hands back whichever folder is highlighted,
  // not the one being browsed, so the desktop build browses folders in-app and
  // only asks the shell for listings and file bytes.
  var Native = (function () {
    var tauri = window.__TAURI__ && window.__TAURI__.core;
    if (tauri && typeof tauri.invoke === 'function') {
      return {
        start: function () {
          return tauri.invoke('default_music_dir');
        },
        browse: function (dir) {
          return tauri.invoke('browse_dir', { path: dir });
        },
        scan: function (dir) {
          return tauri.invoke('scan_audio', { path: dir });
        },
        read: function (file) {
          return tauri.invoke('read_audio', { path: file });
        },
      };
    }
    return window.SlamdanceNative || null;
  })();

  var folder = { path: '', view: null, busy: false };

  function folderOpen() {
    var modal = $('folder-modal');
    return !!modal && !modal.hidden;
  }

  function joinPath(base, name) {
    var sep = base.indexOf('\\') !== -1 ? '\\' : '/';
    return base.replace(/[\\/]+$/, '') + sep + name;
  }

  function folderBusy(isBusy) {
    folder.busy = isBusy;
    var add = $('folder-add');
    var up = $('folder-up');
    if (add) add.disabled = isBusy;
    if (up) up.disabled = isBusy || !folder.view || !folder.view.parent;
  }

  function renderFolder(view) {
    folder.view = view;
    folder.path = view.path;
    setText('folder-path', view.path);

    var list = $('folder-list');
    if (list) {
      list.innerHTML = '';
      if (!view.dirs.length) {
        var empty = document.createElement('p');
        empty.className = 'folder-empty';
        empty.textContent = 'No subfolders here.';
        list.appendChild(empty);
      }
      view.dirs.forEach(function (name) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'folder-row';
        row.dataset.dir = name;
        var icon = document.createElement('span');
        icon.className = 'folder-ico';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = '▸';
        row.appendChild(icon);
        row.appendChild(document.createTextNode(name));
        row.addEventListener('click', function () {
          loadFolder(joinPath(view.path, name));
        });
        list.appendChild(row);
      });
      list.scrollTop = 0;
    }

    setText(
      'folder-note',
      view.audio
        ? view.audio +
            ' audio file' +
            (view.audio === 1 ? '' : 's') +
            ' in this folder. Subfolders are included when you add it.'
        : 'No audio files directly in this folder. Subfolders are still included when you add it.'
    );

    folderBusy(false);
    var add = $('folder-add');
    if (add) add.focus();
  }

  function loadFolder(target, retried) {
    if (!Native) return;
    folderBusy(true);
    var request = target
      ? Native.browse(target)
      : Promise.resolve(Native.start()).then(function (dir) {
          return Native.browse(dir);
        });
    request
      .then(function (view) {
        renderFolder(view);
        try {
          localStorage.setItem('slamdance.folder', view.path);
        } catch (err) {
          /* private mode: remembering the folder is optional */
        }
      })
      .catch(function (err) {
        // A remembered folder may have been renamed; fall back to Music once.
        if (!retried) {
          loadFolder(null, true);
          return;
        }
        folderBusy(false);
        toast('Could not open that folder: ' + (err && err.message ? err.message : err), 'bad');
        closeFolder();
      });
  }

  function openFolderBrowser() {
    if (!Native) {
      $('folder-input').click();
      return;
    }
    var modal = $('folder-modal');
    if (!modal) return;
    modal.hidden = false;
    var remembered = '';
    try {
      remembered = localStorage.getItem('slamdance.folder') || '';
    } catch (err) {
      remembered = '';
    }
    loadFolder(remembered || null);
  }

  function closeFolder() {
    var modal = $('folder-modal');
    if (modal) modal.hidden = true;
    folder.view = null;
    folder.busy = false;
  }

  function mimeForName(name) {
    var match = /\.([a-z0-9]+)$/i.exec(name || '');
    var ext = match ? match[1].toLowerCase() : '';
    var types = {
      mp3: 'audio/mpeg',
      ogg: 'audio/ogg',
      oga: 'audio/ogg',
      opus: 'audio/ogg',
      flac: 'audio/flac',
      wav: 'audio/wav',
      m4a: 'audio/mp4',
      mp4: 'audio/mp4',
      aac: 'audio/aac',
      webm: 'audio/webm',
    };
    return types[ext] || 'audio/mpeg';
  }

  function addCurrentFolder() {
    if (!Native || folder.busy || !folder.path) return;
    var target = folder.path;
    closeFolder();
    toast('Reading ' + target + '…');
    Native.scan(target)
      .then(function (entries) {
        if (!entries || !entries.length) {
          toast('No audio files in that folder.', 'bad');
          return;
        }
        importFolderEntries(entries);
      })
      .catch(function (err) {
        toast('Could not read that folder: ' + (err && err.message ? err.message : err), 'bad');
      });
  }

  // Read in small batches so a big folder never holds every byte at once.
  function importFolderEntries(entries) {
    var BATCH = 8;
    var at = 0;
    var imported = 0;
    var failed = 0;

    function step() {
      if (at >= entries.length) {
        toast(
          'Folder added: ' +
            imported +
            ' track' +
            (imported === 1 ? '' : 's') +
            (failed ? ' (' + failed + ' unreadable)' : '') +
            '.',
          imported ? 'good' : 'bad'
        );
        return;
      }
      var slice = entries.slice(at, at + BATCH);
      at += slice.length;
      Promise.all(
        slice.map(function (entry) {
          return Native.read(entry.path)
            .then(function (bytes) {
              var data = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes || []);
              return new File([data], entry.name, {
                type: mimeForName(entry.name),
                lastModified: entry.modified || Date.now(),
              });
            })
            .catch(function (err) {
              failed += 1;
              console.warn('[folder]', entry.path, err);
              return null;
            });
        })
      ).then(function (files) {
        var ready = files.filter(Boolean);
        imported += ready.length;
        if (ready.length) addFiles(ready, { quiet: true });
        setTimeout(step, 0);
      });
    }

    step();
  }

  function addFiles(fileList, options) {
    var quiet = !!(options && options.quiet);
    var files = Array.prototype.slice.call(fileList || []).filter(function (file) {
      if (!file) return false;
      if (file.type && file.type.indexOf('audio') === 0) return true;
      return /\.(mp3|ogg|oga|flac|wav|m4a|aac|opus|webm|mp4)$/i.test(file.name || '');
    });
    if (!files.length) {
      if (!quiet) toast('No audio files in that drop.', 'bad');
      return;
    }

    var touched = [];
    var imported = [];
    files.forEach(function (file) {
      var id = S.localId(file);
      var existing = S.getTrack(id);
      S.putBlob(id, file);
      if (existing) {
        existing.missing = false;
        touched.push(existing);
        imported.push({ file: file, track: existing });
        return;
      }
      var track = {
        id: id,
        stream: false,
        url: '',
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        title: cleanName(file.name),
        artist: '',
        album: '',
        genre: '',
        year: '',
        trackNo: '',
        tagged: false,
        scene: '',
        label: '',
        era: '',
        notes: '',
        bandcamp: '',
        duration: 0,
        bpm: null,
        confidence: 0,
        rmsDb: null,
        intensity: null,
        analyzed: false,
        plays: 0,
        addedAt: Date.now(),
      };
      S.upsertTrack(track);
      touched.push(track);
      imported.push({ file: file, track: track });
    });

    S.save();
    if (!queue.length) {
      setQueue(computeFiltered(), -1);
    } else {
      // Adding files to a library that already has a Setlist should extend the
      // Setlist immediately; the old empty-only branch held them until restart.
      var queued = {};
      queue.forEach(function (track) {
        queued[track.id] = true;
      });
      var additions = [];
      touched.forEach(function (track) {
        var stored = S.getTrack(track.id);
        if (stored && !queued[stored.id]) {
          queued[stored.id] = true;
          additions.push(stored);
        }
      });
      if (additions.length) {
        var currentAt = -1;
        if (current) {
          for (var i = 0; i < queue.length; i++) {
            if (queue[i].id === current.id) {
              currentAt = i;
              break;
            }
          }
        }
        setQueue(queue.concat(additions), currentAt);
      }
    }
    renderAll();
    if (!quiet) toast(touched.length + ' track' + (touched.length === 1 ? '' : 's') + ' added.', 'good');

    if (Metadata && imported.length) {
      Promise.all(
        imported.map(function (item) {
          return Metadata.read(item.file)
            .then(function (tags) {
              return applyTags(item.track, tags);
            })
            .catch(function (err) {
              console.warn('[tags]', item.file && item.file.name, err);
              return false;
            });
        })
      ).then(function (changed) {
        var folded = 0;
        imported.forEach(function (item) {
          var stored = S.getTrack(item.track.id);
          if (!stored) return;
          if (foldImportInto(stored, item.file)) folded += 1;
        });
        if (!changed.some(Boolean) && !folded) return;
        S.save();
        renderAll();
        renderArc();
        if (folded && !quiet) {
          toast(
            'Merged ' + folded + ' duplicate' + (folded === 1 ? '' : 's') + ' — same song, one row.',
            'good'
          );
        }
      });
    }

    analyzePending(function (track) {
      return !track.analyzed;
    });
  }

  function analyzePending(filterFn) {
    if (analyzing) {
      if (filterFn) toast('Already reading the library — one at a time.');
      return;
    }
    var pending = localTracks().filter(filterFn || function (track) {
      return !track.analyzed;
    });
    if (!pending.length) {
      setText('lib-status', '');
      toast('Nothing left to analyze.');
      return;
    }

    analyzing = true;
    var total = pending.length;
    var index = 0;

    function finish() {
      analyzing = false;
      setText('lib-status', '');
      renderAll();
      toast('Analyzed ' + total + ' track' + (total === 1 ? '' : 's') + '.', 'good');
    }

    function step() {
      if (index >= pending.length) {
        finish();
        return;
      }
      var track = pending[index];
      setText('lib-status', 'Analyzing ' + (index + 1) + '/' + total + ' — ' + (track.title || track.name));

      S.getBlob(track.id)
        .then(function (blob) {
          if (!blob) {
            var err = new Error('Missing file');
            err.code = 'relink';
            throw err;
          }
          return A.analyzeFile(blob);
        })
        .then(function (result) {
          track.duration = result.duration || track.duration;
          track.bpm = result.bpm;
          track.confidence = result.confidence;
          track.rmsDb = result.rmsDb;
          track.intensity = result.intensity;
          track.analyzed = true;
          S.save();
          renderLibrary();
          renderPitPanel();
          if (current && current.id === track.id) renderNowPlaying();
        })
        .catch(function (err) {
          console.warn('[analysis]', track && track.name, err);
          if (err && err.code === 'relink') track.missing = true;
          track.analyzed = false;
          renderLibrary();
        })
        .then(function () {
          index++;
          setTimeout(step, 40);
        });
    }

    step();
  }

  // Existing libraries predate the tag reader. Read their stored blobs once so
  // imported MP3s fill in without asking the user to add every file again.
  function backfillTags() {
    if (!Metadata) return;
    var pending = localTracks().filter(function (track) {
      return !track.tagged;
    });
    if (!pending.length) return;

    Promise.all(
      pending.map(function (track) {
        return S.getBlob(track.id)
          .then(function (blob) {
            if (!blob) return false;
            return Metadata.read(blob).then(function (tags) {
              return applyTags(track, tags);
            });
          })
          .catch(function (err) {
            console.warn('[tags]', track.name, err);
            return false;
          });
      })
    ).then(function (changed) {
      if (!changed.some(Boolean)) return;
      S.save();
      renderAll();
      renderArc();
    });
  }

  function checkMissingBlobs() {
    var locals = localTracks();
    var changed = false;
    var index = 0;

    function step() {
      if (index >= locals.length) {
        if (changed) renderLibrary();
        return;
      }
      var track = locals[index++];
      S.hasBlob(track.id).then(function (has) {
        if (track.missing !== !has) {
          track.missing = !has;
          changed = true;
        }
        step();
      });
    }
    step();

    S.probe().then(function (ok) {
      setText(
        'storage-note',
        ok
          ? 'Audio is kept in local browser storage. No account, no upload.'
          : 'Browser storage is unavailable here — files work this session, then need re-linking.'
      );
    });
  }

  function removeFromQueue(track) {
    var at = -1;
    for (var i = 0; i < queue.length; i++) {
      if (queue[i].id === track.id) {
        at = i;
        break;
      }
    }
    if (at === -1) return;

    var wasCurrent = !!current && current.id === track.id;
    queue.splice(at, 1);
    var currentAt = -1;
    if (current) {
      for (var j = 0; j < queue.length; j++) {
        if (queue[j].id === current.id) {
          currentAt = j;
          break;
        }
      }
    }
    P.setQueue(queue, currentAt);
    renderQueue();
    toast(
      wasCurrent
        ? 'Removed "' +
            (track.title || track.name) +
            '" from the setlist. It keeps playing until you stop it.'
        : 'Removed "' + (track.title || track.name) + '" from the setlist.'
    );
  }

  function removeTrack(track, quiet) {
    S.removeTrack(track.id);
    P.invalidate(track.id);
    queue = queue.filter(function (item) {
      return item.id !== track.id;
    });
    arcTracks = arcTracks.filter(function (item) {
      return item.id !== track.id;
    });
    var at = -1;
    if (current) {
      for (var i = 0; i < queue.length; i++) {
        if (queue[i].id === current.id) at = i;
      }
    }
    if (current && current.id === track.id) {
      P.stop();
      current = null;
      setQueue(queue, -1);
    } else {
      P.setQueue(queue, at);
    }
    S.save();
    renderAll();
    renderArc();
    if (!quiet) {
      toast('Removed "' + (track.title || track.name) + '". The file on disk is untouched.');
    }
  }

  function deleteStream(card) {
    var track = S.getTrack(card.id);
    if (!track) return;

    var name = track.name || track.title || 'Station';
    if (radio.streamId === track.id) {
      radio.on = false;
      radio.scope = 'all';
      radio.scene = null;
      radio.streamId = null;
      radio.recent = [];
      P.stop();
    }

    removeTrack(track, true);
    renderRadioPanelState();
    toast('Removed station "' + name + '". No local files were touched.');
  }

  var clearArmedAt = 0;

  function clearLibrary() {
    if (!localTracks().length) {
      toast('The library is already empty.');
      return;
    }
    var button = $('clear-lib-btn');
    var now = Date.now();
    // window.confirm() blocks the GTK web view and left the window frozen, so
    // the second click is the confirmation instead.
    if (now - clearArmedAt > 4000) {
      clearArmedAt = now;
      if (button) button.textContent = 'Click again to clear';
      toast('Click Clear library again to remove every local track. Files on disk are not touched.', 'bad');
      setTimeout(function () {
        if (Date.now() - clearArmedAt >= 4000) {
          clearArmedAt = 0;
          if (button) button.textContent = 'Clear library';
        }
      }, 4200);
      return;
    }
    clearArmedAt = 0;
    if (button) button.textContent = 'Clear library';
    // Stop before the blobs go away: revoking a source the player still holds
    // is what wedged the old media-element pipeline.
    P.stop();
    P.invalidateAll();
    S.clearLibrary();
    current = null;
    arcTracks = [];
    setQueue([], -1);
    renderAll();
    renderArc();
    toast('Library cleared.');
  }

  // ── playback ──────────────────────────────────────────────
  function setQueue(tracks, startIndex) {
    queue = (tracks || []).slice();
    P.setQueue(queue, typeof startIndex === 'number' ? startIndex : -1);
    renderQueue();
  }

  function playFromList(track, list) {
    var source = list && list.length ? list.slice() : [track];
    var index = source.indexOf(track);
    if (index === -1) {
      source = [track];
      index = 0;
    }
    setQueue(source, index);
    P.playTrack(track, { crossfade: 0 }).catch(function () {});
    setMoshActive(true);
  }

  function togglePlay() {
    if (!current) {
      var list = computeFiltered();
      if (!list.length) {
        toast('Add audio first — drag files in or use Add files.', 'bad');
        return;
      }
      playFromList(list[0], list);
      return;
    }
    P.toggle();
  }

  function toggleShuffle() {
    settings.shuffle = !settings.shuffle;
    var button = $('shuffle-btn');
    button.classList.toggle('is-on', settings.shuffle);
    button.setAttribute('aria-pressed', String(settings.shuffle));
    S.save();
    if (settings.shuffle) {
      var rest = queue.filter(function (track) {
        return !current || track.id !== current.id;
      });
      for (var i = rest.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var swap = rest[i];
        rest[i] = rest[j];
        rest[j] = swap;
      }
      queue = (current ? [current] : []).concat(rest);
      P.setQueue(queue, 0);
      renderQueue();
      toast('Shuffle on.');
    } else {
      setQueue(computeFiltered(), -1);
      toast('Shuffle off.');
    }
  }

  function setMoshActive(active) {
    if (window.SDMosh) window.SDMosh.setActive(active);
  }

  function setMosh(next) {
    moshOn = !!next;
    document.body.classList.toggle('mosh', moshOn);
    var button = $('mosh-toggle');
    button.classList.toggle('is-on', moshOn);
    button.textContent = moshOn ? 'EXIT PIT' : 'MOSH MODE';
    $('mosh-hud').setAttribute('aria-hidden', moshOn ? 'false' : 'true');
    setMoshActive(P.isPlaying() || moshOn);
  }

  function moshSignal() {
    var bpm = current && current.bpm ? current.bpm : 0;
    if (!P.isPlaying()) return { level: 0, spectrum: null, bpm: bpm, intensity: 0 };
    if (P.isStream()) {
      var t = Date.now() / 1000;
      return {
        level: 0.42 + 0.12 * Math.sin(t * 2.1) + 0.06 * Math.sin(t * 5.7),
        spectrum: null,
        bpm: bpm || 128,
        intensity: 52 + 18 * Math.sin(t * 1.6),
      };
    }
    return {
      level: P.getLevel01(),
      spectrum: P.getSpectrum(),
      bpm: bpm,
      intensity: A.liveScore(bpm || 100, P.getDb()),
    };
  }

  function tick() {
    var live = current && P.isPlaying() ? A.liveScore(current.bpm || 100, P.getDb()) : 0;
    setWidth('live-meter-fill', live);
    setWidth('pit-mini-fill', live);
    setWidth('hud-meter-fill', live);
    setText('live-meter-value', live ? live + ' / 100' : P.isPlaying() ? 'live' : 'idle');
    setText('hud-intensity', 'pit meter ' + live);
    setText('hud-bpm', current && current.bpm ? Math.round(current.bpm) + ' bpm' : '— bpm');
    setText('hud-track', current ? current.title || current.name : '—');
  }

  // ── filtering ─────────────────────────────────────────────
  function computeFiltered() {
    var search = (filters.search || '').trim().toLowerCase();
    var list = localTracks().filter(function (track) {
      if (filters.scene && (track.scene || '') !== filters.scene) return false;
      if (filters.heat !== 'all') {
        if (typeof track.intensity !== 'number') return false;
        if (Arc.band(track.intensity).key !== filters.heat) return false;
      }
      if (search) {
        var haystack = [
          track.title,
          track.artist,
          track.album,
          track.genre,
          track.year,
          track.scene,
          track.label,
          track.era,
          track.name,
          track.notes,
        ]
          .join(' ')
          .toLowerCase();
        if (haystack.indexOf(search) === -1) return false;
      }
      return true;
    });
    list.sort(comparator(filters.sort));
    return list;
  }

  function comparator(sort) {
    return function (a, b) {
      switch (sort) {
        case 'title':
          return (a.title || '').localeCompare(b.title || '');
        case 'artist':
          return (
            (a.artist || '').localeCompare(b.artist || '') ||
            (a.title || '').localeCompare(b.title || '')
          );
        case 'intensity-desc':
          return scoreOr(b, -1) - scoreOr(a, -1);
        case 'intensity-asc':
          return scoreOr(a, -1) - scoreOr(b, -1);
        case 'bpm-desc':
          return (typeof b.bpm === 'number' ? b.bpm : 0) - (typeof a.bpm === 'number' ? a.bpm : 0);
        case 'plays':
          return (b.plays || 0) - (a.plays || 0);
        default:
          return (b.addedAt || 0) - (a.addedAt || 0);
      }
    };
  }

  // ── rendering ─────────────────────────────────────────────
  function renderAll() {
    renderLibrary();
    renderNowPlaying();
    renderQueue();
    renderPitPanel();
    renderStations();
    renderRadioPanelState();
    updateDocTitle();
  }

  function renderLibrary() {
    libraryView = computeFiltered();
    var body = $('lib-body');
    body.textContent = '';
    var fragment = document.createDocumentFragment();
    libraryView.forEach(function (track) {
      fragment.appendChild(libraryRow(track));
    });
    body.appendChild(fragment);

    setText('lib-count', localTracks().length);
    var empty = $('lib-empty');
    empty.hidden = libraryView.length > 0;
    empty.textContent = localTracks().length
      ? 'Nothing matches that filter.'
      : 'Empty pit. Add local files — they stay on your machine.';

    if (!analyzing) {
      var total = localTracks().length;
      setText('lib-status', libraryView.length === total ? '' : 'Showing ' + libraryView.length + ' of ' + total);
    }
    renderScenes();
  }

  function actionButton(act, label, title) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-btn';
    button.setAttribute('data-act', act);
    button.textContent = label;
    button.title = title;
    return button;
  }

  function libraryRow(track) {
    var tr = document.createElement('tr');
    tr.setAttribute('data-id', track.id);
    if (current && current.id === track.id) tr.classList.add('is-playing');
    if (track.missing) tr.classList.add('is-missing');

    var playCell = document.createElement('td');
    var play = document.createElement('button');
    play.type = 'button';
    play.className = 'row-play';
    play.setAttribute('data-act', 'play');
    play.textContent = current && current.id === track.id && P.isPlaying() ? '❚❚' : '▶';
    play.title = track.missing ? 'File not stored — click to re-link' : 'Play';
    playCell.appendChild(play);

    var titleCell = document.createElement('td');
    var title = document.createElement('span');
    title.className = 'lib-title';
    title.textContent = track.title || track.name;
    var sub = document.createElement('span');
    sub.className = 'lib-sub';
    sub.textContent = [extOf(track.name), fmtSize(track.size), track.missing ? 'needs re-link' : '']
      .filter(Boolean)
      .join(' · ');
    titleCell.append(title, sub);

    var artistCell = document.createElement('td');
    artistCell.textContent = track.artist || '—';

    var albumCell = document.createElement('td');
    var albumName = document.createElement('span');
    albumName.className = 'lib-album';
    albumName.textContent = track.album || '—';
    albumCell.appendChild(albumName);
    var extra = [track.genre, track.year].filter(Boolean).join(' · ');
    if (extra) {
      var albumSub = document.createElement('span');
      albumSub.className = 'lib-sub';
      albumSub.textContent = extra;
      albumCell.appendChild(albumSub);
    }

    var sceneCell = document.createElement('td');
    var scene = document.createElement('span');
    scene.className = 'chip chip-static';
    scene.textContent = track.scene || '—';
    sceneCell.appendChild(scene);

    var bpmCell = document.createElement('td');
    bpmCell.textContent = track.bpm ? String(Math.round(track.bpm)) : '—';
    if (track.bpm) bpmCell.title = 'Estimated from the audio; edit it in Liner Notes.';

    var pitCell = document.createElement('td');
    var pit = document.createElement('div');
    pit.className = 'pit-cell';
    var bar = document.createElement('div');
    bar.className = 'pit-bar';
    var fill = document.createElement('span');
    var score = typeof track.intensity === 'number' ? track.intensity : 0;
    fill.style.width = score + '%';
    if (track.intensity == null) fill.style.background = 'var(--line-strong)';
    bar.appendChild(fill);
    var number = document.createElement('span');
    number.className = 'pit-num';
    number.textContent = track.intensity == null ? '—' : String(track.intensity);
    pit.append(bar, number);
    pitCell.appendChild(pit);

    var timeCell = document.createElement('td');
    timeCell.className = 'col-time';
    timeCell.textContent = track.duration ? fmtTime(track.duration) : '—';

    var actions = document.createElement('td');
    actions.className = 'col-act';
    var rowActions = document.createElement('div');
    rowActions.className = 'row-actions';
    rowActions.append(
      actionButton('buy', 'Buy', 'Open Bandcamp'),
      actionButton('notes', 'Notes', 'Liner notes'),
      actionButton('remove', '×', 'Remove from library')
    );
    actions.appendChild(rowActions);

    tr.append(playCell, titleCell, artistCell, albumCell, sceneCell, bpmCell, pitCell, timeCell, actions);
    return tr;
  }

  function sceneCounts() {
    var counts = {};
    localTracks().forEach(function (track) {
      var scene = (track.scene || '').trim();
      if (scene) counts[scene] = (counts[scene] || 0) + 1;
    });
    return counts;
  }

  function renderScenes() {
    var counts = sceneCounts();
    var names = Object.keys(counts).sort(function (a, b) {
      return a.localeCompare(b);
    });

    var wrap = $('lib-scenes');
    wrap.textContent = '';
    var all = document.createElement('button');
    all.type = 'button';
    all.className = 'chip' + (filters.scene ? '' : ' is-active');
    all.textContent = 'All scenes';
    all.addEventListener('click', function () {
      filters.scene = null;
      renderLibrary();
    });
    wrap.appendChild(all);

    names.forEach(function (scene) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip' + (filters.scene === scene ? ' is-active' : '');
      chip.textContent = scene + ' · ' + counts[scene];
      chip.addEventListener('click', function () {
        filters.scene = filters.scene === scene ? null : scene;
        renderLibrary();
      });
      wrap.appendChild(chip);
    });

    var datalist = $('scene-list');
    datalist.textContent = '';
    names.forEach(function (scene) {
      var option = document.createElement('option');
      option.value = scene;
      datalist.appendChild(option);
    });

    var arcScene = $('arc-scene');
    var previous = arcScene.value;
    arcScene.textContent = '';
    names.forEach(function (scene) {
      var option = document.createElement('option');
      option.value = scene;
      option.textContent = scene;
      arcScene.appendChild(option);
    });
    if (previous) arcScene.value = previous;
  }

  function renderNowPlaying() {
    var track = current;
    setHeroTitle(track ? track.title || track.name : idleTitle);
    setText(
      'np-artist',
      track
        ? track.artist || (track.stream ? 'Internet radio' : 'Unknown artist')
        : 'Local files. No account. No tracking.'
    );
    setText('tp-title', track ? track.title || track.name : '—');
    setText(
      'tp-artist',
      track
        ? [track.artist, track.scene].filter(Boolean).join(' · ') || 'Slamdance Audio'
        : 'Slamdance Audio · offline first'
    );
    setText('np-scene', track && track.scene ? track.scene : 'no scene tagged');
    setText('np-bpm', track && track.bpm ? Math.round(track.bpm) + ' bpm est.' : 'bpm —');
    setText(
      'np-duration',
      track && track.stream ? 'LIVE' : track && track.duration ? fmtTime(track.duration) : '—:—'
    );

    var score = track && typeof track.intensity === 'number' ? track.intensity : 0;
    setWidth('np-intensity-fill', score);
    setText(
      'np-intensity-label',
      track && typeof track.intensity === 'number'
        ? score + ' · ' + Arc.band(score).label
        : track && track.stream
          ? 'live feed'
          : '—'
    );

    setText('np-state', P.isPlaying() ? 'Now spinning' : track ? 'Ready' : 'Nothing spinning');
    setText('np-play', P.isPlaying() ? 'Pause the pit' : 'Play the pit');
    $('np-buy').disabled = !track;
    $('np-notes').disabled = !track;
    $('live-badge').hidden = !(track && track.stream);
    $('seek').disabled = !!(track && track.stream);
    setText(
      'time-total',
      track && track.stream ? 'LIVE' : track && track.duration ? fmtTime(track.duration) : '0:00'
    );
  }

  function renderQueue() {
    var host = $('queue-list');
    if (!host) return;
    host.textContent = '';
    setText('queue-count', queue.length);
    $('queue-empty').hidden = queue.length > 0;
    queue.forEach(function (track, index) {
      var li = document.createElement('li');
      li.className = 'queue-item' + (current && current.id === track.id ? ' is-current' : '');
      li.setAttribute('data-id', track.id);

      var number = document.createElement('span');
      number.className = 'q-index';
      number.textContent = String(index + 1).padStart(2, '0');

      var title = document.createElement('span');
      title.className = 'q-title';
      title.textContent = track.title || track.name;

      var artist = document.createElement('span');
      artist.className = 'q-artist';
      artist.textContent = track.artist || '';

      var band = document.createElement('span');
      band.className = 'q-band';
      band.textContent = track.stream
        ? 'live'
        : typeof track.intensity === 'number'
          ? Arc.band(track.intensity).label
          : '—';

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-btn q-remove';
      remove.textContent = '×';
      remove.title = 'Remove from setlist';
      remove.setAttribute('aria-label', 'Remove ' + (track.title || track.name) + ' from setlist');
      remove.addEventListener('click', function (event) {
        event.stopPropagation();
        removeFromQueue(track);
      });

      li.append(number, title, artist, band, remove);
      li.addEventListener('click', function () {
        playFromList(track, queue);
      });
      host.appendChild(li);
    });
  }

  function renderPitPanel() {
    var list = localTracks().filter(function (track) {
      return typeof track.intensity === 'number';
    });
    list.sort(function (a, b) {
      return b.intensity - a.intensity;
    });

    var host = $('pit-list');
    host.textContent = '';
    $('pit-empty').hidden = list.length > 0;

    list.forEach(function (track, index) {
      var band = Arc.band(track.intensity);
      var li = document.createElement('li');
      li.className = 'pit-row';

      var rank = document.createElement('span');
      rank.className = 'pit-rank';
      rank.textContent = String(index + 1);

      var name = document.createElement('span');
      name.className = 'pit-track';
      name.textContent = track.title || track.name;
      var small = document.createElement('small');
      small.textContent = track.artist || 'unknown artist';
      name.appendChild(small);

      var meta = document.createElement('span');
      meta.className = 'pit-meta';
      meta.textContent = [
        track.bpm ? Math.round(track.bpm) + ' bpm' : 'no bpm',
        band.label,
      ].join(' · ');

      var cell = document.createElement('div');
      cell.className = 'pit-cell';
      var bar = document.createElement('div');
      bar.className = 'pit-bar';
      var fill = document.createElement('span');
      fill.style.width = track.intensity + '%';
      bar.appendChild(fill);
      cell.appendChild(bar);

      var score = document.createElement('span');
      score.className = 'pit-score';
      score.textContent = String(track.intensity);

      li.append(rank, name, meta, cell, score);
      li.addEventListener('click', function () {
        playFromList(track, list);
      });
      host.appendChild(li);
    });
  }

  function stationButton(card) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'station';

    var name = document.createElement('span');
    name.className = 's-name';
    name.textContent = card.name;

    var meta = document.createElement('span');
    meta.className = 's-meta';
    meta.textContent = card.meta;

    var isOn =
      radio.on &&
      radio.scope === card.scope &&
      (card.scope !== 'scene' || radio.scene === card.scene) &&
      (card.scope !== 'stream' || radio.streamId === card.id);
    button.setAttribute('aria-pressed', isOn ? 'true' : 'false');
    if (isOn) button.style.borderColor = 'var(--accent)';

    button.append(name, meta);
    button.addEventListener('click', function () {
      tuneStation(card);
    });
    return button;
  }

  function renderStationList(host, cards, emptyText, allowDelete) {
    if (!host) return;
    host.textContent = '';
    if (!cards.length) {
      var empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = emptyText;
      host.appendChild(empty);
      return;
    }
    cards.forEach(function (card) {
      if (!allowDelete) {
        host.appendChild(stationButton(card));
        return;
      }

      var row = document.createElement('div');
      row.className = 'station-row';
      row.appendChild(stationButton(card));

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-btn station-delete';
      remove.textContent = '×';
      remove.title = 'Delete this station';
      remove.setAttribute('aria-label', 'Delete station ' + card.name);
      remove.addEventListener('click', function (event) {
        event.stopPropagation();
        deleteStream(card);
      });
      row.appendChild(remove);
      host.appendChild(row);
    });
  }

  function renderStations() {
    var counts = sceneCounts();
    var cards = [{ scope: 'all', name: 'Everything', meta: localTracks().length + ' local tracks' }];

    Object.keys(counts)
      .sort()
      .forEach(function (scene) {
        if (scene === 'Internet Radio') return;
        cards.push({ scope: 'scene', scene: scene, name: scene, meta: counts[scene] + ' tracks tagged' });
      });

    renderStationList($('local-stations'), cards, 'No local stations yet — add files or tag a scene.');

    var streams = streamTracks().map(function (track) {
      return {
        scope: 'stream',
        id: track.id,
        name: track.name || track.title,
        meta: 'Internet stream',
      };
    });
    renderStationList($('stream-list'), streams, 'No streams saved yet — paste a direct URL above.', true);
  }

  function renderRadioPanelState() {
    var localOn = radio.on && radio.scope !== 'stream';
    var streamOn = radio.on && radio.scope === 'stream';
    var label = radio.scope === 'scene' ? radio.scene : 'Everything';
    var streamName = radio.streamId ? (S.getTrack(radio.streamId) || {}).name || 'stream' : '';

    setText('radio-status', localOn ? 'on air' : 'off air');
    setText(
      'radio-now',
      localOn ? 'On air · ' + (settings.stationName || 'Slamdance Radio') + ' · ' + label : 'No show running.'
    );
    setText('net-status', streamOn ? 'on air' : 'off air');
    setText('net-now', streamOn ? 'Tuned to ' + streamName + '.' : 'No stream playing.');
  }

  function noteTarget() {
    if (notesTrackId) {
      var found = S.getTrack(notesTrackId);
      if (found) return found;
    }
    return current;
  }

  function renderNotes(force) {
    var target = noteTarget();
    setText('notes-track', target ? target.title || target.name : 'no track');
    var form = $('notes-form');
    if (!force && form && form.contains(document.activeElement)) return;
    $('note-title').value = target ? target.title || '' : '';
    $('note-artist').value = target ? target.artist || '' : '';
    $('note-scene').value = target ? target.scene || '' : '';
    $('note-label').value = target ? target.label || '' : '';
    $('note-era').value = target ? target.era || '' : '';
    $('note-bandcamp').value = target ? target.bandcamp || '' : '';
    $('note-notes').value = target ? target.notes || '' : '';
    $('note-bpm').value = target && target.bpm ? String(Math.round(target.bpm * 10) / 10) : '';
    setText('note-status', '');
  }

  function updateDocTitle() {
    document.title = current ? (current.title || current.name) + ' · Slamdance Audio' : 'Slamdance Audio';
  }

  function openBuy(track) {
    if (!track) return;
    var url = (track.bandcamp || '').trim();
    if (!url) {
      url =
        'https://bandcamp.com/search?q=' +
        encodeURIComponent([track.artist, track.title || track.name].filter(Boolean).join(' '));
    }
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    window.open(url, '_blank', 'noopener');
  }

  // ── energy arc ────────────────────────────────────────────
  function arcSource() {
    var scope = $('arc-scope').value;
    if (scope === 'library') return localTracks().slice();
    if (scope === 'scene') {
      var scene = $('arc-scene').value;
      return localTracks().filter(function (track) {
        return (track.scene || '') === scene;
      });
    }
    return computeFiltered();
  }

  function buildArc() {
    var source = arcSource();
    if (source.length < 2) {
      toast('Need at least two tracks for an arc.', 'bad');
      return;
    }
    arcTracks = Arc.buildEnergyArc(source);
    $('arc-play').disabled = false;
    var scores = arcTracks.map(function (track) {
      return typeof track.intensity === 'number' ? track.intensity : 0;
    });
    var average = Math.round(
      scores.reduce(function (a, b) {
        return a + b;
      }, 0) / scores.length
    );
    var peak = Math.max.apply(null, scores);
    var peakAt = scores.indexOf(peak) + 1;
    var missing = arcTracks.filter(function (track) {
      return typeof track.intensity !== 'number';
    }).length;
    setText(
      'arc-summary',
      arcTracks.length +
        ' tracks · average ' +
        average +
        ' · peak ' +
        peak +
        ' at #' +
        peakAt +
        ' · closer ' +
        scores[scores.length - 1] +
        (missing ? ' · ' + missing + ' without a reading treated as mellow' : '')
    );
    renderArc();
    toast('Arc built: ' + arcTracks.length + ' tracks.', 'good');
  }

  function renderArc() {
    var canvas = $('arc-canvas');
    if (!canvas) return;
    var width = canvas.clientWidth || 900;
    var height = 180;
    var dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    var c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, width, height);

    var cs = getComputedStyle(document.documentElement);
    var accent = Themes.toHex(cs.getPropertyValue('--accent').trim()) || '#ff3b00';
    var accent2 = Themes.toHex(cs.getPropertyValue('--accent-2').trim()) || '#c8ff00';
    var line = Themes.toHex(cs.getPropertyValue('--line').trim()) || '#333333';

    c.strokeStyle = line;
    c.globalAlpha = 0.7;
    for (var g = 0; g <= 4; g++) {
      var gridY = 12 + ((height - 40) * g) / 4;
      c.beginPath();
      c.moveTo(10, gridY);
      c.lineTo(width - 10, gridY);
      c.stroke();
    }
    c.globalAlpha = 1;

    if (!arcTracks.length) {
      c.fillStyle = accent2;
      c.font = '11px ui-monospace, monospace';
      c.fillText('Build an arc to see the shape of the set.', 16, height / 2);
      renderArcList();
      return;
    }

    var scores = arcTracks.map(function (track) {
      return typeof track.intensity === 'number' ? track.intensity : 0;
    });
    var n = scores.length;
    var padL = 24;
    var padR = 12;
    var top = 14;
    var bottom = height - 26;

    function xAt(i) {
      return n === 1 ? (width - padL - padR) / 2 + padL : padL + (i / (n - 1)) * (width - padL - padR);
    }
    function yAt(v) {
      return bottom - (v / 100) * (bottom - top);
    }

    var gradient = c.createLinearGradient(0, top, 0, bottom);
    gradient.addColorStop(0, accent);
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    c.beginPath();
    c.moveTo(xAt(0), bottom);
    scores.forEach(function (v, i) {
      c.lineTo(xAt(i), yAt(v));
    });
    c.lineTo(xAt(n - 1), bottom);
    c.closePath();
    c.globalAlpha = 0.22;
    c.fillStyle = gradient;
    c.fill();
    c.globalAlpha = 1;

    c.beginPath();
    scores.forEach(function (v, i) {
      if (i === 0) c.moveTo(xAt(i), yAt(v));
      else c.lineTo(xAt(i), yAt(v));
    });
    c.strokeStyle = accent;
    c.lineWidth = 2;
    c.stroke();

    scores.forEach(function (v, i) {
      c.beginPath();
      c.arc(xAt(i), yAt(v), i === n - 1 ? 3.2 : 2.2, 0, Math.PI * 2);
      c.fillStyle = i === n - 1 ? accent2 : accent;
      c.fill();
    });

    c.fillStyle = accent2;
    c.font = '10px ui-monospace, monospace';
    c.fillText('100', 4, top + 4);
    c.fillText('0', 12, bottom + 3);

    renderArcList();
  }

  function renderArcList() {
    var host = $('arc-list');
    if (!host) return;
    host.textContent = '';
    arcTracks.forEach(function (track, index) {
      var li = document.createElement('li');
      li.className = 'arc-item';

      var number = document.createElement('span');
      number.className = 'n';
      number.textContent = String(index + 1).padStart(2, '0');

      var title = document.createElement('span');
      title.className = 't';
      title.textContent = track.title || track.name;

      var value = document.createElement('span');
      value.className = 'v';
      value.textContent = typeof track.intensity === 'number' ? String(track.intensity) : '—';

      li.append(number, title, value);
      li.addEventListener('click', function () {
        playFromList(track, arcTracks);
        setView('player');
      });
      host.appendChild(li);
    });
  }

  // ── radio ─────────────────────────────────────────────────
  function stationPool() {
    if (radio.scope === 'scene') {
      return localTracks().filter(function (track) {
        return (track.scene || '') === radio.scene;
      });
    }
    if (radio.scope === 'stream') {
      var track = S.getTrack(radio.streamId);
      return track ? [track] : [];
    }
    return localTracks();
  }

  function radioNext(currentTrack) {
    var pool = stationPool();
    if (!pool.length) return null;
    if (radio.scope === 'stream') return pool[0];

    var choices = pool.filter(function (track) {
      return !currentTrack || track.id !== currentTrack.id;
    });
    if (!choices.length) choices = pool.slice();

    var fresh = choices.filter(function (track) {
      return radio.recent.indexOf(track.id) === -1;
    });
    if (!fresh.length) {
      radio.recent = [];
      fresh = choices;
    }
    var pick = fresh[Math.floor(Math.random() * fresh.length)];
    radio.recent.push(pick.id);
    var cap = Math.max(1, Math.min(25, Math.floor(pool.length * 0.7)));
    while (radio.recent.length > cap) radio.recent.shift();
    return pick;
  }

  function tuneStation(station) {
    radio.on = true;
    radio.scope = station.scope || 'all';
    radio.scene = station.scene || null;
    radio.streamId = station.id || null;
    radio.recent = [];

    var pool = stationPool();
    renderStations();
    renderRadioPanelState();

    if (!pool.length) {
      radio.on = false;
      renderStations();
      renderRadioPanelState();
      toast('That station is empty — add files or tag a scene first.', 'bad');
      return;
    }

    setQueue(pool, 0);
    var first = radioNext(null);
    if (first) P.playTrack(first, { crossfade: 0 }).catch(function () {});
    setMoshActive(true);
    renderStations();
    renderRadioPanelState();
    toast(
      station.scope === 'stream'
        ? 'Tuned to ' + (station.name || 'the stream') + '.'
        : 'On air: ' + (settings.stationName || 'Slamdance Radio') + '.'
    );
  }

  function stopRadio() {
    radio.on = false;
    radio.recent = [];
    renderStations();
    renderRadioPanelState();
    P.stop();
    if ('speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch (e) {
        /* ignore */
      }
    }
    toast('Off air.');
  }

  function speak(text) {
    if (!('speechSynthesis' in window) || typeof window.SpeechSynthesisUtterance !== 'function') return;
    try {
      window.speechSynthesis.cancel();
      var utterance = new window.SpeechSynthesisUtterance(text);
      utterance.rate = 1.02;
      utterance.pitch = 0.92;
      utterance.volume = 0.9;
      window.speechSynthesis.speak(utterance);
    } catch (e) {
      /* no voice available, no problem */
    }
  }

  function playSting() {
    if (!settings.djVoice) return;
    try {
      var ctx = P.context();
      var out = P.output();
      var now = ctx.currentTime + 0.02;
      var notes = [392, 523.25, 659.25];
      notes.forEach(function (freq, i) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = freq;
        var at = now + i * 0.13;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.09, at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.12);
        osc.connect(gain);
        gain.connect(out);
        osc.start(at);
        osc.stop(at + 0.14);
      });
    } catch (e) {
      /* audio graph not ready yet */
    }
  }

  function djBreak(previous, track) {
    if (!radio.on || !settings.djVoice || radio.scope === 'stream') return;
    var station = (settings.stationName || 'Slamdance Radio').trim();
    var show = (settings.showName || '').trim();
    var line;
    if (previous && previous.id !== track.id) {
      line =
        'You are listening to ' +
        station +
        (show ? ', ' + show : '') +
        '. That was ' +
        (previous.title || previous.name) +
        (previous.artist ? ' by ' + previous.artist : '') +
        '. Now, ' +
        (track.title || track.name) +
        '.';
    } else {
      line =
        'You are listening to ' +
        station +
        (show ? ', ' + show : '') +
        '. Here is ' +
        (track.title || track.name) +
        '.';
    }
    playSting();
    setTimeout(function () {
      speak(line);
    }, 700);
  }

  function addStream() {
    var url = $('stream-url').value.trim();
    var name = $('stream-name').value.trim();
    if (!/^https?:\/\//i.test(url)) {
      toast('Paste a full http(s) stream URL — not the station page.', 'bad');
      return;
    }
    var id = S.streamId(url);
    if (!S.getTrack(id)) {
      S.upsertTrack({
        id: id,
        stream: true,
        url: url,
        name: name || 'Internet stream',
        title: name || 'Internet stream',
        artist: 'Internet radio',
        scene: 'Internet Radio',
        analyzed: true,
        plays: 0,
        addedAt: Date.now(),
      });
      S.save();
    }
    $('stream-url').value = '';
    $('stream-name').value = '';
    renderStations();
    renderAll();
    toast('Station added.', 'good');
  }

  // ── notes ─────────────────────────────────────────────────
  function saveNotes(event) {
    event.preventDefault();
    var target = noteTarget();
    if (!target) {
      toast('Pick a track first — notes attach to a track.', 'bad');
      return;
    }
    target.title = $('note-title').value.trim() || target.title || target.name;
    target.artist = $('note-artist').value.trim();
    target.scene = $('note-scene').value.trim();
    target.label = $('note-label').value.trim();
    target.era = $('note-era').value.trim();
    target.bandcamp = $('note-bandcamp').value.trim();
    target.notes = $('note-notes').value;

    var bpm = parseFloat($('note-bpm').value);
    if (isFinite(bpm) && bpm >= 40 && bpm <= 240) {
      target.bpm = bpm;
      target.intensity = A.scoreIntensity(
        bpm,
        typeof target.rmsDb === 'number' ? target.rmsDb : -14
      );
    }

    S.save();
    renderAll();
    renderArc();
    setText('note-status', 'Saved.');
    toast('Liner notes saved.', 'good');
  }

  // ── wiring ────────────────────────────────────────────────
  function syncSettingInputs() {
    var select = $('theme-select');
    if (select) select.value = settings.theme;
    $('crossfade-select').value = String(settings.crossfade || 0);
    $('volume').value = String(Math.round((settings.volume == null ? 0.85 : settings.volume) * 100));
    $('dj-voice').checked = !!settings.djVoice;
    $('station-name').value = settings.stationName || '';
    $('station-show').value = settings.showName || '';
    $('shuffle-btn').classList.toggle('is-on', !!settings.shuffle);
    $('shuffle-btn').setAttribute('aria-pressed', String(!!settings.shuffle));
    $('repeat-btn').classList.toggle('is-on', !!settings.repeat);
    $('repeat-btn').setAttribute('aria-pressed', String(!!settings.repeat));
    P.setVolume(settings.volume == null ? 0.85 : settings.volume);
    P.setCrossfade(settings.crossfade || 0);
  }

  function initPlayerHooks() {
    P.setNextResolver(function (cur) {
      if (radio.on) return radioNext(cur);
      if (!queue.length) return null;
      var at = -1;
      for (var i = 0; i < queue.length; i++) {
        if (cur && queue[i].id === cur.id) {
          at = i;
          break;
        }
      }
      // A track that is not in the queue must not make advance() fall back to
      // queue[0]; that is what jumped the first click to the first song.
      if (at === -1) return null;
      var next = queue[at + 1];
      if (!next && settings.repeat) next = queue[0];
      return next || null;
    });

    P.on('track', function (track) {
      lastTrack = current;
      current = S.getTrack(track.id) || track;
      track.plays = (track.plays || 0) + 1;
      notesTrackId = current.id;
      S.save();
      renderAll();
      renderNotes();
      if (radio.on) djBreak(lastTrack, current);
      setMoshActive(P.isPlaying() || moshOn);
    });

    P.on('time', function (info) {
      if (seekDragging) return;
      setText('time-current', fmtTime(info.time));
      if (info.duration) {
        setText('time-total', fmtTime(info.duration));
        $('seek').value = String(Math.round((info.time / info.duration) * 1000));
        if (current && !current.duration) current.duration = info.duration;
      }
    });

    P.on('state', function (info) {
      $('btn-play').textContent = info.playing ? '❚❚' : '▶';
      setText('np-play', info.playing ? 'Pause the pit' : 'Play the pit');
      setText('np-state', info.playing ? 'Now spinning' : current ? 'Paused' : 'Nothing spinning');
      document.body.classList.toggle('is-playing', info.playing);
      setMoshActive(info.playing || moshOn);
      if (!info.playing) {
        setWidth('live-meter-fill', 0);
        setWidth('pit-mini-fill', 0);
        setWidth('hud-meter-fill', 0);
        setText('live-meter-value', current ? 'paused' : 'idle');
      }
    });

    P.on('error', function (err) {
      if (err && err.code === 'relink') {
        pendingRelink = current;
        toast('That track is not stored here yet. Pick the file to re-link it.', 'bad');
        $('relink-input').click();
        return;
      }
      toast(err && err.message ? err.message : 'Playback failed.', 'bad');
    });

    P.on('queueend', function () {
      toast('End of the set. Nothing queued after that.');
    });

    P.on('stopped', function () {
      setText('np-state', current ? 'Stopped' : 'Nothing spinning');
    });
  }

  function globalKeys(event) {
    var target = event.target;
    var tag = target && target.tagName ? target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || (target && target.isContentEditable)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === ' ') {
      event.preventDefault();
      togglePlay();
    } else if (event.key === 'Escape' && moshOn) {
      setMosh(false);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      P.seek(P.position() + 5);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      P.seek(Math.max(0, P.position() - 5));
    } else if (event.key >= '1' && event.key <= '8') {
      setView(VIEWS[Number(event.key) - 1]);
    } else {
      var key = event.key.toLowerCase();
      if (key === 'n') P.next();
      else if (key === 'p') P.prev();
      else if (key === 's') P.stop();
      else if (key === 'm') setMosh(!moshOn);
    }
  }

  function wire() {
    Array.prototype.forEach.call(document.querySelectorAll('.nav-btn'), function (btn) {
      btn.addEventListener('click', function () {
        setView(btn.getAttribute('data-view'));
      });
    });
    on($('brand-home'), 'click', function () {
      setView('player');
    });
    on($('mosh-toggle'), 'click', function () {
      setMosh(!moshOn);
    });
    on($('theme-select'), 'change', function () {
      if (this.value === '__import') {
        this.value = settings.theme;
        $('theme-import-sdt-input').click();
        return;
      }
      applyThemeId(this.value, true);
      renderCustomThemes();
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-add-files]'), function (btn) {
      btn.addEventListener('click', function () {
        $('file-input').click();
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-add-folder]'), function (btn) {
      btn.addEventListener('click', function () {
        // Desktop builds browse folders in-app; the webview's chooser is only
        // a fallback for a plain browser.
        if (Native) openFolderBrowser();
        else $('folder-input').click();
      });
    });
    on($('file-input'), 'change', function () {
      addFiles(this.files);
      this.value = '';
    });
    on($('folder-input'), 'change', function () {
      addFiles(this.files);
      this.value = '';
    });
    on($('folder-add'), 'click', addCurrentFolder);
    on($('folder-cancel'), 'click', closeFolder);
    on($('folder-up'), 'click', function () {
      if (folder.view && folder.view.parent) loadFolder(folder.view.parent);
    });
    on($('folder-modal'), 'click', function (event) {
      if (event.target === this) closeFolder();
    });
    document.addEventListener(
      'keydown',
      function (event) {
        if (event.key !== 'Escape' || !folderOpen()) return;
        event.preventDefault();
        event.stopPropagation();
        closeFolder();
      },
      true
    );
    on($('relink-input'), 'change', function () {
      var file = this.files && this.files[0];
      var track = pendingRelink;
      this.value = '';
      if (!file || !track) return;
      S.putBlob(track.id, file);
      track.missing = false;
      track.analyzed = false;
      P.invalidate(track.id);
      S.save();
      pendingRelink = null;
      renderLibrary();
      toast('Re-linked "' + (track.title || track.name) + '".', 'good');
      P.playTrack(track, { crossfade: 0 }).catch(function () {});
      analyzePending(function (item) {
        return item.id === track.id;
      });
    });

    var dragDepth = 0;
    function hasFiles(event) {
      var dt = event.dataTransfer;
      return !!(dt && dt.types && Array.prototype.indexOf.call(dt.types, 'Files') !== -1);
    }
    window.addEventListener('dragenter', function (event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth++;
      document.body.classList.add('is-dragging');
    });
    window.addEventListener('dragover', function (event) {
      if (hasFiles(event)) event.preventDefault();
    });
    window.addEventListener('dragleave', function (event) {
      if (!hasFiles(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) document.body.classList.remove('is-dragging');
    });
    window.addEventListener('drop', function (event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth = 0;
      document.body.classList.remove('is-dragging');
      if (event.dataTransfer.files && event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
    });

    on($('btn-play'), 'click', togglePlay);
    on($('np-play'), 'click', togglePlay);
    on($('btn-prev'), 'click', function () {
      P.prev();
    });
    on($('btn-next'), 'click', function () {
      P.next();
    });
    on($('btn-stop'), 'click', function () {
      P.stop();
    });

    on($('seek'), 'input', function () {
      seekDragging = true;
      if (!current || P.isStream()) return;
      var duration = P.duration() || current.duration || 0;
      if (duration) setText('time-current', fmtTime((Number(this.value) / 1000) * duration));
    });
    on($('seek'), 'change', function () {
      seekDragging = false;
      if (!current || P.isStream()) return;
      var duration = P.duration() || current.duration || 0;
      if (duration) P.seek((Number(this.value) / 1000) * duration);
    });

    on($('volume'), 'input', function () {
      var level = Number(this.value) / 100;
      P.setVolume(level);
      settings.volume = level;
      S.save();
    });
    on($('crossfade-select'), 'change', function () {
      settings.crossfade = Number(this.value) || 0;
      P.setCrossfade(settings.crossfade);
      S.save();
    });

    on($('shuffle-btn'), 'click', toggleShuffle);
    on($('repeat-btn'), 'click', function () {
      settings.repeat = !settings.repeat;
      this.classList.toggle('is-on', settings.repeat);
      this.setAttribute('aria-pressed', String(settings.repeat));
      S.save();
      toast(settings.repeat ? 'Repeat on.' : 'Repeat off.');
    });

    on($('np-buy'), 'click', function () {
      if (current) openBuy(current);
    });
    on($('np-notes'), 'click', function () {
      if (!current) return;
      notesTrackId = current.id;
      setView('notes');
      renderNotes(true);
    });

    on($('lib-search'), 'input', function () {
      filters.search = this.value;
      renderLibrary();
    });
    on($('lib-sort'), 'change', function () {
      filters.sort = this.value;
      renderLibrary();
    });
    on($('lib-heat'), 'click', function (event) {
      var chip = event.target.closest('[data-heat]');
      if (!chip) return;
      filters.heat = chip.getAttribute('data-heat');
      var host = this;
      Array.prototype.forEach.call(host.querySelectorAll('[data-heat]'), function (el) {
        el.classList.toggle('is-active', el === chip);
      });
      renderLibrary();
    });
    on($('lib-body'), 'click', function (event) {
      var button = event.target.closest('[data-act]');
      var row = event.target.closest('tr[data-id]');
      if (!row) return;
      var track = S.getTrack(row.getAttribute('data-id'));
      if (!track) return;
      var act = button ? button.getAttribute('data-act') : 'play';
      if (act === 'buy') openBuy(track);
      else if (act === 'notes') {
        notesTrackId = track.id;
        setView('notes');
        renderNotes(true);
      } else if (act === 'remove') removeTrack(track);
      else playFromList(track, libraryView);
    });

    on($('analyze-btn'), 'click', function () {
      analyzePending(function (track) {
        return !track.analyzed || track.bpm == null;
      });
    });
    on($('pit-analyze'), 'click', function () {
      analyzePending(function (track) {
        return !track.analyzed || track.bpm == null;
      });
    });
    on($('clear-lib-btn'), 'click', clearLibrary);

    on($('arc-scope'), 'change', function () {
      $('arc-scene').hidden = this.value !== 'scene';
    });
    on($('arc-build'), 'click', buildArc);
    on($('arc-play'), 'click', function () {
      if (!arcTracks.length) return;
      playFromList(arcTracks[0], arcTracks);
      setView('player');
    });

    on($('station-name'), 'change', function () {
      settings.stationName = this.value.trim() || 'Slamdance Radio';
      S.save();
      renderRadioPanelState();
    });
    on($('station-show'), 'change', function () {
      settings.showName = this.value.trim();
      S.save();
    });
    on($('dj-voice'), 'change', function () {
      settings.djVoice = this.checked;
      S.save();
    });
    on($('radio-start'), 'click', function () {
      tuneStation({ scope: 'all' });
    });
    on($('radio-stop'), 'click', stopRadio);
    on($('radio-test'), 'click', function () {
      djBreak(null, current || { title: 'Slamdance Audio' });
    });
    on($('stream-add'), 'click', addStream);
    on($('go-internet'), 'click', function () {
      setView('internet');
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-layout-key]'), function (box) {
      on(box, 'change', function () {
        setLayout(box.getAttribute('data-layout-key'), box.checked);
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-card-toggle]'), function (btn) {
      on(btn, 'click', function () {
        var key = btn.getAttribute('data-card-toggle');
        var collapsed = settings.collapsedCards || {};
        setCardCollapsed(key, !collapsed[key]);
      });
    });

    on($('notes-form'), 'submit', saveNotes);
    on($('note-buy'), 'click', function () {
      var target = noteTarget();
      if (target) openBuy(target);
    });

    on($('theme-form'), 'submit', function (event) {
      event.preventDefault();
      saveThemeDraft();
    });
    ['tc-bg', 'tc-panel', 'tc-ink', 'tc-accent', 'tc-accent2', 'tc-line'].forEach(function (id) {
      on($(id), 'input', previewDraft);
    });
    on($('tc-font-display'), 'change', previewDraft);
    on($('tc-font-body'), 'change', previewDraft);
    on($('theme-base'), 'change', function () {
      var base = Themes.get(this.value);
      Themes.apply(this.value);
      applyCutout(!!base && base.glyphs === 'ransom');
      syncEditor();
      if (window.SDMosh) window.SDMosh.refreshColors();
      setText('theme-status', 'Starting from ' + (base ? base.name : 'Mosh Pit'));
    });
    on($('theme-revert'), 'click', function () {
      editingThemeId = null;
      $('theme-name').value = '';
      applyThemeId(settings.theme, false);
      syncEditor();
      var current = Themes.get(settings.theme);
      setText('theme-status', 'Reverted to ' + (current ? current.name : 'your saved skin'));
    });
    on($('theme-import-sdt'), 'click', function () {
      $('theme-import-sdt-input').click();
    });
    on($('theme-import-dir'), 'click', function () {
      $('theme-import-dir-input').click();
    });
    on($('theme-import-sdt-input'), 'change', function () {
      var file = this.files && this.files[0];
      this.value = '';
      importThemeArchive(file);
    });
    on($('theme-import-dir-input'), 'change', function () {
      var files = Array.prototype.slice.call(this.files || []);
      this.value = '';
      importThemeFiles(files);
    });
    on($('theme-css-btn'), 'click', showThemeCss);
    on($('theme-css-copy'), 'click', copyThemeCss);

    document.addEventListener('keydown', globalKeys);
    initPlayerHooks();
  }

  function boot() {
    S.load();
    settings = S.state.settings;
    if (!Array.isArray(settings.customThemes)) settings.customThemes = [];
    settings.customThemes.forEach(function (theme) {
      if (!theme.layout) theme.layout = 'classic';
      if (!theme.css && theme.vars) theme.css = Themes.cssRule(theme.id, theme.vars);
    });
    applyLayout();
    applyCards();

    fillThemeSelects();
    applyThemeId(settings.theme, false);
    if (window.SDMosh) window.SDMosh.init($('pit-canvas'), moshSignal);

    wire();
    syncSettingInputs();
    syncEditor();
    renderCustomThemes();
    renderAll();
    renderNotes(true);
    setQueue(computeFiltered(), -1);
    setView(settings.lastView || 'player', true);
    checkMissingBlobs();
    backfillTags();
    setInterval(tick, 120);
  }

  // Theme CSS files load before the app boots. A missing pack must not leave
  // the player blank, so a timeout starts it with the :root defaults.
  var booted = false;

  function start() {
    if (booted) return;
    booted = true;
    boot();
  }

  function onThemesReady() {
    if (!booted) {
      start();
      return;
    }
    fillThemeSelects();
    applyThemeId(settings.theme, false);
    renderCustomThemes();
  }

  window.addEventListener('sd:themes-ready', onThemesReady);
  if (window.SDThemes && window.SDThemes.ready) start();
  else window.setTimeout(function () { if (!booted) start(); }, 4000);
})();
