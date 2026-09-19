# The AI Play Guide

How any AI agent connects to a running RimWorld 1.6 colony and plays it well.

This guide is vendor neutral. Claude, Gemini, GPT, a Codex CLI session, a LangChain script, a
Cursor agent or a shell loop built out of `curl` all play through the same two doors: an HTTP API,
or the MCP server that wraps it. Nothing here requires a particular model.

**Contents**

1. [The contract](#1-the-contract)
2. [The loop](#2-the-loop)
3. [Reading the game](#3-reading-the-game)
4. [Route reference](#4-route-reference)
5. [Wiring your client](#5-wiring-your-client)
6. [The strategy manual](#6-the-strategy-manual)
7. [Playing on stream](#7-playing-on-stream)
8. [Rules of the run](#8-rules-of-the-run)

---

## 1. The contract

### Connect

The mod runs an HTTP server inside the game process at `http://127.0.0.1:18800`. It is up as soon as
RimWorld reaches the main menu, before any colony exists.

```bash
curl -s http://127.0.0.1:18800/status
```

```json
{"bridgeVersion":"0.1.0","gameVersion":"1.6.4871 rev581","programState":"Playing",
 "playing":true,"loading":false,"tick":21095,"speed":3,"paused":false,
 "date":"1st of Aprimay, 5500, 14h","colonyName":"Persona Core",
 "storyteller":"Cassandra Classic","difficulty":"strive to survive",
 "devMode":false,"godMode":false,"ok":true}
```

Three states matter before you do anything:

| Condition | Meaning | What to do |
|---|---|---|
| `playing:false` | Main menu, no colony | `POST /game/new` or `POST /game/load` |
| `loading:true` | Generating or loading | Poll `/status` until false. Do not send orders. |
| `playing:true, loading:false` | Live colony | Play. |

### The lease

Only one agent may drive a colony at a time. Claim a lease before issuing orders and send your agent
id on every request.

```bash
curl -s -X POST http://127.0.0.1:18800/agent/claim \
  -H 'Content-Type: application/json' -H 'X-Agent-Id: my-agent' \
  -d '{"agent":"my-agent","leaseSec":300}'
```

Every mutating request must carry `X-Agent-Id: my-agent`. Without a matching id you get:

```json
{"ok":false,"error":"Locked: lease held by persona-core for 285 more seconds.",
 "owner":"persona-core","leaseRemainingSec":285}
```

Renew by claiming again before it expires. Release when you stop:

```bash
curl -s -X POST http://127.0.0.1:18800/agent/release \
  -H 'Content-Type: application/json' -d '{"agent":"my-agent"}'
```

Read-only routes are never locked, so an observer can watch while another agent plays.

### Errors

Every route returns JSON. Failures carry an HTTP status and a message:

| Status | Meaning |
|---|---|
| 400 | Bad arguments. The message names the parameter. |
| 403 | Another agent holds the lease. |
| 404 | No such pawn, thing, zone, letter or def. |
| 409 | Conflicting state, for example `/game/new` while a game is running. |
| 503 | The game is loading or generating. Retry after polling `/status`. |

Orders that the game itself rejects do **not** fail the request. `/designate` returns
`{"designated": 9, "rejected": ["106,126: Must designate plants.", ...]}`. Always read the counts.
A 200 means the request was understood, not that the game accepted every target.

### Pacing

Two models, pick one:

- **Real time.** Set `POST /speed {"speed":3}` and run a loop at your own cadence, reading
  `/snapshot` every few hundred milliseconds. This is what a streaming agent wants: the game never
  stops for the audience.
- **Turn based.** `POST /wait {"ticks":600,"speed":3}` advances exactly 600 ticks and pauses. The
  call returns when the game is paused again, so your loop is deterministic and cheap.

Speeds: `0` paused, `1` normal, `2` fast, `3` superfast, `4` ultra. One in-game day is 60000 ticks.

A colony that has paused itself behind a modal dialog will ignore speed changes. Clear it with
`POST /dialog/close {"all":true}` before setting speed.

---

## 2. The loop

The shape that works, in priority order. Everything below is the same logic the reference agent in
`scripts/colony-agent.mjs` runs.

```
claim lease (every 60 s)
  |
read /snapshot  (one call, everything you need)
  |
if a dialog is blocking      -> /dialog/close {all:true}
if hostiles are a real threat-> combat routine, speed 1, 250 ms turns
else
  needs      : food, medical, rest, mood        (every turn)
  letters    : choose or dismiss, react         (every turn)
  food       : forage, hunt, sow, cook          (every few turns)
  materials  : wood, stone, steel               (every ~10 turns)
  building   : shelter, beds, table, benches    (every ~8 turns)
  production : bills on workbenches             (every ~25 turns)
  research   : pick the next project            (every ~20 turns)
  trade      : caravans and orbital ships       (every ~20 turns)
  work plan  : priorities for new colonists     (every ~30 turns)
  presentation: camera, commentary              (every turn)
  daily      : save the game, log the day       (on day change)
```

Two rules keep this from degenerating:

1. **Rate limit every routine.** Without a per-routine turn counter you will re-place the same
   blueprint and re-designate the same bushes every 700 ms. Keep a map of `routine -> last turn` and
   gate on it.
2. **Make orders idempotent or remember them.** `POST /build` on an occupied cell fails, which is
   fine, but logging "placed a campfire" every turn is not. Track what you have already placed and
   distinguish "placed now" from "was already there".

### A minimal loop

Node:

```js
const API = "http://127.0.0.1:18800";
const ID = "my-agent";
const call = async (method, path, body) => {
  const res = await fetch(API + path, {
    method,
    headers: { "Content-Type": "application/json", "X-Agent-Id": ID },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
};

await call("POST", "/agent/claim", { agent: ID, leaseSec: 300 });
for (;;) {
  const snap = await call("GET", "/snapshot");
  const hungry = (snap.colonists ?? []).filter((c) => (c.needs?.food ?? 1) < 0.3);
  if (hungry.length) {
    await call("POST", "/designate", {
      type: "harvest",
      rect: { x: hungry[0].x - 15, z: hungry[0].z - 15, w: 30, h: 30 },
    });
  }
  await call("POST", "/wait", { ticks: 600, speed: 3 });
}
```

Python:

```python
import requests
API, ID = "http://127.0.0.1:18800", "my-agent"
S = requests.Session()
S.headers.update({"X-Agent-Id": ID, "Content-Type": "application/json"})

S.post(f"{API}/agent/claim", json={"agent": ID, "leaseSec": 300})
while True:
    snap = S.get(f"{API}/snapshot").json()
    for c in snap.get("colonists", []):
        if c.get("needs", {}).get("food", 1) < 0.3:
            S.post(f"{API}/designate", json={
                "type": "harvest",
                "rect": {"x": c["x"] - 15, "z": c["z"] - 15, "w": 30, "h": 30},
            })
    S.post(f"{API}/wait", json={"ticks": 600, "speed": 3})
```

Shell:

```bash
AGENT=my-agent
api() { curl -s -X "$1" "http://127.0.0.1:18800$2" \
  -H 'Content-Type: application/json' -H "X-Agent-Id: $AGENT" ${3:+-d "$3"}; }

api POST /agent/claim '{"agent":"'$AGENT'","leaseSec":300}'
while true; do
  api GET /snapshot | jq -c '{date, colonists: [.colonists[] | {name, food: .needs.food}]}'
  api POST /wait '{"ticks":600,"speed":3}' > /dev/null
done
```

---

## 3. Reading the game

### `/snapshot` is the one call to make

It is atomic: everything comes from the same frame, so nothing contradicts anything else.

| Field | Shape | Notes |
|---|---|---|
| `tick` | int | 60000 ticks per day. Day number is `floor(tick / 60000) + 1`. |
| `speed`, `paused` | int, bool | Current time controls. |
| `colonyName`, `date` | string | `"4th of Aprimay, 5500, 11h"`. |
| `weather`, `temperatureC` | string, number | Outdoor temperature. |
| `colonists` | array | See the pawn shape below. |
| `hostiles` | array | Only present when hostiles exist. Same pawn shape. |
| `alerts` | array | The right-edge warnings, with explanations. |
| `resources` | object | `defName -> count`, stockpiled only, like the top bar. |
| `foodNutrition` | number | Total edible nutrition on hand. The number that predicts starvation. |
| `research` | object or null | `{project, label, progress}` where progress is 0 to 1. |
| `letters` | array | Open letters. Choice letters carry `choices: [{index, label, disabled}]`. |
| `quests` | array | Non-hidden, non-historical quests. |
| `events` | array | The last 10 event-log entries. |
| `latestEventSeq` | int | Pass to `/events?since=` to page the rest. |

The pawn shape, from `/snapshot`, `/pawns` and `/pawn/{id}`:

```json
{
  "id": 1790, "name": "Haruto", "role": "colonist", "kind": "colonist",
  "gender": "Male", "age": 34, "x": 113, "z": 134, "map": 0,
  "drafted": false, "downed": false, "inBed": false, "asleep": false,
  "health": { "pct": 1, "bleedRate": 0.3, "pain": 0.2,
              "needsTending": true, "hediffs": ["Bite (left leg)"] },
  "needs": { "food": 0.16, "rest": 0.78, "mood": 0.36, "joy": 0.41 },
  "moodBreakThreshold": 0.35,
  "job": { "def": "HaulToCell", "report": "hauling berries x9 to Main stockpile.",
           "target": "berries" },
  "weapon": "Short bow"
}
```

Add `?detail=1` for `skills`, `work`, `traits`, `apparel`, `thoughts` and health `capacities`.
Skills come back as a level, or `"9 *"` for a minor passion and `"12 **"` for a major one, or
`"disabled"`. Parse accordingly.

Fields that are absent mean "not true": there is no `downed: false` on a healthy pawn, only a
missing key. Always use a default.

### Other observation you will want

- **`/colony`** is a lighter one-call overview when you do not need the full snapshot.
- **`/things`** finds objects. Filter with `?def=`, `?label=`, `?cat=Item|Building|Plant|Filth`,
  `?rect=x,z,w,h`, `?player=1`, `?forbidden=1`. It paginates: read `total`, `count`, `hasMore` and
  `offset`. A search that does not filter by `def` can drown in grass, so filter first.
- **`/things/summary`** counts by def. The cheap way to ask "do we have a bed yet".
- **`/grid`** returns an ASCII map for spatial reasoning. Useful before choosing a build site.
- **`/cell?x=&z=`** is everything at one cell: terrain, things, zone, area, roof, fog.
- **`/defs?type=...&q=...`** searches definitions. Use it before guessing a `defName`. Building a
  `Table1x2c` works; building a `DiningTable` does not.
- **`/screenshot?width=1024`** returns a PNG, not JSON. For a vision model, this is the eye.

---

## 4. Route reference

75 routes. `ANY` accepts GET with query parameters or POST with a JSON body. `GET /help` prints this
list from the running game, which is always the authority for your version.

### Session and status

| Route | Description |
|---|---|
| `GET /help` | List every route with a one-line description. |
| `GET /health` | Quick server health check (uptime, requests served, loading state). |
| `GET /status` | Program state, version, tick, speed, date, loaded maps. Works on the main menu. |
| `POST /agent/claim` | Acquire exclusive agent control lease. `{agent, leaseSec:30}` |
| `POST /agent/release` | Release the lease. `{agent}` |
| `GET /agent/owner` | Current lease holder and remaining duration. |

### Observation

| Route | Description |
|---|---|
| `GET /snapshot` | Full atomic colony snapshot: status, colonists, hostiles, alerts, resources, research, letters, events. |
| `GET /colony` | One-call situational overview: map summary, resources, alerts, colonist one-liners, threats, research. |
| `GET /maps` | List all maps (player home, encounter maps). |
| `GET /map` | Detailed summary of one map: weather, date, zones, areas, resources, designations. `?map=id` |
| `GET /pawns` | List pawns. `?role=colonist\|prisoner\|slave\|colony_animal\|enemy\|wild_animal\|all &detail=1 &map=id` |
| `GET /pawn/{idOrName}` | Full detail for one pawn: skills, work priorities, traits, apparel, thoughts. |
| `GET /things` | List things. `?cat= &def= &label= &rect=x,z,w,h &forbidden=1 &player=1 &limit=100 &offset=0 &detail=1` |
| `GET /thing/{id}` | Detail for one thing. |
| `GET /things/summary` | Counts grouped by def. `?cat= &player=1` |
| `GET /resources` | Stockpiled resources by defName. |
| `GET /alerts` | Active alerts with explanations. |
| `GET /events` | Event feed: letters, messages, social and battle log. `?since=seq &limit=100` |
| `GET /letters` | Open letters. Choice letters list their options. |
| `GET /quests` | Quests. `?all=1` includes historical. |
| `GET /research` | Current project plus projects available to start. `?all=1` lists finished. |
| `GET /grid` | ASCII map. `?x= &z= &w=60 &h=40 &scale=1` |
| `GET /cell` | Everything at one cell. `?x= &z=` |
| `GET /defs` | Search definitions. `?type=thing\|building\|item\|plant\|recipe\|research\|work\|incident\|terrain\|storyteller\|scenario\|difficulty\|biome\|pawnkind &q= &limit=50 &buildable=1` |
| `GET /screenshot` | PNG of the current frame. `?width=1024` |

### Orders

| Route | Description |
|---|---|
| `ANY /speed` | Set game speed. `{speed:0..4}`. Omit speed to toggle pause. |
| `ANY /wait` | Advance N ticks then pause. `{ticks:600, speed:3}` |
| `ANY /draft` | Draft or undraft. `{pawn, drafted:true}` |
| `ANY /move` | Walk to a cell. `{pawn, x, z, draft:false}` |
| `ANY /attack` | Attack a target. `{pawn, target, draft:true}` |
| `ANY /job` | Generic ordered job. `{pawn, job:JobDef, targetA, targetB, targetC, count, queue:false}` |
| `ANY /job/cancel` | Stop the current job and clear the queue. `{pawn}` |
| `ANY /equip` | Equip a weapon or wear apparel from the ground. `{pawn, thing}` |
| `ANY /work` | Set one work priority. `{pawn, work:WorkTypeDef, priority:0..4}` 0 disabled, 1 highest. |
| `ANY /work/bulk` | Set many at once. `{pawn, priorities:{Doctor:1, Cooking:2}}` |
| `ANY /pawn/settings` | `{pawn, hostility:Flee\|Attack\|Ignore, medicalCare:NoCare\|NoMeds\|HerbalOrWorse\|NormalOrWorse\|Best, area, selfTend, prisonerMode}` |
| `ANY /pawn/schedule` | 24h timetable. `{pawn, preset:'optimal'\|'joy'\|'work'}` or `{hours:[...]}` |
| `ANY /bed/settings` | `{thing:bedId, forPrisoners:bool, medical:bool}` |

### The world

| Route | Description |
|---|---|
| `ANY /designate` | `{type: mine\|cancel\|harvest\|cut\|chop\|hunt\|tame\|haul\|deconstruct\|uninstall\|slaughter\|strip\|open\|claim\|smooth\|removeFloor, cells\|rect\|things}` |
| `ANY /build` | Place a blueprint. `{def, x, z, rot:0-3, stuff}` |
| `ANY /build/bulk` | Place many. `{items:[{def,x,z,rot,stuff}]}` |
| `ANY /zone` | Create a zone. `{type:stockpile\|dumping\|growing, cells\|rect, plant, priority, label}` |
| `ANY /zone/update` | `{id, plant, allowSow, priority, label, addCells, removeCells, delete}` |
| `ANY /area/home` | Add or remove Home area cells. `{cells\|rect, add:true}` |
| `ANY /forbid` | Forbid items. `{forbidden:true, all, home, cells\|rect, def, things}` |
| `ANY /allow` | Unforbid items. Same arguments. |
| `ANY /bill` | Add a bill to a workbench. `{thing, recipe, mode:forever\|count\|target, count, suspended}` |
| `ANY /bill/remove` | `{thing, index:0 \| all:true}` |
| `POST /research` | Set the current project. `{project:ResearchProjectDef}` |

### Events and presentation

| Route | Description |
|---|---|
| `ANY /letter/choose` | Pick an option on a choice letter. `{id, choice:index\|label}` |
| `ANY /letter/dismiss` | `{id}` or `{all:true}` |
| `ANY /quest/accept` | Accept a quest by id. |
| `ANY /dialog/close` | Close the topmost dialog. `{all:true}` closes all closable dialogs. |
| `ANY /camera` | Move the camera. `{x, z, zoom:10..60, pawn, follow:bool}` |
| `ANY /camera/follow` | Smooth follow camera. `{pawn, enabled, deadzone, zoom, speed}` |
| `ANY /select` | Select things in the UI. `{things:[id]}` or `{pawn}` |
| `ANY /notify` | Show an in-game message. `{text, type:neutral\|positive\|negative\|threat}` |
| `ANY /chat/push` | Push a chat message to the in-game HUD. `{user, text, color}` |
| `ANY /chat/clear` | Clear the in-game chat HUD. |

### Trade

| Route | Description |
|---|---|
| `GET /traders` | Active traders on the map plus the best colony negotiator. |
| `GET /trade` | The active trade session catalog, silver and prices. |
| `ANY /trade/open` | `{trader:idOrName, negotiator:idOrName, showDialog:true}` |
| `ANY /trade/deal` | `{buy:[{def,count}], sell:[{def,count}], execute:true}` |
| `ANY /trade/auto` | One-step trade: sell surplus, buy components and medicine, execute, close. `{trader}` |
| `ANY /trade/close` | Close the session and any open trade dialog. |

### Game lifecycle

| Route | Description |
|---|---|
| `GET /game/saves` | List save files, newest first. |
| `ANY /game/save` | `{name:'AI Colony'}`. Overwrites. |
| `ANY /game/load` | Load by name. Poll `/status` until `playing` and not `loading`. |
| `ANY /game/new` | `{scenario, storyteller, difficulty, mapSize, seed, planetCoverage, biome, hilliness, permadeath, neolithic, curatePawn, colonyName}`. Takes one to two minutes. |
| `ANY /game/menu` | Quit to the main menu without saving. |
| `ANY /game/quit` | Quit RimWorld. |
| `ANY /game/storyteller` | Change storyteller or difficulty mid-game. |

### Dev routes

`/dev`, `/dev/incident` and `/dev/spawn` exist for testing and require the mod setting that allows
dev actions. A legitimate run never calls them.

---

## 5. Wiring your client

### MCP (recommended)

The MCP server exposes 65 `rimworld_*` tools over stdio, one per route group, with typed arguments.

```bash
cd mcp && npm install && npm run build && cd ..
./scripts/register-clients.sh
```

That script registers the server with every client it finds. To do it by hand:

**Claude Code**

```bash
claude mcp add -s user rimworld -- "$(command -v node)" /absolute/path/to/rimworld-ai/mcp/dist/index.js
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`),
**Cursor** (`~/.cursor/mcp.json`), **Gemini CLI** (`~/.gemini/settings.json`),
**Antigravity** (`~/.gemini/config/mcp_config.json`) all take the same shape:

```json
{
  "mcpServers": {
    "rimworld": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/absolute/path/to/rimworld-ai/mcp/dist/index.js"],
      "env": { "RIMWORLD_API": "http://127.0.0.1:18800" }
    }
  }
}
```

A note for Antigravity: a **remote** MCP server is configured with `serverUrl`, not `url`. This one
is a local stdio server, so use `command` and `args` as above.

**Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.rimworld]
command = "/opt/homebrew/bin/node"
args = ["/absolute/path/to/rimworld-ai/mcp/dist/index.js"]
startup_timeout_sec = 60

[mcp_servers.rimworld.env]
RIMWORLD_API = "http://127.0.0.1:18800"
```

The tool names map to the routes: `rimworld_status`, `rimworld_snapshot`, `rimworld_colony`,
`rimworld_pawns`, `rimworld_pawn`, `rimworld_things`, `rimworld_designate`, `rimworld_build`,
`rimworld_zone_create`, `rimworld_set_work_bulk`, `rimworld_draft`, `rimworld_attack`,
`rimworld_speed`, `rimworld_wait`, `rimworld_letter_choose`, `rimworld_game_new`, and so on. Two
escape hatches, `rimworld_raw` and `rimworld_raw_post`, call any route the typed tools do not cover.

### Plain HTTP

No MCP client, no problem. Everything in this guide is reachable with `curl`, `fetch` or
`requests`. Set `X-Agent-Id` on every mutating call and you are playing.

### Tool-calling agents

If you are wiring this into an agent framework, expose four tools rather than seventy five and let
the model compose: `observe(path)` for any GET, `order(path, body)` for any POST, `wait(ticks)`, and
`help()`. Models handle this better than a large flat tool list, and `GET /help` teaches the model
the surface at runtime.

---

## 6. The strategy manual

This section is about playing well, not about the API.

### Decision priorities

Work top down. A lower item never preempts a higher one.

1. **Survival of the colonists.** Bleeding, starvation, hypothermia, a mental break about to fire.
2. **Immediate threats.** Raiders, manhunters, fire, infestations.
3. **Food security.** A colony with less than three days of nutrition is in a slow emergency.
4. **Shelter and temperature.** A roof, a door, a heat source before the first cold snap.
5. **Beds, table, chairs.** The three cheapest mood fixes in the game.
6. **Production.** Workbenches and bills so the colony makes its own things.
7. **Research.** The compounding investment. It never outranks food.
8. **Expansion.** More colonists, more rooms, more defense.

### Opening: Naked Brutality

One colonist, no clothes, no food, no tools. The first ten days decide the run.

**Minute one.** Do not build anything yet.

```bash
# What am I working with?
curl -s "http://127.0.0.1:18800/pawn/$NAME?detail=1"
# What does the map look like around the spawn?
curl -s "http://127.0.0.1:18800/grid?w=80&h=60"
```

Read the founder's skills. Plants and Construction decide the opening. Note the traits: Tough,
Fast Learner, Industrious, Iron-Willed, Nudist and Ascetic are all worth real time. Pyromaniac,
Wimp, Slothful and heavy drug desires are run-enders for a solo start.

Look for fertile soil, berry bushes, healroot, trees, a defensible pocket of terrain, and steel.
Anchor the base near soil and water but at least 30 cells from the map edge, since edge tiles are
where raids walk in.

**Day one.** In order:

```bash
# 1. Claim the lease and open the home area so items count and get hauled.
curl -s -X POST :18800/agent/claim -d '{"agent":"me","leaseSec":300}'
curl -s -X POST :18800/area/home -d '{"rect":{"x":98,"z":119,"w":33,"h":33},"add":true}'
curl -s -X POST :18800/allow -d '{"home":true}'

# 2. Food first. Let the game pick what is harvestable in a ring around the base.
curl -s -X POST :18800/designate -d '{"type":"harvest","rect":{"x":101,"z":122,"w":24,"h":24}}'

# 3. Wood. Same trick: the game filters to wood-yielding plants.
curl -s -X POST :18800/designate -d '{"type":"chop","rect":{"x":101,"z":122,"w":24,"h":24}}'

# 4. A stockpile so hauled goods land somewhere useful.
curl -s -X POST :18800/zone -d '{"type":"stockpile","rect":{"x":118,"z":129,"w":6,"h":5},"priority":"Preferred","label":"Main"}'

# 5. Free structures: a sleeping spot and a crafting spot cost nothing.
curl -s -X POST :18800/build -d '{"def":"SleepingSpot","x":114,"z":133}'
curl -s -X POST :18800/build -d '{"def":"CraftingSpot","x":119,"z":136}'

# 6. Work priorities that match the pawn.
curl -s -X POST :18800/work/bulk -d '{"pawn":1790,"priorities":{"Firefighter":1,"Patient":1,"Doctor":1,"PatientBedRest":1,"BasicWorker":1,"Growing":1,"PlantCutting":1,"Construction":2,"Cooking":2,"Hauling":2,"Hunting":3,"Research":3,"Cleaning":0}}'
```

Then a campfire (20 wood), growing zones, and the hut.

**Designate by rectangle, not by thing id.** This is the single most useful trick in the API. The
game already knows which plants yield wood and which are harvestable. A rectangle chop designation
returns `{"designated": 34}` and you never have to identify a tree. Searching `/things` for trees
means paging past hundreds of grass entries and getting it wrong.

**Days one to ten.** The checklist:

| Priority | Thing | Cost | Why |
|---|---|---|---|
| 1 | Campfire | 20 wood | Warmth, light, cooked meals |
| 2 | Growing zone, rice | free | Rice matures in about three days |
| 3 | Growing zone, potatoes or corn | free | The staple after rice |
| 4 | 7x7 hut with a door | ~85 wood | A roof and a temperature you control |
| 5 | Wooden bed | 45 wood | Ends the "slept on the ground" mood hit |
| 6 | Table and stool | ~55 wood | Ends the "ate without a table" mood hit |
| 7 | Short bow | 40 wood at a crafting spot | Hunting and defense |
| 8 | Tribalwear | 60 leather | Clothes, and the temperature range to survive |
| 9 | Healroot patch | free | Herbal medicine forever |
| 10 | Research bench | 100 wood, 25 steel | The tech tree opens |

**Starvation is the real killer, not raiders.** Watch `foodNutrition`, not the food need bar. Under
about `1.6 * colonists` nutrition you have one day of food. Under 3 days, drop everything: forage a
wider ring, hunt, sow, and promote Hunting, Growing and Cooking above Construction with
`/work/bulk`. Restore the normal plan once there is a buffer.

**Hunting without a weapon.** A naked colonist can beat a rat, squirrel, hare, chicken or turkey to
death and survive. Never designate a bear, wolf, warg, cougar, boar, elephant, rhino, thrumbo or
muffalo: they fight back, they are faster than you, and the entire run ends there. Deer and
caribou are safe to hunt but only with a ranged weapon; on foot they simply outrun you.

### Mid game

Rooms and mood: individual bedrooms beat a barracks, and a bedroom's quality comes from size,
floor, furniture and beauty. A freezer built from a cooler pointed into a small insulated room ends
food spoilage permanently. Passive coolers work before electricity.

Defense: a single entrance with the approach covered is worth more than a wall around everything.
Wooden spike traps are cheap and handle early raids and manhunters, but build them only after the
hut, the bed and the food supply exist. Never put a trap where your own colonists walk daily.

Research order that compounds: Complex Furniture, Stonecutting, Passive Cooler, Brewing, Smithing,
Complex Clothing, then Electricity, Batteries, Solar Panels, then Microelectronics, Gunsmithing,
Machining, Hydroponics, Medicine Production, then the fabrication line.

Recruiting: capture downed raiders, put them in a bed set `forPrisoners`, tend them with
`medicalCare: "Best"`, and set `prisonerMode: "Recruit"` through `/pawn/settings`. Every recruit is
a colonist you did not have to wait for a wanderer event to receive.

### Combat doctrine

Read the threat before deciding. There are three cases:

1. **Armed colonists versus anything.** Draft, take cover, focus fire the nearest hostile. Set game
   speed to 1 and run your loop every 250 ms; combat is decided in seconds.
2. **Unarmed colony versus a small mad animal.** Fight it. A squirrel or hare loses to fists.
3. **Unarmed colony versus armed raiders or a large predator.** Do not fight. Draft and move away,
   keeping distance, set `hostility: "Flee"`, and let them loot and leave. A raid that takes your
   silver is a bad day. A dead founder is the end of the run.

The mistake that kills solo colonies is a brave decision made with no weapon. Check `weapon` on
every colonist before you choose to engage.

After combat: undraft, restore `hostility: "Attack"`, tend wounds, and only then go back to work.

### Trading

`GET /traders` lists caravans and orbital ships on the map. `POST /trade/auto` runs a whole
sensible trade in one call: sell surplus leather, apparel and drugs, buy components and medicine,
execute, close. For control, use `/trade/open`, read `/trade`, then `/trade/deal` with explicit
buy and sell lists. Always `/trade/close` so the dialog does not pause the game.

### Mood management

Mental breaks cascade. Watch `mood` against `moodBreakThreshold` on every pawn every turn. When a
pawn is within a few points of the threshold and `joy` is low, switch them to the joy schedule with
`/pawn/schedule {"preset":"joy"}` for a short window, then put them back on `optimal`. Leaving a
colonist on a joy schedule forever means nothing gets built.

The cheap, permanent mood wins, in order of value per silver: a bed of their own, a table to eat
at, a floor, a decent-sized room, recreation objects, and clothes that fit the temperature.

### Failure modes and how to see them coming

| Failure | The signal in the API |
|---|---|
| Starvation | `foodNutrition` trending toward zero while colonist `food` needs fall |
| Mental break cascade | Several pawns with `mood` near `moodBreakThreshold` |
| Infection death | `health.hediffs` containing an infection, `needsTending` true |
| Frozen colonist | `temperatureC` well below zero and no roof over the base |
| Raid wipe | `hostiles` present with weapons while your colonists have none |
| Work stall | Every colonist's `job.def` in the `Wait_*` family for many turns |
| Blocked by a dialog | `paused` true and speed changes have no effect |
| Wandering pawn | A pawn drifting far from the base because designations were placed too far out |

That last one is worth dwelling on: designations centred on a *pawn* rather than on the *base* will
walk a hungry colonist across the entire map chasing berries. Centre work on the base and cap the
radius.

---

## 7. Playing on stream

If your agent is being watched, presentation is part of playing well.

- **Keep the camera on the action.** `POST /camera/follow {"pawn":id,"enabled":true,"deadzone":2.5,"zoom":20}`
  and switch targets when the current one goes idle. Zoom in for sleep and meals, out for a fight.
- **Select what you act on.** `POST /select {"pawn":id}` shows the audience what the AI is thinking
  about. It costs nothing and makes the decisions legible.
- **Narrate the reason, not the action.** "Mood is four points off a break, so he gets the afternoon
  off" is interesting. "Setting schedule preset joy" is not.
- **Do not narrate on a timer.** Narrate on events: a threat, a milestone, a loss, a decision with
  a trade-off. Rate limit per topic so one kind of event cannot flood the stream.
- **Put chat on screen.** `POST /chat/push {"user":"name","text":"message"}` renders a viewer message
  in the in-game HUD, which makes the audience part of the run.
- **Answer from the game state.** When a viewer asks a question, read `/snapshot` and answer with
  real numbers. Never invent a fact about the colony.

---

## 8. Rules of the run

The conventions that make a run mean something:

1. **No dev mode, no god mode.** `/status` reports both. They stay false. The `/dev` routes exist
   for testing the bridge and have no place in a real run.
2. **No cheesing technology.** Scavenged gear is fine. Skipping eras is not.
3. **Needs before ambition.** A colonist who starves while the research bench goes up is a
   misplayed colony, not an unlucky one.
4. **Save daily.** `POST /game/save {"name":"Colony_Day12"}` on every day change. Then wait for
   `/status` to report `loading:false` and clear the dialog.
5. **One agent at a time.** Hold the lease, release it when you stop.
6. **Report honestly.** If the colony is failing, say so on stream and explain the mistake. A
   machine that only reports victories is not playing, it is performing.
