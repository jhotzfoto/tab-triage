#!/bin/bash
# Tab Triage: run the automated tests. Double-click in Finder, or run it in Terminal.
# Needs Node (https://nodejs.org or: brew install node). The test tool (jsdom) installs once into the
# build folder next to the project; nothing is installed system-wide.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -d "$HERE/extension" ]; then ROOT="$HERE"; TESTS="$ROOT/tests"; WORK="$ROOT/build"
else ROOT="$(cd "$HERE/.." && pwd)"; TESTS="$HERE/tests"; WORK="$ROOT/99_Build_Workspace.nosync"; fi
TOOLS="$WORK/test_tools"
# Keep npm's download cache and logs inside the project too (default is ~/.npm).
export npm_config_cache="$WORK/npm_cache" npm_config_update_notifier=false
command -v npm >/dev/null 2>&1 || { echo "ERROR: Node isn't installed. Get it from https://nodejs.org or run: brew install node"; exit 1; }
if [ ! -d "$TOOLS/node_modules/jsdom" ]; then
  echo "Installing test tools (one time)..."
  mkdir -p "$TOOLS"
  npm install --prefix "$TOOLS" --no-audit --no-fund --silent jsdom@24.1.3
fi
NODE_PATH="$TOOLS/node_modules" node "$TESTS/run.js"
