#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
# Provide libudev.so.1 (chromium dep) via local symlink to systemd's real lib
export LD_LIBRARY_PATH="$PWD/locallib:$LD_LIBRARY_PATH"
export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1
export TARGET_URL="${TARGET_URL:-http://localhost:5000}"
exec node "${1:-harness.mjs}"
