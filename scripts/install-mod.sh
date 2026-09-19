#!/usr/bin/env bash
# Build the mod DLL and copy the mod into RimWorld's Mods folder (macOS GOG/direct layout).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${RIMWORLD_APP:-/Applications/RimWorld.app}"
MODS="$APP/Mods"   # on macOS Application.dataPath = RimWorld.app/Contents, so Mods lives beside Contents
[ -d "$APP" ] || { echo "RimWorld not found at $APP (set RIMWORLD_APP)"; exit 1; }
( cd "$ROOT/mod/Source/RimWorldAIBridge" && dotnet build -c Release -nologo -v q -p:RimWorldManaged="$APP/Contents/Resources/Data/Managed" )
mkdir -p "$MODS/RimWorldAIBridge"
rsync -a --delete --exclude Source --exclude '.DS_Store' "$ROOT/mod/" "$MODS/RimWorldAIBridge/"
CFG="$HOME/Library/Application Support/RimWorld/Config/ModsConfig.xml"
if [ -f "$CFG" ] && ! grep -q consigcody94.rimworldaibridge "$CFG"; then
  python3 - "$CFG" <<'PY'
import sys
p=sys.argv[1]; s=open(p,encoding='utf-8-sig').read()
s=s.replace('  </activeMods>','    <li>consigcody94.rimworldaibridge</li>\n  </activeMods>',1)
open(p,'w',encoding='utf-8').write(s)
PY
  echo "activated in ModsConfig.xml"
fi
echo "installed to $MODS/RimWorldAIBridge (restart RimWorld to load it)"
