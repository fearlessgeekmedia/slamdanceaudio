/*
 * Slamdance Audio — lightweight local tag reader.
 *
 * Amazon MP3s carry standard ID3v2 tags. We only need the small set of text
 * frames the library can show, so this reads the tag bytes directly instead of
 * pulling in a parser dependency. Nothing leaves the machine.
 */
(function (root) {
  'use strict';

  var TEXT_FRAMES = {
    TIT2: 'title',
    TT2: 'title',
    TPE1: 'artist',
    TP1: 'artist',
    TALB: 'album',
    TAL: 'album',
    TCON: 'genre',
    TCO: 'genre',
    TDRC: 'year',
    TYER: 'year',
    TYE: 'year',
    TRCK: 'track',
    TRK: 'track',
    TPOS: 'disc',
    TPE2: 'albumArtist',
    TP2: 'albumArtist',
  };

  function u16be(bytes, offset) {
    return (bytes[offset] << 8) | bytes[offset + 1];
  }

  function u24be(bytes, offset) {
    return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
  }

  function u32be(bytes, offset) {
    return (
      ((bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3]) >>>
      0
    );
  }

  function syncsafe(bytes, offset) {
    return (
      ((bytes[offset] & 0x7f) << 21) |
      ((bytes[offset + 1] & 0x7f) << 14) |
      ((bytes[offset + 2] & 0x7f) << 7) |
      (bytes[offset + 3] & 0x7f)
    );
  }

  function ascii(bytes, start, end) {
    var out = '';
    for (var i = start; i < end && i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }

  function latin1(bytes) {
    var out = '';
    var chunk = [];
    for (var i = 0; i < bytes.length; i++) {
      chunk.push(bytes[i]);
      if (chunk.length >= 4096) {
        out += String.fromCharCode.apply(null, chunk);
        chunk = [];
      }
    }
    return out + String.fromCharCode.apply(null, chunk);
  }

  function utf8(bytes) {
    if (typeof TextDecoder === 'function') {
      try {
        return new TextDecoder('utf-8').decode(bytes);
      } catch (e) {
        /* fall through to Latin-1 */
      }
    }
    return latin1(bytes);
  }

  function utf16(bytes) {
    var start = 0;
    var little = true;
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      start = 2;
      little = true;
    } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      start = 2;
      little = false;
    }
    var out = '';
    for (var i = start; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode(little ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1]);
    }
    return out;
  }

  function decodeString(bytes, encoding) {
    if (encoding === 1) return utf16(bytes);
    if (encoding === 2) {
      var out = '';
      for (var i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      return out;
    }
    if (encoding === 3) return utf8(bytes);
    return latin1(bytes);
  }

  function tidy(value) {
    return String(value || '')
      .replace(/\uFEFF/g, '')
      .replace(/^\s+|\s+$/g, '');
  }

  function textFrame(data) {
    if (!data || !data.length) return '';
    var text = decodeString(data.subarray(1), data[0]);
    return text
      .replace(/\uFEFF/g, '')
      .split('\u0000')
      .map(tidy)
      .filter(Boolean)
      .join(' / ');
  }

  // ID3v2.3 tag-level unsynchronisation. A literal 0xFF 0x00 pair becomes 0xFF.
  function deunsync(bytes) {
    var out = new Uint8Array(bytes.length);
    var j = 0;
    for (var i = 0; i < bytes.length; i++) {
      out[j++] = bytes[i];
      if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i++;
    }
    return out.subarray(0, j);
  }

  function parseTag(bytes) {
    var tags = {};
    if (!bytes || bytes.length < 10 || ascii(bytes, 0, 3) !== 'ID3') return tags;

    var version = bytes[3];
    if (version < 2 || version > 4) return tags;

    var flags = bytes[5];
    var size = syncsafe(bytes, 6);
    if (!size) return tags;

    var body = bytes.subarray(10, Math.min(bytes.length, 10 + size));
    if (version < 4 && (flags & 0x80)) body = deunsync(body);

    var offset = 0;
    if (flags & 0x40 && body.length >= 4) {
      // v2.3's extended-header size excludes its own four bytes; v2.4's includes them.
      var ext = version === 4 ? syncsafe(body, 0) : u32be(body, 0) + 4;
      if (ext > 0 && ext < body.length) offset = ext;
    }

    var header = version === 2 ? 6 : 10;
    var idLength = version === 2 ? 3 : 4;

    while (offset + header <= body.length) {
      var id = ascii(body, offset, offset + idLength);
      if (!/^[A-Z0-9]{2,4}$/.test(id)) break;

      var frameSize =
        version === 2
          ? u24be(body, offset + 3)
          : version === 4
            ? syncsafe(body, offset + 4)
            : u32be(body, offset + 4);
      if (!frameSize || offset + header + frameSize > body.length) break;

      var data = body.subarray(offset + header, offset + header + frameSize);
      if (version === 4) {
        var frameFlags = u16be(body, offset + 8);
        if (frameFlags & 0x02) data = deunsync(data);
        if (frameFlags & 0x01 && data.length >= 4) data = data.subarray(4);
      }

      if (TEXT_FRAMES[id]) {
        var value = textFrame(data);
        if (value && !tags[TEXT_FRAMES[id]]) tags[TEXT_FRAMES[id]] = value;
      }

      offset += header + frameSize;
    }

    if (tags.year) {
      var year = String(tags.year).match(/\d{4}/);
      tags.year = year ? year[0] : tags.year;
    }
    return tags;
  }

  function parseId3v1(bytes) {
    var tags = {};
    if (!bytes || bytes.length < 128) return tags;
    var at = bytes.length - 128;
    if (ascii(bytes, at, at + 3) !== 'TAG') return tags;

    function field(start, length) {
      return latin1(bytes.subarray(at + start, at + start + length))
        .replace(/\u0000/g, ' ')
        .replace(/\s+$/g, '')
        .replace(/^\s+/g, '');
    }

    var title = field(3, 30);
    var artist = field(33, 30);
    var album = field(63, 30);
    var year = field(93, 4);
    if (title) tags.title = title;
    if (artist) tags.artist = artist;
    if (album) tags.album = album;
    if (year) tags.year = year;
    return tags;
  }

  function parse(input) {
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    var tags = parseTag(bytes);
    if (Object.keys(tags).length) return tags;
    return parseId3v1(bytes);
  }

  function bufferOf(blob) {
    if (blob && typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(reader.result);
      };
      reader.onerror = function () {
        reject(reader.error || new Error('Could not read file'));
      };
      reader.readAsArrayBuffer(blob);
    });
  }

  function read(file) {
    if (!file || typeof file.slice !== 'function') return Promise.resolve({});
    return bufferOf(file.slice(0, 10)).then(function (headBuffer) {
      var head = new Uint8Array(headBuffer);
      if (head.length >= 10 && ascii(head, 0, 3) === 'ID3') {
        var size = syncsafe(head, 6);
        if (size > 0 && size <= 64 * 1024 * 1024) {
          return bufferOf(file.slice(0, Math.min(file.size, 10 + size))).then(function (buffer) {
            return parseTag(new Uint8Array(buffer));
          });
        }
      }
      var start = Math.max(0, file.size - 128);
      return bufferOf(file.slice(start)).then(function (buffer) {
        return parseId3v1(new Uint8Array(buffer));
      });
    });
  }

  root.SDMetadata = {
    parse: parse,
    read: read,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
