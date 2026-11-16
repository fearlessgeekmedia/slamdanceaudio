#!/usr/bin/env node

/*
 * Slamdance Audio — desktop builds.
 *
 * Linux, macOS, and Windows use Tauri and must be built on their matching OS.
 * FreeBSD uses the Electron runtime from the FreeBSD ports/package tree; the
 * resulting archive and pkg contain the app and launcher, not an Electron
 * binary (Electron ships as a package dependency instead).
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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
  freebsd    Electron: runtime-linked FreeBSD .tar.gz + .pkg
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
  but it runs on FreeBSD with Electron installed (a dependency of the .pkg;
  for the .tar.gz: e.g. pkg install devel/electron44). The .pkg itself needs
  pkg(8), so it is only produced on FreeBSD.
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

/* Git for Windows and MSYS2 ship a coreutils program called link.exe in
 * usr/bin. It has nothing to do with linking, but Git Bash puts /usr/bin ahead
 * of the MSVC toolchain on PATH, so cargo's `-C linker=link.exe` runs the
 * hardlink tool and dies with "link: extra operand". Rather than ask the user
 * to reorder PATH, resolve the real MSVC linker and pass it to cargo. */
const MSYS_TOOL_DIRECTORY = /[\\/](?:usr[\\/]bin|msys\d*|mingw(?:32|64))[\\/]?$/i;

function isMsysDirectory(directory) {
  if (MSYS_TOOL_DIRECTORY.test(directory)) return true;
  // MSYS tool directories always keep a shell next to their tools; VC does not.
  return existsSync(path.join(directory, 'bash.exe'));
}

function windowsTriple(options) {
  if (options.triple) return options.triple;
  return process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
}

function msvcLinkerFromPath() {
  const directories = (process.env.PATH || process.env.Path || '').split(path.delimiter);
  const found = [];
  for (const directory of directories) {
    if (!directory || isMsysDirectory(directory)) continue;
    const linker = path.join(directory, 'link.exe');
    if (existsSync(linker)) found.push(linker);
  }
  return found.find((linker) => /[\\/]VC[\\/]Tools[\\/]MSVC[\\/]/i.test(linker)) || found[0] || null;
}

// Visual Studio installs do not put link.exe on the global PATH, and Winboat
// images may only have the Build Tools. vswhere knows where they live.
function msvcLinkerFromVisualStudio(options) {
  const vswhere = path.join(
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe'
  );
  if (!existsSync(vswhere)) return null;

  const result = spawnSync(
    vswhere,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
    ],
    { cwd: ROOT, encoding: 'utf8' }
  );
  if (result.error || result.status !== 0) return null;

  const installation = String(result.stdout || '').split(/\r?\n/)[0].trim();
  if (!installation) return null;

  const tools = path.join(installation, 'VC', 'Tools', 'MSVC');
  if (!existsSync(tools)) return null;

  const host = process.arch === 'arm64' ? 'Hostarm64' : 'Hostx64';
  const machine = windowsTriple(options).startsWith('aarch64') ? 'arm64' : 'x64';
  const versions = readdirSync(tools)
    .filter((name) => /^\d+(\.\d+)+$/.test(name))
    .sort((a, b) => {
      const left = a.split('.').map(Number);
      const right = b.split('.').map(Number);
      for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
        if ((left[i] || 0) !== (right[i] || 0)) return (right[i] || 0) - (left[i] || 0);
      }
      return 0;
    });

  for (const version of versions) {
    const linker = path.join(tools, version, 'bin', host, machine, 'link.exe');
    if (existsSync(linker)) return linker;
  }
  return null;
}

function msvcLinkerEnv(platform, options) {
  if (platform !== 'windows') return null;

  const variable =
    'CARGO_TARGET_' + windowsTriple(options).replace(/-/g, '_').toUpperCase() + '_LINKER';
  if (process.env[variable]) {
    console.log('[build] using ' + variable + ' from the environment');
    return null;
  }

  const linker = msvcLinkerFromPath() || msvcLinkerFromVisualStudio(options);
  if (!linker) {
    fail(
      'No Microsoft C++ linker (link.exe) was found, so the Tauri build cannot link.\n' +
        '  Install the Visual Studio Build Tools "Desktop development with C++" workload,\n' +
        '  then run this again. (Git for Windows also ships a link.exe in usr/bin that is\n' +
        '  a coreutils hardlink tool, not a linker; that is what fails with\n' +
        '  "link: extra operand".)'
    );
  }

  console.log('[build] MSVC linker -> ' + linker);
  return { [variable]: linker };
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

/* npm writes the .bin shims executable, but a node_modules that was copied,
 * restored from a backup, or unpacked with a permissive umask can come back
 * mode 0666. spawnSync then fails with EACCES before the CLI ever starts, and
 * the error looks like a missing tool rather than a missing permission bit. */
function ensureExecutable(file) {
  if (IS_WINDOWS) return file;
  try {
    if ((statSync(file).mode & 0o111) !== 0) return file;
    chmodSync(file, 0o755);
    console.log('[build] repaired missing execute bit on ' + path.relative(ROOT, file));
  } catch (err) {
    // Missing or read-only: the spawn that follows reports the real problem.
  }
  return file;
}

function ensureTauriCli(options) {
  const local = path.join(
    ROOT,
    'node_modules',
    '.bin',
    IS_WINDOWS ? 'tauri.cmd' : 'tauri'
  );
  if (existsSync(local)) return ensureExecutable(local);

  if (!options.install) {
    fail('Tauri CLI is missing. Run npm install, or drop --no-install.');
  }

  const npm = IS_WINDOWS ? 'npm.cmd' : 'npm';
  const lock = path.join(ROOT, 'package-lock.json');
  const args = existsSync(lock) ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'];
  run(npm, args, { shell: IS_WINDOWS });

  if (!existsSync(local)) fail('npm finished but the Tauri CLI is still missing.');
  return ensureExecutable(local);
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

  let env = appImageEnv(platform, options);
  const linker = msvcLinkerEnv(platform, options);
  if (linker) env = { ...(env || process.env), ...linker };
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
# FreeBSD's Electron ports install versioned binaries (electron44, ...), so
# honour ELECTRON_BIN first and otherwise use the newest Electron on PATH.
ELECTRON="\${ELECTRON_BIN:-}"
if [ -z "$ELECTRON" ]; then
  for candidate in ${ELECTRON_CANDIDATES.join(' ')} electron; do
    if command -v "$candidate" >/dev/null 2>&1; then
      ELECTRON="$candidate"
      break
    fi
  done
fi

if [ -z "$ELECTRON" ] || ! command -v "$ELECTRON" >/dev/null 2>&1; then
  echo "Slamdance Audio needs Electron on FreeBSD." >&2
  echo "Install it with: doas pkg install devel/electron44" >&2
  exit 1
fi

exec "$ELECTRON" "$APP" "$@"
`,
    'utf8'
  );
  chmodSync(file, 0o755);
}

const FREEBSD_ORIGIN = 'audio/slamdance-audio';
const FREEBSD_CATEGORY = 'audio';
const FREEBSD_WWW_FALLBACK = 'https://github.com/fearlessgeekmedia/slamdanceaudio';
const ELECTRON_CANDIDATES = ['electron44', 'electron43', 'electron42', 'electron41'];

function readTauriConf() {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  } catch (err) {
    return {};
  }
}

function freeBsdPkgVersion() {
  return PKG.version || '0.0.2';
}

function freeBsdRepoUrl() {
  const repo = PKG.repository;
  if (typeof repo === 'string' && repo) return repo;
  if (repo && typeof repo.url === 'string' && repo.url) {
    return repo.url.replace(/^git\+/, '');
  }
  if (typeof PKG.homepage === 'string' && PKG.homepage) return PKG.homepage;
  return FREEBSD_WWW_FALLBACK;
}

function pkgBinary() {
  if (probe('pkg', ['--version'])) return 'pkg';
  if (probe('/usr/sbin/pkg', ['--version'])) return '/usr/sbin/pkg';
  return null;
}

// Newest Electron port first; pkg install resolves the dependency by origin,
// so a missing version just means "any".
function probeElectronDep(pkgBin) {
  for (const name of ELECTRON_CANDIDATES) {
    const result = spawnSync(pkgBin, ['rquery', '%v', name], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (!result.error && result.status === 0) {
      const version = String(result.stdout || '').split('\n')[0].trim();
      if (version) return { name, origin: 'devel/' + name, version };
    }
  }
  const name = ELECTRON_CANDIDATES[0];
  return { name, origin: 'devel/' + name, version: null };
}

function writeFreeBsdInstalledLauncher(file, appPath) {
  writeFileSync(
    file,
    `#!/bin/sh
set -eu
APP=${JSON.stringify(appPath)}
# FreeBSD's Electron ports install versioned binaries (electron44, ...), so
# honour ELECTRON_BIN first and otherwise use the newest Electron on PATH.
ELECTRON="\${ELECTRON_BIN:-}"
if [ -z "$ELECTRON" ]; then
  for candidate in ${ELECTRON_CANDIDATES.join(' ')} electron; do
    if command -v "$candidate" >/dev/null 2>&1; then
      ELECTRON="$candidate"
      break
    fi
  done
fi

if [ -z "$ELECTRON" ] || ! command -v "$ELECTRON" >/dev/null 2>&1; then
  echo "Slamdance Audio needs Electron on FreeBSD." >&2
  echo "Install it with: doas pkg install devel/electron44" >&2
  exit 1
fi

exec "$ELECTRON" "$APP" "$@"
`,
    'utf8'
  );
  chmodSync(file, 0o755);
}

function writeFreeBsdDesktop(file, execPath, comment) {
  writeFileSync(
    file,
    '[Desktop Entry]\n' +
      'Type=Application\n' +
      'Name=Slamdance Audio\n' +
      'Comment=' + comment + '\n' +
      'Exec=' + execPath + '\n' +
      'Icon=' + SLUG + '\n' +
      'Terminal=false\n' +
      'Categories=AudioVideo;Audio;Player;\n' +
      'StartupWMClass=' + SLUG + '\n',
    'utf8'
  );
}

function collectRelativeFiles(base) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        found.push(path.relative(base, full).split(path.sep).join('/'));
      }
    }
  };
  walk(base);
  found.sort();
  return found;
}

function writeFreeBsdManifest(file, electronDep) {
  const tauri = readTauriConf();
  const bundle = (tauri && tauri.bundle) || {};
  const comment = bundle.shortDescription || PKG.description || 'Offline-first music player';
  const desc = bundle.longDescription || PKG.description || comment;
  const lines = [
    'name = ' + JSON.stringify(SLUG),
    'version = ' + JSON.stringify(freeBsdPkgVersion()),
    'origin = ' + JSON.stringify(FREEBSD_ORIGIN),
    'comment = ' + JSON.stringify(comment),
    'desc = ' + JSON.stringify(desc),
    'maintainer = ' + JSON.stringify('Fearless Geek Media'),
    'www = ' + JSON.stringify(freeBsdRepoUrl()),
    'prefix = ' + JSON.stringify('/usr/local'),
    'licenselogic = ' + JSON.stringify('single'),
    'licenses = ["MIT"]',
    'categories = [' + JSON.stringify(FREEBSD_CATEGORY) + ']',
  ];
  if (electronDep) {
    lines.push('deps = {');
    lines.push('  ' + electronDep.name + ' = {');
    if (electronDep.version) {
      lines.push('    version = ' + JSON.stringify(electronDep.version));
    }
    lines.push('    origin = ' + JSON.stringify(electronDep.origin));
    lines.push('  }');
    lines.push('}');
  }
  writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

// Assembles the installable FreeBSD package from the staged app directory:
// /usr/local/share/<slug> plus a /usr/local/bin launcher, a desktop entry,
// and icons. Needs pkg(8), so it only runs on FreeBSD; elsewhere the .tar.gz
// is still produced and this step is skipped with a warning.
function buildFreeBsdPkg(appDir) {
  const pkgBin = pkgBinary();
  if (!pkgBin) {
    console.warn(
      '[build] pkg(8) not found; skipping the FreeBSD .pkg ' +
        '(the .tar.gz above works anywhere). Build on FreeBSD for the .pkg.'
    );
    return;
  }

  const electronDep = probeElectronDep(pkgBin);
  console.log(
    '[build] FreeBSD runtime dependency -> ' +
      electronDep.origin +
      (electronDep.version ? ' ' + electronDep.version : '')
  );

  const tauri = readTauriConf();
  const identifier = tauri.identifier || 'media.fearlessgeek.slamdanceaudio';
  const shortDesc =
    (tauri.bundle && tauri.bundle.shortDescription) || 'Offline-first music player';

  const pkgStage = path.join(ROOT, 'build', 'freebsd-pkg-stage');
  rmSync(pkgStage, { recursive: true, force: true });
  const prefixRoot = path.join(pkgStage, 'usr', 'local');
  mkdirSync(path.join(prefixRoot, 'share'), { recursive: true });

  const appInstallDir = path.join(prefixRoot, 'share', SLUG);
  cpSync(appDir, appInstallDir, { recursive: true });

  const binDir = path.join(prefixRoot, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFreeBsdInstalledLauncher(path.join(binDir, SLUG), '/usr/local/share/' + SLUG);

  const applicationsDir = path.join(prefixRoot, 'share', 'applications');
  mkdirSync(applicationsDir, { recursive: true });
  writeFreeBsdDesktop(
    path.join(applicationsDir, identifier + '.desktop'),
    '/usr/local/bin/' + SLUG,
    shortDesc
  );

  const iconSources = [
    ['32x32', '32x32.png'],
    ['64x64', '64x64.png'],
    ['128x128', '128x128.png'],
    ['256x256', '128x128@2x.png'],
  ];
  for (const [size, src] of iconSources) {
    const from = path.join(ROOT, 'src-tauri', 'icons', src);
    if (!existsSync(from)) continue;
    const dir = path.join(prefixRoot, 'share', 'icons', 'hicolor', size, 'apps');
    mkdirSync(dir, { recursive: true });
    cpSync(from, path.join(dir, SLUG + '.png'));
  }
  const svgFrom = path.join(ROOT, 'src-tauri', 'icons', 'icon.svg');
  if (existsSync(svgFrom)) {
    const dir = path.join(prefixRoot, 'share', 'icons', 'hicolor', 'scalable', 'apps');
    mkdirSync(dir, { recursive: true });
    cpSync(svgFrom, path.join(dir, SLUG + '.svg'));
  }

  const manifestPath = path.join(ROOT, 'build', 'freebsd-manifest.ucl');
  writeFreeBsdManifest(manifestPath, electronDep);

  const files = collectRelativeFiles(prefixRoot);
  if (!files.length) fail('FreeBSD pkg stage is empty; refusing to pack.');
  const plistPath = path.join(ROOT, 'build', 'freebsd-plist');
  writeFileSync(plistPath, files.join('\n') + '\n', 'utf8');

  run(pkgBin, [
    'create',
    '-M', manifestPath,
    '-r', pkgStage,
    '-p', plistPath,
    '-o', path.join(ROOT, 'dist'),
  ]);

  const produced = path.join(ROOT, 'dist', SLUG + '-' + freeBsdPkgVersion() + '.pkg');
  const branded = path.join(ROOT, 'dist', SLUG + '-freebsd-' + process.arch + '.pkg');
  if (produced !== branded) {
    rmSync(branded, { force: true });
    if (existsSync(produced)) {
      cpSync(produced, branded);
      rmSync(produced);
    }
  }
  if (!existsSync(branded)) fail('pkg create finished but produced no .pkg: ' + branded);
  console.log('[build] FreeBSD pkg -> ' + path.relative(ROOT, branded));
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
        version: PKG.version || '0.0.2',
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
  doas pkg install devel/electron44

Run the player:
  ./bin/${SLUG}

To use a specific Electron executable:
  ELECTRON_BIN=/path/to/electron ./bin/${SLUG}

Prefer a managed install? The matching .pkg (built alongside this archive
on FreeBSD) declares Electron as a dependency and installs to /usr/local:
  doas pkg install /path/to/${SLUG}-freebsd-*.pkg
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

  buildFreeBsdPkg(appDir);
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
