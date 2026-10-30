#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { printf '%s\n' 'Node.js 22.5+ is required. Install it from https://nodejs.org, then run install.sh again.' >&2; exit 1; }
node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 5)) { console.error('Node.js 22.5+ required; found ' + process.versions.node); process.exit(1); }"
[ -f .env ] || cp .env.example .env
mkdir -p data
npm link
node bin/norouter.js install
