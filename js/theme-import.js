/*
 * Slamdance Audio — theme import.
 *
 * Reads a .sdt (zip) archive or a picked folder into one theme object. The
 * theme is plain CSS plus metadata, so a packaged build does not need access
 * to the bundled themes/ folders.
 *
 * Archive:
 *   theme.json   { id, name, layout, glyphs?, css?, vars? }
 *   *.css        one or more stylesheets; relative url() assets are inlined
 *   assets...    images/fonts referenced by the CSS
 *
 * A folder containing the same files works. A lone .css also works; its id is
 * read from the data-theme selector.
 */
(function (root) {
  'use strict';

  var MAX_TOTAL = 2 * 1024 * 1024;
  var MAX_CSS = 3 * 1024 * 1024;
  var MAX_ENTRIES = 512;
  var MAX_ZIP_BYTES = 8 * 1024 * 1024;
  var LAYOUTS = ['classic', 'flyer', 'two-tone', 'hazard', 'loose', 'broadsheet', 'poster', 'console'];
  var MIME = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
  };

  function fail(message) {
    throw new Error(message);
  }

  function bytesOf(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return new Uint8Array(value);
  }

  function decode(bytes) {
    return new TextDecoder('utf-8').decode(bytes);
  }

  function normalizePath(path) {
    return String(path || '')
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/\/+/g, '/');
  }

  function baseName(path) {
    var parts = normalizePath(path).split('/');
    return parts[parts.length - 1] || '';
  }

  function dirName(path) {
    var parts = normalizePath(path).split('/');
    parts.pop();
    return parts.join('/');
  }

  function depth(path) {
    return normalizePath(path).split('/').length;
  }

  function extName(path) {
    var match = /\.([a-z0-9]+)$/i.exec(path);
    return match ? match[1].toLowerCase() : '';
  }

  function isHidden(path) {
    var parts = normalizePath(path).split('/');
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '__MACOSX' || parts[i] === '.DS_Store' || parts[i].indexOf('._') === 0) return true;
    }
    return false;
  }

  function slug(value) {
    return (
      String(value || 'theme')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'theme'
    );
  }

  function normalizeId(value) {
    var id = slug(value);
    if (!/^[a-z0-9]/.test(id)) id = 'theme-' + id;
    return id;
  }

  function title(value) {
    return (
      String(value || '')
        .replace(/\.css$/i, '')
        .replace(/[-_]+/g, ' ')
        .replace(/\b[a-z]/g, function (ch) {
          return ch.toUpperCase();
        })
        .trim() || 'Imported theme'
    );
  }

  function resolvePath(base, rel) {
    var out = base ? base.split('/').filter(Boolean) : [];
    String(rel || '')
      .split('/')
      .forEach(function (part) {
        if (!part || part === '.') return;
        if (part === '..') out.pop();
        else out.push(part);
      });
    return out.join('/');
  }

  function base64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    var binary = '';
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return root.btoa(binary);
  }

  function dataUrl(bytes, path) {
    var type = MIME[extName(path)] || 'application/octet-stream';
    return 'data:' + type + ';base64,' + base64(bytes);
  }

  function cssRule(id, vars) {
    var lines = Object.keys(vars || {})
      .filter(function (key) {
        return /^--[a-z0-9-]+$/.test(key);
      })
      .map(function (key) {
        return '  ' + key + ': ' + String(vars[key]) + ';';
      });
    if (!lines.length) return '';
    return 'html[data-theme="' + id + '"] {\n' + lines.join('\n') + '\n}';
  }

  async function inlineCss(css, cssPath, files, warnings, budget) {
    css = css.replace(/@import[^;]+;/gi, function () {
      warnings.push('Removed an @import from the theme.');
      return '';
    });

    // Remote resources are refused: this player is offline-only.
    css = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, function (match, quote, ref) {
      var url = String(ref || '').trim();
      if (!url) return match;
      if (/^(data:|#|var\()/i.test(url)) return match;
      if (/^(https?:)?\/\//i.test(url)) {
        warnings.push('Blocked remote asset: ' + url);
        return 'none';
      }

      var clean = url.split(/[?#]/)[0];
      var target = resolvePath(dirName(cssPath), clean);
      var entry = files[target];
      if (!entry) {
        try {
          target = resolvePath(dirName(cssPath), decodeURIComponent(clean));
          entry = files[target];
        } catch (e) {
          entry = null;
        }
      }
      if (!entry) {
        warnings.push('Missing asset: ' + clean);
        return 'none';
      }
      if (!entry.url) {
        if (budget.bytes + entry.bytes.length > MAX_TOTAL) {
          fail('Theme assets are larger than 2 MB.');
        }
        budget.bytes += entry.bytes.length;
        entry.url = dataUrl(entry.bytes, entry.path);
      }
      return 'url("' + entry.url + '")';
    });

    return css;
  }

  async function buildTheme(entries, options) {
    var opts = options || {};
    var files = [];
    var fileMap = Object.create(null);
    var total = 0;

    (entries || []).forEach(function (entry) {
      if (!entry || !entry.path) return;
      var path = normalizePath(entry.path);
      if (!path || /\/$/.test(path) || isHidden(path)) return;
      var bytes = bytesOf(entry.bytes);
      if (fileMap[path]) fail('The theme contains a duplicate file: ' + path);
      files.push({ path: path, bytes: bytes });
      fileMap[path] = files[files.length - 1];
      total += bytes.length;
    });

    if (!files.length) fail('No theme files were found.');
    if (total > MAX_TOTAL) fail('Theme files are larger than 2 MB.');

    var metaEntry = files
      .filter(function (file) {
        return baseName(file.path) === 'theme.json';
      })
      .sort(function (a, b) {
        return depth(a.path) - depth(b.path);
      })[0];

    var meta = {};
    if (metaEntry) {
      try {
        meta = JSON.parse(decode(metaEntry.bytes));
      } catch (e) {
        fail('theme.json is not valid JSON.');
      }
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
        fail('theme.json must contain an object.');
      }
    }

    var root = metaEntry ? dirName(metaEntry.path) : '';
    var cssFiles = [];

    if (meta.css) {
      var refs = Array.isArray(meta.css) ? meta.css : [meta.css];
      refs.forEach(function (ref) {
        var path = resolvePath(root, normalizePath(ref));
        if (!fileMap[path]) fail('Theme CSS not found: ' + ref);
        cssFiles.push(fileMap[path]);
      });
    } else {
      cssFiles = files.filter(function (file) {
        if (extName(file.path) !== 'css') return false;
        if (!root) return true;
        return file.path.indexOf(root + '/') === 0;
      });
      cssFiles.sort(function (a, b) {
        var aFirst = baseName(a.path) === 'theme.css' ? 0 : 1;
        var bFirst = baseName(b.path) === 'theme.css' ? 0 : 1;
        return aFirst - bFirst || a.path.localeCompare(b.path);
      });
    }

    if (!cssFiles.length) fail('The theme has no CSS file.');

    var rawCss = cssFiles
      .map(function (file) {
        return decode(file.bytes);
      })
      .join('\n\n');
    var foundIds = [];
    rawCss.replace(/data-theme\s*=\s*["']([^"']+)["']/g, function (match, value) {
      if (foundIds.indexOf(value) === -1) foundIds.push(value);
      return match;
    });
    if (foundIds.length > 1) {
      fail('A theme pack must use one data-theme id, found: ' + foundIds.join(', '));
    }

    var cssId = foundIds[0] || '';
    var baseId = normalizeId(
      (typeof meta.id === 'string' && meta.id) ||
        cssId ||
        (root ? baseName(root) : baseName(cssFiles[0].path))
    );
    var id = baseId;
    var reserved = Array.isArray(opts.reservedIds) ? opts.reservedIds : [];
    if (reserved.indexOf(id) !== -1) {
      var candidate = baseId + '-import';
      var n = 2;
      while (reserved.indexOf(candidate) !== -1) {
        candidate = baseId + '-import-' + n;
        n++;
      }
      id = candidate;
    }

    var nameSource =
      root || (dirName(cssFiles[0].path) ? baseName(dirName(cssFiles[0].path)) : baseName(cssFiles[0].path));
    var name =
      (typeof meta.name === 'string' && meta.name.trim()) ||
      title(nameSource);
    var layout = String(meta.layout || 'classic');
    if (LAYOUTS.indexOf(layout) === -1) layout = 'classic';
    var glyphs = meta.glyphs === 'ransom' ? 'ransom' : '';
    var vars = meta.vars && typeof meta.vars === 'object' && !Array.isArray(meta.vars) ? meta.vars : null;

    var warnings = [];
    var budget = { bytes: 0 };
    var parts = [];
    for (var i = 0; i < cssFiles.length; i++) {
      parts.push(await inlineCss(decode(cssFiles[i].bytes), cssFiles[i].path, fileMap, warnings, budget));
    }
    var css = parts.join('\n\n');

    if (cssId && cssId !== id) {
      css = css.replace(/(data-theme\s*=\s*["'])([^"']+)(["'])/g, function (match, before, value, after) {
        return value === cssId ? before + id + after : match;
      });
    }

    var varBlock = vars ? cssRule(id, vars) : '';
    if (varBlock) css = varBlock + '\n\n' + css;
    if (!/data-theme\s*=/.test(css)) {
      fail('Theme CSS must scope its rules with html[data-theme="…"].');
    }
    var flatCss = css.replace(/\/\*[\s\S]*?\*\//g, '');
    if (/(^|\})\s*(html|body|:root|\*)\s*[,{]\s*/i.test(flatCss)) {
      fail('Prefix global html/body/:root/* rules with html[data-theme="…"].');
    }
    if (css.length > MAX_CSS) fail('Theme CSS is too large after inlining assets.');

    return {
      id: id,
      name: name,
      layout: layout,
      glyphs: glyphs,
      vars: vars,
      css: css,
      warnings: warnings,
    };
  }

  async function fromFiles(fileList, options) {
    var entries = [];
    for (var i = 0; i < fileList.length; i++) {
      var file = fileList[i];
      if (!file || typeof file.arrayBuffer !== 'function') continue;
      if (typeof file.size === 'number' && file.size > MAX_TOTAL) {
        fail('Theme files are larger than 2 MB.');
      }
      entries.push({
        path: file.webkitRelativePath || file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
    }
    return buildTheme(entries, options);
  }

  async function inflateRaw(bytes) {
    if (
      typeof DecompressionStream === 'undefined' ||
      typeof Blob === 'undefined' ||
      typeof Response === 'undefined'
    ) {
      fail('This build cannot unpack compressed .sdt files. Use an uncompressed .sdt or import the folder.');
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzip(input) {
    var bytes = bytesOf(input);
    if (bytes.length < 22) fail('That file is not a .sdt archive.');
    if (bytes.length > MAX_ZIP_BYTES) fail('The .sdt archive is larger than 8 MB.');
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var eocd = -1;
    var floor = Math.max(0, bytes.length - 22 - 65535);
    for (var i = bytes.length - 22; i >= floor; i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) fail('That file is not a .sdt archive.');

    var count = view.getUint16(eocd + 10, true);
    var cdOffset = view.getUint32(eocd + 16, true);
    if (!count) fail('The .sdt archive is empty.');
    if (count > MAX_ENTRIES) fail('The .sdt archive has too many files.');

    var out = [];
    var total = 0;
    var pointer = cdOffset;
    for (var n = 0; n < count; n++) {
      if (view.getUint32(pointer, true) !== 0x02014b50) fail('The .sdt archive is damaged.');
      var flags = view.getUint16(pointer + 8, true);
      var method = view.getUint16(pointer + 10, true);
      var compressedSize = view.getUint32(pointer + 20, true);
      var uncompressedSize = view.getUint32(pointer + 24, true);
      var nameLength = view.getUint16(pointer + 28, true);
      var extraLength = view.getUint16(pointer + 30, true);
      var commentLength = view.getUint16(pointer + 32, true);
      var localOffset = view.getUint32(pointer + 42, true);
      var name = normalizePath(decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength)));

      if (flags & 1) fail('Encrypted .sdt archives are not supported.');
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
        fail('ZIP64 .sdt archives are not supported.');
      }
      if (view.getUint32(localOffset, true) !== 0x04034b50) fail('The .sdt archive is damaged.');

      var localNameLength = view.getUint16(localOffset + 26, true);
      var localExtraLength = view.getUint16(localOffset + 28, true);
      var dataStart = localOffset + 30 + localNameLength + localExtraLength;
      var compressed = bytes.subarray(dataStart, dataStart + compressedSize);
      var data;
      if (method === 0) data = compressed;
      else if (method === 8) data = await inflateRaw(compressed);
      else fail('Unsupported compression in .sdt: ' + method);

      if (uncompressedSize && data.length !== uncompressedSize) {
        fail('The .sdt archive is damaged (size mismatch).');
      }
      total += data.length;
      if (total > MAX_ZIP_BYTES) fail('The .sdt archive is too large.');
      if (name && !/\/$/.test(name)) out.push({ path: name, bytes: data });
      pointer += 46 + nameLength + extraLength + commentLength;
    }
    return out;
  }

  async function fromSdt(buffer, options) {
    var entries = await unzip(buffer);
    return buildTheme(entries, options);
  }

  var API = {
    fromSdt: fromSdt,
    fromFiles: fromFiles,
    buildTheme: buildTheme,
    unzip: unzip,
    MAX_TOTAL: MAX_TOTAL,
  };

  root.SDThemeImport = API;
  if (typeof module === 'object' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
