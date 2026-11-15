#!/usr/bin/env node

/*
 * Slamdance Audio — desktop builds.
 *
 * Linux, macOS, and Windows use Tauri and must be built on their matching OS.
 * FreeBSD uses the Electron runtime from the FreeBSD ports/package tree; the
 * resulting archive contains the app and launcher, not an Electron binary.
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stageWeb } from './stage-web.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const SLUG = PKG.name || 'slamdance-audio';
const IS_WINDOWS = process.platform === 'win32';
const HOST = {
  linux: 'linux',
  darwin: 'macos',
  win32: 'windows',
  freebsd: 'freebsd',
}[process.platform];

const DEFAULT_BUNDLES = {
  linux: 'deb,appimage',
  macos: 'dmg',
  windows: 'nsis',
};

function help() {
  console.log(`Slamdance Audio desktop builds

Usage:
  node scripts/build.mjs [target] [options]

Targets:
  host       Build for this machine (default)
  linux      Tauri: .deb + AppImage
  macos      Tauri: .dmg and .app
  windows    Tauri: NSIS installer
  freebsd    Electron: runtime-linked FreeBSD .tar.gz
  stage      Only stage the static player into build/web

Options:
  --debug             Tauri debug build instead of release
  --no-bundle         Compile the Tauri binary without an installer
  --no-install        Do not install missing npm build dependencies
  --bundles <list>    Tauri bundle types (comma-separated)
  --triple <target>   Tauri Rust target triple, e.g. aarch64-apple-darwin
  --help              Show this help

Notes:
  Tauri is native software: Linux, macOS, and Windows builds must run on the
  matching operating system (or CI runner), and macOS signing/notarization is
  only available on macOS. The FreeBSD archive can be assembled on any host,
  but it requires Electron at runtime on FreeBSD (e.g. pkg install electron).
`);
}

function fail(message) {
  const error = new Error(message);
  error.userFacing = true;
  throw error;
}

function parseArgs(argv) {
  const options = {
    target: 'host',
    debug: false,
    bundle: true,
    install: true,
    bundles: null,
    triple: null,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--debug') {
      options.debug = true;
    } else if (arg === '--no-bundle') {
      options.bundle = false;
    } else if (arg === '--no-install') {
      options.install = false;
    } else if (arg === '--bundles') {
      options.bundles = argv[++i];
      if (!options.bundles) fail('--bundles needs a comma-separated value');
    } else if (arg.startsWith('--bundles=')) {
      options.bundles = arg.slice('--bundles='.length);
    } else if (arg === '--triple') {
      options.triple = argv[++i];
      if (!options.triple) fail('--triple needs a Rust target triple');
    } else if (arg.startsWith('--triple=')) {
      options.triple = arg.slice('--triple='.length);
    } else if (arg.startsWith('-')) {
      fail('Unknown option: ' + arg);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 1) fail('Only one build target may be given');
  if (positional[0]) options.target = positional[0];

  return options;
}

function run(command, args, opts) {
  const options = { cwd: ROOT, stdio: 'inherit', ...(opts || {}) };
  console.log('[build] ' + command + ' ' + args.join(' '));
  const result = spawnSync(command, args, options);
  if (result.error) {
    fail('Could not run ' + command + ': ' + result.error.message);
  }
  if (result.status !== 0) {
    const error = new Error(command + ' exited with status ' + result.status);
    error.exitCode = result.status;
    throw error;
  }
}

function probe(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function hostPlatform() {
  if (!HOST) fail('Unsupported host platform: ' + process.platform);
  return HOST;
}

function targetPlatform(requested) {
  const host = hostPlatform();
  if (requested === 'host') return host;
  if (requested === 'stage') return 'stage';
  if (!['linux', 'macos', 'windows', 'freebsd'].includes(requested)) {
    fail('Unknown target "' + requested + '". Run with --help for the list.');
  }
  return requested;
}

function requireNativeHost(platform) {
  const host = hostPlatform();
  if (host !== platform) {
    const names = { linux: 'Linux', macos: 'macOS', windows: 'Windows' };
    fail(
      'Tauri ' +
        names[platform] +
        ' builds must run on ' +
        names[platform] +
        '. This host is ' +
        names[host] +
        '. Use a matching machine or CI runner.'
    );
  }
}

function ensureTauriCli(options) {
  const local = path.join(
    ROOT,
    'node_modules',
    '.bin',
    IS_WINDOWS ? 'tauri.cmd' : 'tauri'
  );
  if (existsSync(local)) return local;

  if (!options.install) {
    fail('Tauri CLI is missing. Run npm install, or drop --no-install.');
  }

  const npm = IS_WINDOWS ? 'npm.cmd' : 'npm';
  const lock = path.join(ROOT, 'package-lock.json');
  const args = existsSync(lock) ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'];
  run(npm, args, { shell: IS_WINDOWS });

  if (!existsSync(local)) fail('npm finished but the Tauri CLI is still missing.');
  return local;
}

function checkTauriPrereqs(platform) {
  if (!probe('cargo', ['--version'])) {
    fail('Rust/Cargo is required for Tauri. Install rustup and retry.');
  }
  if (platform !== 'linux') return;

  const libs = ['webkit2gtk-4.1', 'javascriptcoregtk-4.1', 'gtk+-3.0', 'libsoup-3.0'];
  const missing = libs.filter((lib) => !probe('pkg-config', ['--exists', lib]));
  if (missing.length) {
    fail(
      'Missing Tauri Linux development libraries: ' +
        missing.join(', ') +
        '. Install the WebKitGTK 4.1, GTK 3, and libsoup 3 development packages.'
    );
  }
}

function profileDirectory(options) {
  return options.debug ? 'debug' : 'release';
}

function collectTauriArtifacts(platform, options) {
  const profile = profileDirectory(options);
  const targetRoot = path.join(
    ROOT,
    'src-tauri',
    'target',
    ...(options.triple ? [options.triple] : []),
    profile
  );
  const bundleRoot = path.join(targetRoot, 'bundle');
  if (!existsSync(bundleRoot)) {
    fail('Tauri finished but produced no bundle directory: ' + path.relative(ROOT, bundleRoot));
  }

  const destination = path.join(ROOT, 'dist', SLUG + '-' + platform + '-' + process.arch);
  rmSync(destination, { recursive: true, force: true });
  cpSync(bundleRoot, destination, { recursive: true });
  console.log('[build] installers -> ' + path.relative(ROOT, destination));
}

/* On /usr/lib64 distros (Void, Fedora, openSUSE) GTK's pkg-config files say
 * libdir=${prefix}/lib64 while /usr/lib64 is a symlink to /usr/lib. Tauri's
 * linuxdeploy GTK plugin resolves that symlink for its copy step but not for
 * the paths it writes, so it looks for immodules.cache in a directory it never
 * created and the AppImage bundle fails. Handing pkg-config copies whose
 * libdir is the real /usr/lib keeps the plugin's two paths together; the
 * linker only ever sees library names that are present either way. */
function appImageEnv(platform, options) {
  if (platform !== 'linux') return null;
  const bundles = (options.bundles || DEFAULT_BUNDLES.linux || '').split(',');
  if (!bundles.includes('appimage')) return null;

  const overlay = path.join(ROOT, 'build', 'pkgconfig-lib64');
  const patched = [];

  for (const name of ['gtk+-3.0', 'gdk-pixbuf-2.0', 'gio-2.0', 'gtk4']) {
    const where = spawnSync('pkg-config', ['--variable=pcfiledir', name], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (where.status !== 0) continue;

    const source = path.join(where.stdout.trim(), name + '.pc');
    if (!existsSync(source)) continue;
    const text = readFileSync(source, 'utf8');
    if (!text.includes('lib64')) continue;

    if (!patched.length) {
      rmSync(overlay, { recursive: true, force: true });
      mkdirSync(overlay, { recursive: true });
    }
    writeFileSync(
      path.join(overlay, name + '.pc'),
      text.replace(/\$\{prefix\}\/lib64\b/g, '${prefix}/lib').replace(/\/usr\/lib64\b/g, '/usr/lib'),
      'utf8'
    );
    patched.push(name);
  }

  if (!patched.length) return null;

  console.log('[build] pkg-config overlay for linuxdeploy -> ' + patched.join(', '));
  const env = { ...process.env, PKG_CONFIG_PATH: overlay };
  if (process.env.PKG_CONFIG_PATH) env.PKG_CONFIG_PATH += ':' + process.env.PKG_CONFIG_PATH;
  return env;
}

function buildTauri(platform, options) {
  requireNativeHost(platform);
  checkTauriPrereqs(platform);
  const tauri = ensureTauriCli(options);

  const args = ['build'];
  if (options.debug) args.push('--debug');
  if (!options.bundle) {
    args.push('--no-bundle');
  } else {
    args.push('--bundles', options.bundles || DEFAULT_BUNDLES[platform]);
  }
  if (options.triple) args.push('--target', options.triple);

  const env = appImageEnv(platform, options);
  run(tauri, args, env ? { shell: IS_WINDOWS, env } : { shell: IS_WINDOWS });

  if (options.bundle) {
    collectTauriArtifacts(platform, options);
  } else {
    const profile = profileDirectory(options);
    console.log(
      '[build] binary -> ' +
        path.relative(
          ROOT,
          path.join(
            'src-tauri',
            'target',
            ...(options.triple ? [options.triple] : []),
            profile,
            IS_WINDOWS ? 'slamdance-audio.exe' : 'slamdance-audio'
          )
        )
    );
  }
}

function writeFreeBsdLauncher(file) {
  writeFileSync(
    file,
    `#!/bin/sh
set -eu
SELF=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP="$SELF/../resources/app"
ELECTRON="\${ELECTRON_BIN:-electron}"

if ! command -v "$ELECTRON" >/dev/null 2>&1; then
  echo "Slamdance Audio needs Electron on FreeBSD." >&2
  echo "Install it with: doas pkg install electron" >&2
  exit 1
fi

exec "$ELECTRON" "$APP" "$@"
`,
    'utf8'
  );
  chmodSync(file, 0o755);
}

function buildFreeBsd() {
  if (hostPlatform() !== 'freebsd') {
    console.warn(
      '[build] FreeBSD package is runtime-linked; assembling it on ' +
        process.platform +
        ' is supported, but it runs on FreeBSD with Electron installed.'
    );
  }

  const destination = path.join(ROOT, 'dist', SLUG + '-freebsd-' + process.arch);
  rmSync(destination, { recursive: true, force: true });

  const appDir = path.join(destination, 'resources', 'app');
  stageWeb(appDir);
  cpSync(path.join(ROOT, 'electron', 'main.cjs'), path.join(appDir, 'main.cjs'));
  cpSync(path.join(ROOT, 'electron', 'preload.cjs'), path.join(appDir, 'preload.cjs'));

  writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify(
      {
        name: SLUG,
        productName: PKG.productName || 'Slamdance Audio',
        version: PKG.version || '0.0.1+r1',
        description: PKG.description || '',
        main: 'main.cjs',
        private: true,
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  const binDir = path.join(destination, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFreeBsdLauncher(path.join(binDir, SLUG));

  writeFileSync(
    path.join(destination, 'README-FreeBSD.txt'),
    `Slamdance Audio — FreeBSD Electron build

This archive uses the Electron runtime already installed on FreeBSD.
It does not contain a private copy of Electron.

Install the runtime:
  doas pkg install electron

Run the player:
  ./bin/${SLUG}

To use a specific Electron executable:
  ELECTRON_BIN=/path/to/electron ./bin/${SLUG}
`,
    'utf8'
  );

  const tarball = path.join(ROOT, 'dist', SLUG + '-freebsd-' + process.arch + '.tar.gz');
  rmSync(tarball, { force: true });
  run('tar', [
    '-czf',
    tarball,
    '-C',
    path.dirname(destination),
    path.basename(destination),
  ]);

  console.log('[build] FreeBSD app -> ' + path.relative(ROOT, destination));
  console.log('[build] FreeBSD archive -> ' + path.relative(ROOT, tarball));
}

function build(options) {
  const platform = targetPlatform(options.target);

  if (platform === 'stage') {
    const out = stageWeb();
    console.log('[build] staged web -> ' + path.relative(ROOT, out));
    return;
  }

  if (platform === 'freebsd') {
    buildFreeBsd(options);
    return;
  }

  buildTauri(platform, options);
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  help();
  process.exit(0);
}

try {
  build(options);
} catch (error) {
  console.error('[build] ' + (error && error.message ? error.message : error));
  if (error && error.userFacing) {
    console.error('[build] See: node scripts/build.mjs --help');
  }
  process.exit(error && typeof error.exitCode === 'number' ? error.exitCode : 1);
}
