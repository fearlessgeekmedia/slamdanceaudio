#!/bin/sh
# Slamdance Audio — package builder.
#
#   ./build.sh              # build for this machine (Linux .deb + AppImage, macOS .dmg, Windows installer)
#   ./build.sh linux        # Tauri: .deb + AppImage
#   ./build.sh macos        # Tauri: .dmg and .app (must run on macOS)
#   ./build.sh windows      # Tauri: NSIS installer (must run on Windows)
#   ./build.sh freebsd      # Electron: runtime-linked FreeBSD .tar.gz + .pkg
#   ./build.sh stage        # only refresh build/web
#   ./build.sh --help       # every option
#
# This is a thin wrapper around scripts/build.mjs; all arguments are passed through.

set -eu

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "build.sh: Node.js 20 or newer is required. Install Node, then run ./build.sh again." >&2
  exit 1
fi

if ! node -e 'const major = Number(process.versions.node.split(".")[0]); process.exit(major >= 20 ? 0 : 1)'; then
  echo "build.sh: found Node $(node -v), but Slamdance Audio needs Node 20 or newer." >&2
  exit 1
fi

# First bare argument is the target; options may come before it.
target=host
skip_next=0
for argument in "$@"; do
  if [ "$skip_next" = 1 ]; then
    skip_next=0
    continue
  fi
  case "$argument" in
    -h|--help|help)
      exec node scripts/build.mjs --help
      ;;
    --bundles|--triple)
      skip_next=1
      ;;
    -*) ;;
    *)
      target="$argument"
      break
      ;;
  esac
done

# The Tauri CLI is a devDependency; staging needs nothing but Node.
if [ "$target" != "stage" ] && [ ! -x node_modules/.bin/tauri ]; then
  case " $* " in
    *" --no-install "*) ;;
    *)
      echo "build.sh: installing build dependencies (npm install)..."
      npm install
      ;;
  esac
fi

exec node scripts/build.mjs "$@"
