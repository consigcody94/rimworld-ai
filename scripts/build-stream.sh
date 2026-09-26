#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/stream-app/bin"
swiftc -O "$ROOT/stream-app/capture-window.swift" -o "$ROOT/stream-app/bin/capture-window"
clang -O2 "$ROOT/stream-app/native/relay.c" -o "$ROOT/stream-app/bin/rtmps-relay" \
  -I/opt/homebrew/include -L/opt/homebrew/lib -lavformat -lavcodec -lavutil
echo "Built capture and RTMPS relay."
