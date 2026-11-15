#!/usr/bin/env node

/*
 * Slamdance Audio — static web staging.
 *
 * The player has no bundler: index.html loads the CSS, themes, and classic
 * scripts directly. Tauri and Electron both need a clean directory containing
 * only those runtime files, so both use this script.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = path.join(ROOT, 'build', 'web');
const ENTRIES = ['index.html', 'styles.css', 'js', 'themes'];

function appImages() {
  return readdirSync(ROOT).filter((name) => {
    if (!/\.(png|jpe?g|webp|svg)$/i.test(name)) return false;
    return statSync(path.join(ROOT, name)).isFile();
  });
}

export function stageWeb(outDir = DEFAULT_OUT) {
  const out = path.resolve(outDir);
  if (out === ROOT || !out.startsWith(ROOT + path.sep)) {
    throw new Error('Refusing to stage outside the project: ' + out);
  }

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  for (const entry of [...ENTRIES, ...appImages()]) {
    const source = path.join(ROOT, entry);
    if (!existsSync(source)) {
      throw new Error('Missing runtime asset: ' + entry);
    }
    cpSync(source, path.join(out, entry), { recursive: true });
  }

  if (!existsSync(path.join(out, 'index.html'))) {
    throw new Error('Staged app has no index.html');
  }

  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const out = stageWeb();
    console.log('[stage] web assets -> ' + path.relative(ROOT, out));
  } catch (error) {
    console.error('[stage] ' + error.message);
    process.exit(1);
  }
}
