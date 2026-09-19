# RimWorld AI

Let AI agents play RimWorld. Two parts:

| Part | What it is | Where |
|---|---|---|
| **RimWorld AI Bridge** (mod) | C# mod that runs an HTTP + JSON API inside the game on `http://127.0.0.1:18800`. Observation (colony, pawns, things, map grid, alerts, events, letters, research, screenshots) and orders (draft, move, attack, jobs, work priorities, designations, blueprints, zones, bills, research, quests, saves, new game). Every call runs on the game's main thread. | `mod/` |
| **rimworld-mcp-server** | Node/TypeScript MCP server (stdio) that exposes the API as `rimworld_*` tools for Claude Code, Antigravity, Codex, Gemini CLI, Cursor, Claude Desktop or any MCP client. | `mcp/` |

Also: `GET http://127.0.0.1:18800/` is a small live dashboard for a human spectator.

## Install (macOS, GOG / direct-download build)

```bash
./scripts/install-mod.sh        # builds the DLL and copies the mod into /Applications/RimWorld.app/Mods, activates it
(cd mcp && npm install && npm run build)
./scripts/register-clients.sh   # adds the "rimworld" MCP server to Claude Code, Antigravity, Codex, Gemini CLI
```

Start RimWorld, wait for the main menu, then in any AI client: *"use rimworld_status, then start a new colony and play"*.

Requirements: RimWorld 1.6 (DLCs optional), .NET SDK 8+ (`brew install dotnet`), Node 18+.

## Quick checks

```bash
curl -s localhost:18800/status | jq          # main menu or in game
curl -s localhost:18800/help | jq '.routes[] | "\(.method) \(.path)"'
node mcp/scripts/smoke.mjs rimworld_status   # through MCP
```

## Settings

Options > Mod Settings > RimWorld AI Bridge: port, optional token (clients send `X-Token`), allow dev actions. Environment overrides: `RIMWORLD_AI_PORT`, `RIMWORLD_AI_TOKEN` (game side); `RIMWORLD_API`, `RIMWORLD_AI_TOKEN` (MCP side).

## Docs

- `RimWorld AI Plan.md` — goals, architecture, roadmap.
- `RimWorld AI Handoff.md` — current state, what is verified, known issues, how to continue.
- `mod/Source/RimWorldAIBridge/Api/*.cs` — every route with its description (also `GET /help`).
