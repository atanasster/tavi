#!/bin/sh
# Installs a prebuilt Tavi from a GitHub Release, for people who are not
# building it from source:
#
#   curl -fsSL https://github.com/atanasster/tavi/releases/latest/download/install.sh | sh
#
# It needs Node.js 22.22.2 or later with npm, on macOS, Linux or WSL2. Every
# file is checked against the release's SHA256SUMS before anything is
# installed. The packages go into one private tree ($TAVI_HOME/app, never the
# global npm prefix), so no @tavi package is ever looked up on the npm
# registry, and `tavi` is linked into $TAVI_BIN_DIR. Running it again
# installs the newer release in place; your data directory is not touched.
#
# Settings, from the environment:
#   TAVI_VERSION        a release such as 0.1.0 (default: the latest)
#   TAVI_HOME           where the app is kept (default: ~/.tavi)
#   TAVI_BIN_DIR        where `tavi` is linked (default: ~/.local/bin)
#   TAVI_SKIP_CHROMIUM  1 skips the browser tools (Playwright and its Chromium)
#   TAVI_RELEASE_BASE   a URL or local folder to install from instead of GitHub
set -eu

NODE_FLOOR="22.22.2"
REPOSITORY="atanasster/tavi"

say() { printf 'tavi: %s\n' "$*"; }
fail() {
  printf 'tavi: %s\n' "$*" >&2
  exit 1
}

case "$(uname -s)" in
Darwin | Linux) ;;
*) fail "this installer runs on macOS, Linux or WSL2; on Windows, install from source (docs/WINDOWS.md)" ;;
esac

# Node and npm, at the version every package's engines field asks for.
command -v node >/dev/null 2>&1 || fail "Node.js $NODE_FLOOR or later is needed: https://nodejs.org"
command -v npm >/dev/null 2>&1 || fail "npm is needed (it comes with Node.js)"
node_version="$(node -p 'process.versions.node')"
if ! node -e '
  const [a, b] = process.argv.slice(1).map((v) => v.split(".").map(Number));
  const difference = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  process.exit(difference >= 0 ? 0 : 1);
' "$node_version" "$NODE_FLOOR"; then
  fail "Node.js $node_version is too old: Tavi needs $NODE_FLOOR or later (https://nodejs.org)"
fi

version="${TAVI_VERSION:-}"
version="${version#v}"
if [ -n "${TAVI_RELEASE_BASE:-}" ]; then
  base="$TAVI_RELEASE_BASE"
elif [ -n "$version" ]; then
  base="https://github.com/$REPOSITORY/releases/download/v$version"
else
  base="https://github.com/$REPOSITORY/releases/latest/download"
fi
home="${TAVI_HOME:-$HOME/.tavi}"
bin="${TAVI_BIN_DIR:-$HOME/.local/bin}"

# A URL is downloaded; anything else is a local folder (a release packed with scripts/pack-release.mjs).
fetch() {
  case "$base" in
  http://* | https://*)
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL --retry 3 -o "$2" "$base/$1" || fail "could not download $base/$1"
    elif command -v wget >/dev/null 2>&1; then
      wget -q -O "$2" "$base/$1" || fail "could not download $base/$1"
    else
      fail "curl or wget is needed to download the release"
    fi
    ;;
  *) cp "$base/$1" "$2" 2>/dev/null || fail "$base/$1 is not there" ;;
  esac
}

work="$(mktemp -d "${TMPDIR:-/tmp}/tavi-install.XXXXXX")"
trap 'rm -rf "$work"' EXIT INT TERM

say "downloading the release from $base"
fetch SHA256SUMS "$work/SHA256SUMS"
tarballs="$(awk '$2 ~ /\.tgz$/ { print $2 }' "$work/SHA256SUMS")"
[ -n "$tarballs" ] || fail "the release's SHA256SUMS lists no packages"
for name in $tarballs; do
  case "$name" in
  */* | .*) fail "the release's SHA256SUMS names an unexpected file: $name" ;;
  esac
  fetch "$name" "$work/$name"
done

# Every package is checked before anything is installed.
grep '\.tgz$' "$work/SHA256SUMS" >"$work/packages.sha256"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$work" && sha256sum -c --quiet packages.sha256) || fail "a downloaded package does not match SHA256SUMS; nothing was installed"
elif command -v shasum >/dev/null 2>&1; then
  (cd "$work" && shasum -a 256 -c --quiet packages.sha256) || fail "a downloaded package does not match SHA256SUMS; nothing was installed"
else
  fail "sha256sum or shasum is needed to check the download"
fi

# Installed beside the current app, then swapped in: a failed install leaves the one before it working.
mkdir -p "$home"
staging="$home/app.new"
rm -rf "$staging"
mkdir -p "$staging"
printf '{ "name": "tavi-app", "private": true, "version": "0.0.0" }\n' >"$staging/package.json"
say "installing (npm install; this takes a minute or two)"
set --
for name in $tarballs; do set -- "$@" "$work/$name"; done
if ! (cd "$staging" && npm_config_update_notifier=false npm install --no-audit --no-fund --loglevel=error "$@"); then
  rm -rf "$staging"
  fail "npm install failed; the Tavi installed before, if any, is unchanged"
fi
[ -x "$staging/node_modules/.bin/tavi" ] || fail "the installed packages have no tavi command"
# The browser tools: Playwright at the version the browser plugin asks for, beside the CLI (the core install
# leaves it out), and its Chromium. Neither is ever a reason for the install to fail.
browser_later="cd $home/app && npm install playwright@<version> && npx playwright install chromium"
case "${TAVI_SKIP_CHROMIUM:-}" in
"" | 0 | false)
  wanted="$(cd "$staging" && node -p 'require("@tavi/plugin-browser/package.json").peerDependencies.playwright' 2>/dev/null || true)"
  say "adding Playwright and Chromium for the browser tools"
  if [ -n "$wanted" ] && (cd "$staging" && npm_config_update_notifier=false npm install --no-audit --no-fund --loglevel=error "playwright@$wanted"); then
    node "$staging/node_modules/playwright/cli.js" install chromium >/dev/null 2>&1 ||
      say "Chromium could not be downloaded now; later: cd $home/app && npx playwright install chromium"
  else
    say "Playwright could not be installed now; the browser tools stay off until: $browser_later"
  fi
  ;;
*) say "browser tools skipped (TAVI_SKIP_CHROMIUM); later: $browser_later" ;;
esac

rm -rf "$home/app.old"
[ -d "$home/app" ] && mv "$home/app" "$home/app.old"
mv "$staging" "$home/app"
rm -rf "$home/app.old"

mkdir -p "$bin"
ln -sf "$home/app/node_modules/.bin/tavi" "$bin/tavi"

say "installed $("$bin/tavi" --version 2>/dev/null || echo tavi) in $home/app"
case ":$PATH:" in
*":$bin:"*) ;;
*) say "add $bin to your PATH, e.g. echo 'export PATH=\"$bin:\$PATH\"' >> ~/.profile" ;;
esac
say "next: tavi setup"
