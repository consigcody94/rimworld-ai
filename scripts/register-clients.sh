#!/usr/bin/env bash
# Register the RimWorld MCP server with every AI client found on this Mac.
# Idempotent: re-running updates the existing entry.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTRY="$ROOT/mcp/dist/index.js"
[ -f "$ENTRY" ] || { echo "Build first: (cd $ROOT/mcp && npm install && npm run build)"; exit 1; }
NODE="$(command -v node)"

echo "== Claude Code (user scope)"
if command -v claude >/dev/null; then
  claude mcp remove -s user rimworld >/dev/null 2>&1 || true
  claude mcp add -s user rimworld -- "$NODE" "$ENTRY" && echo "   registered: rimworld"
else
  echo "   claude CLI not found; add manually: claude mcp add -s user rimworld -- $NODE $ENTRY"
fi

upsert_json() {
  local file="$1"
  python3 - "$file" "$NODE" "$ENTRY" <<'EOF'
import json, os, sys
file, node, entry = sys.argv[1:4]
cfg = {}
if os.path.exists(file):
    try:
        with open(file) as f: cfg = json.load(f)
    except Exception: cfg = {}
servers = cfg.setdefault("mcpServers", {})
servers["rimworld"] = {"command": node, "args": [entry], "disabled": False, "env": {"RIMWORLD_API": "http://127.0.0.1:18800"}}
os.makedirs(os.path.dirname(file), exist_ok=True)
with open(file, "w") as f: json.dump(cfg, f, indent=2)
print("   updated", file)
EOF
}

echo "== Antigravity (Google) mcp_config.json"
upsert_json "$HOME/.gemini/config/mcp_config.json"
for extra in "$HOME/.gemini/antigravity/mcp_config.json" "$HOME/.gemini/antigravity-ide/mcp_config.json"; do
  [ -f "$extra" ] && upsert_json "$extra"
done

echo "== Gemini CLI settings.json"
if [ -f "$HOME/.gemini/settings.json" ]; then upsert_json "$HOME/.gemini/settings.json"; else echo "   (no ~/.gemini/settings.json; skipped)"; fi

echo "== Codex CLI config.toml"
CODEX="$HOME/.codex/config.toml"
if [ -f "$CODEX" ]; then
  python3 - "$CODEX" "$NODE" "$ENTRY" <<'EOF'
import re, sys
file, node, entry = sys.argv[1:4]
s = open(file).read()
block = f'[mcp_servers.rimworld]\ncommand = "{node}"\nargs = ["{entry}"]\nstartup_timeout_sec = 60\n\n[mcp_servers.rimworld.env]\nRIMWORLD_API = "http://127.0.0.1:18800"\n'
s = re.sub(r'\n?\[mcp_servers\.rimworld(\.env)?\][^\[]*', '\n', s)
s = s.rstrip("\n") + "\n\n" + block
open(file, "w").write(s)
print("   updated", file)
EOF
else
  echo "   (no ~/.codex/config.toml; skipped)"
fi

echo "== Cursor / Claude Desktop (only if config exists)"
for f in "$HOME/.cursor/mcp.json" "$HOME/Library/Application Support/Claude/claude_desktop_config.json"; do
  if [ -f "$f" ]; then upsert_json "$f"; fi
done

echo
echo "Done. Generic MCP config for any other client:"
cat <<EOF
{
  "mcpServers": {
    "rimworld": { "command": "$NODE", "args": ["$ENTRY"], "env": { "RIMWORLD_API": "http://127.0.0.1:18800" } }
  }
}
EOF
