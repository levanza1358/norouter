#!/usr/bin/env sh
set -eu

REPO_URL=${NOROUTER_REPO_URL:-https://github.com/levanza1358/norouter.git}
INSTALL_DIR=${NOROUTER_DIR:-"$HOME/norouter"}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -f "$SCRIPT_DIR/package.json" ] && [ -f "$SCRIPT_DIR/bin/norouter.js" ]; then
  INSTALL_DIR=$SCRIPT_DIR
elif [ ! -e "$INSTALL_DIR" ]; then
  command -v git >/dev/null 2>&1 || { printf '%s\n' 'Git is required. Install it with: sudo apt update && sudo apt install -y git' >&2; exit 1; }
  git clone "$REPO_URL" "$INSTALL_DIR"
elif [ ! -f "$INSTALL_DIR/package.json" ] || [ ! -f "$INSTALL_DIR/bin/norouter.js" ]; then
  printf '%s\n' "Install directory exists but is not a norouter checkout: $INSTALL_DIR" >&2
  exit 1
fi

cd "$INSTALL_DIR"
command -v node >/dev/null 2>&1 || { printf '%s\n' 'Node.js 22.5+ is required. Install it from https://nodejs.org, then run install.sh again.' >&2; exit 1; }
node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 5)) { console.error('Node.js 22.5+ required; found ' + process.versions.node); process.exit(1); }"
[ -f .env ] || cp .env.example .env
mkdir -p data
npm link
node bin/norouter.js install
