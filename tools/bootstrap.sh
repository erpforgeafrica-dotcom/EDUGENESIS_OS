#!/usr/bin/env sh
# EduGenesis OS — portable bootstrap (POSIX: Linux, macOS, WSL, Git Bash).
#
# Makes this folder runnable on a machine that has never seen this project:
#
#   1. Work out the required Node version from the root package.json.
#   2. Use the portable runtime in .toolchain/ if it is new enough.
#   3. Otherwise use a system Node if it is new enough.
#   4. Otherwise DOWNLOAD a portable Node runtime INTO THIS FOLDER
#      (.toolchain/). Nothing is ever installed globally.
#   5. Run "npm install" when node_modules is absent.
#   6. Run "npm run build".
#
# Every path is derived from this script's own location. No absolute path,
# user name or drive letter appears here, so the folder can be copied anywhere.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(dirname -- "$SCRIPT_DIR")
TOOLCHAIN_DIR="$ROOT/.toolchain"
NODE_DIR="$TOOLCHAIN_DIR/node"
MANIFEST="$ROOT/package.json"

step() { printf '==> %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }
bad()  { printf 'ERROR: %s\n' "$1" >&2; exit 1; }

# --- 1. the required Node version -------------------------------------------

[ -f "$MANIFEST" ] || bad "package.json not found at the project root."

REQUIRED_TEXT=$(sed -n 's/.*"node"[[:space:]]*:[[:space:]]*">=\{0,1\}v\{0,1\}\([0-9][0-9.]*\)".*/\1/p' "$MANIFEST" | head -n 1)
[ -n "$REQUIRED_TEXT" ] || bad "Could not read engines.node from package.json."

version_ge() {
  # $1 >= $2 ? (numeric, dotted)
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -n 1)" = "$2" ]
}

step "Required Node version: >= $REQUIRED_TEXT"

# --- 2. locate a usable Node ------------------------------------------------

node_version() {
  "$1" --version 2>/dev/null | sed 's/^v//'
}

NODE_BIN=""
NODE_VERSION=""

if [ -x "$NODE_DIR/bin/node" ]; then
  candidate=$(node_version "$NODE_DIR/bin/node" || true)
  if [ -n "$candidate" ] && version_ge "$candidate" "$REQUIRED_TEXT"; then
    NODE_BIN="$NODE_DIR/bin/node"
    NODE_VERSION="$candidate"
    info "Using the portable runtime in .toolchain ($candidate)."
  fi
fi

if [ -z "$NODE_BIN" ] && command -v node >/dev/null 2>&1; then
  candidate=$(node_version "$(command -v node)" || true)
  if [ -n "$candidate" ] && version_ge "$candidate" "$REQUIRED_TEXT"; then
    NODE_BIN=$(command -v node)
    NODE_VERSION="$candidate"
    info "Using the system Node at $NODE_BIN ($candidate)."
  elif [ -n "$candidate" ]; then
    info "The system Node ($candidate) is older than $REQUIRED_TEXT."
  fi
fi

# --- 3. download a portable Node into this folder ---------------------------

portable_version() {
  pinned="${EDUGENESIS_NODE_VERSION:-22.11.0}"
  pinned=$(printf '%s' "$pinned" | sed 's/^v//')
  if command -v curl >/dev/null 2>&1; then
    index=$(curl -fsSL --max-time 30 https://nodejs.org/dist/index.json 2>/dev/null || true)
    found=$(printf '%s' "$index" | sed -n 's/.*"version":"v\(22\.[0-9.]*\)".*"lts":[^,]*true.*/\1/p' | head -n 1)
    if [ -n "$found" ]; then printf '%s' "$found"; return; fi
  fi
  printf '%s' "$pinned"
}

install_portable_node() {
  version=$(portable_version)
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  case "$os" in
    linux)  os_name=linux ;;
    darwin) os_name=darwin ;;
    *) bad "Unsupported operating system: $os" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    armv7l) arch=armv7l ;;
    *) bad "Unsupported architecture: $(uname -m)" ;;
  esac

  archive="node-v$version-$os_name-$arch.tar.gz"
  url="https://nodejs.org/dist/v$version/$archive"

  step "Downloading a portable Node runtime into .toolchain"
  info "$url"

  mkdir -p "$TOOLCHAIN_DIR"
  archive_path="$TOOLCHAIN_DIR/$archive"
  staging="$TOOLCHAIN_DIR/node-v$version-$os_name-$arch"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 300 "$url" -o "$archive_path" || bad "Could not download the portable Node runtime."
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$archive_path" || bad "Could not download the portable Node runtime."
  else
    bad "Neither curl nor wget is available to download the portable Node runtime."
  fi

  info "Extracting..."
  tar -xzf "$archive_path" -C "$TOOLCHAIN_DIR"
  rm -f "$archive_path"

  [ -x "$staging/bin/node" ] || bad "The archive did not contain the expected runtime."
  rm -rf "$NODE_DIR"
  mv "$staging" "$NODE_DIR"

  info "Portable Node $version is now in .toolchain/node."
}

if [ -z "$NODE_BIN" ]; then
  install_portable_node
  NODE_BIN="$NODE_DIR/bin/node"
  NODE_VERSION=$(node_version "$NODE_BIN" || true)
  [ -n "$NODE_VERSION" ] && version_ge "$NODE_VERSION" "$REQUIRED_TEXT" \
    || bad "The portable runtime is still older than $REQUIRED_TEXT."
  info "Portable Node $NODE_VERSION is ready."
fi

# Put the chosen Node first on PATH so npm and every child process use it.
NODE_DIR_BIN=$(dirname -- "$NODE_BIN")
PATH="$NODE_DIR_BIN:$PATH"
export PATH

command -v npm >/dev/null 2>&1 || bad "npm was not found next to the selected Node runtime."

# --- 4. install dependencies ------------------------------------------------

if [ ! -d "$ROOT/node_modules" ]; then
  step "Installing dependencies (npm install)"
  (cd "$ROOT" && npm install) || bad "npm install failed."
else
  step "Dependencies are already installed (node_modules is present)."
fi

# --- 5. build ---------------------------------------------------------------

step "Building (npm run build)"
(cd "$ROOT" && npm run build) || bad "npm run build failed."

step "Bootstrap complete."
info "node apps/cli/dist/doctor.js   # environment check"
info "node apps/cli/dist/serve.js    # local server and Settings UI"
