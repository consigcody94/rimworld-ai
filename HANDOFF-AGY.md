# Handoff: run Persona Core to ten colonists

You are taking over a live RimWorld 1.6 colony. The game is installed, the mod is built and
installed, the save exists. Nothing needs compiling unless you change C#.

## The goal

Reach **10 colonists**. No dev mode, no god mode: `GET /status` reports `devMode` and `godMode`
and both must stay false. Every action is a real game order through the HTTP bridge. No mouse or
keyboard automation.

---

## Start everything

    cd ~/Desktop/rimworld-ai

    # 1. The game, if it is not already running.
    open -a RimWorld
    #    Wait for the bridge, then load the colony:
    curl -s -X POST -H 'X-Agent-Id: persona-core' -H 'Content-Type: application/json' \
      http://127.0.0.1:18800/game/load -d '{"name":"PersonaCore_Handoff"}'

    # 2. The broadcast studio (if not running).
    node stream-app/server.mjs &

    # 3. The watchdog. START THIS. See "Why the watchdog exists" below.
    node scripts/supervisor.mjs &

    # 4. The player.
    node scripts/colony-agent.mjs &

`scripts/colony-agent.mjs` logs to `.agent-state/agent.log` and journals each run to
`runs/*.jsonl` and `runs/*.md`. `scripts/supervisor.mjs` logs to `.agent-state/supervisor.log`.

Check it is actually alive, every time:

    curl -s -H 'X-Agent-Id: persona-core' http://127.0.0.1:18800/status | jq '{playing,paused,speed,tick,devMode,godMode}'
    curl -s -H 'Host: localhost:18888' http://127.0.0.1:18888/api/stream/status | jq '{running,fps,captureState}'
    tail -5 .agent-state/agent.log

A tick that does not advance between two checks means the game is paused or behind a dialog,
whatever `speed` says.

---

## Why the watchdog exists

Three failures look exactly like "it is working": the game left **paused**, the colony agent
**dead or never started**, and the broadcast dropped to **idle**. None of them announce
themselves. An agent handed this colony sat for ten minutes beside a paused game with a dead
stream and reported nothing, because nothing looked wrong from inside its own loop.

`supervisor.mjs` checks all three every 20 seconds and repairs each: resumes the game, closes
blocking dialogs when the tick stops moving, restarts the agent, restarts the broadcast. Run it.

---

## How to talk to the game

    curl -s -H 'X-Agent-Id: persona-core' http://127.0.0.1:18800/help | jq

That prints every route with its contract; it is the authority, not this file. Mutating routes
need the `X-Agent-Id: persona-core` header (the agent lease). Observation routes do not.

**Read `/survey` before deciding anything.**

    curl -s -H 'X-Agent-Id: persona-core' 'http://127.0.0.1:18800/survey?r=45' | jq

It reports what is actually within reach: materials with their true totals **including loose
stacks**, food, corpses by kind, nearby animals with `bodySize`, `predator`, `meat` and a
`safeToHuntBarehanded` flag, grown trees, sown and ripe crops, and threats.

**`GET /resources` counts only stockpiled material.** This is the single most expensive thing to
forget here. The colony held 329 wood in nine piles around the base while `/resources` reported
12, so the campfire was never placed, which gated the bed, which gated every room. Four colonies
in a row ended with a founder sleeping outdoors beside a forest of his own logs.

Other routes you will use: `/snapshot`, `/colony`, `/pawns?player=1&detail=1`,
`/pawn/{idOrName}?detail=1` (traits and skills are here, **not** in the snapshot),
`/things?def=X&detail=1`, `/things/summary?cat=Building&player=1`, `/cell?x=&z=`,
`/fertility?x=&z=&w=&h=&block=&min=` (x/z is the **centre**, not a corner), `/debug/failures`,
`/build`, `/build/bulk`, `/designate`, `/zone`, `/zone/update` (takes a storage `filter`),
`/bill`, `/set_work`, `/pawn/schedule`, `/draft`, `/attack`, `/job`, `/speed`, `/hud/tasks`,
`/game/save`.

---

## Where the colony is

Founder **Castro**, 32. Melee 10★★, Plants 8★, Construction 4★, Mining 4★, Medicine 4.
Traits: Undergrounder, Jogger, **Night owl** (he is on a night shift: asleep 9h–15h).
Naked Brutality, Cassandra, Rough, temperate forest, large hills, spring, 250 map.
Base anchor **(117, 100)**. Around day 4–5.

Standing: campfire built, bed frame under construction, crafting spot, butcher spot with a
standing butcher bill, roughly 264 wood, about 6 days of food, rice sown. Mood has been sitting
near the 35% break threshold, driven by sleeping rough.

---

## The house

`roomPlan()` in `colony-agent.mjs` lays out named rooms that share walls, each with its own door:

    bed3 | bed4            (bands extend north as the colony grows)
    bed1 | bed2
    workshop -- great hall -- kitchen -- cold room
              warehouse                              prison (detached)

`buildRoom` refuses to order a room it cannot pay for in full: an unclosed rectangle gets no
roof, no temperature and none of the mood that justified building it. The great hall is 20 walls
and 4 doors — 200 wood and 6100 work — so at Construction 4 it is most of two in-game days. That
is the honest reason a house does not appear on day one.

Storage is sorted, not piled: goods indoors, food and fresh animal carcasses in the cold room,
human bodies and insect bodies in separate pits far from anyone's line of sight. The cold room
needs a **Cooler**: 90 steel and 3 components, so it is gated on mining and trade, not on wood.

---

## The task board

`POST /hud/tasks` draws the agent's plan inside the game window, top left, where the stream can
read it:

    {"goal":"1 of 10 colonists","day":"Day 5","blocker":"great hall needs 40 more wood",
     "tasks":[{"label":"Campfire","state":"done"},
              {"label":"Great hall","state":"blocked","note":"175/215 wood"}]}

`state` is `done`, `doing`, `blocked` or `queued`. The agent posts this automatically whenever
it re-plans (founding, each day boundary, or when something invalidates the plan). The same
payload goes to the browser overlay at `POST /api/plan` on the studio.


---

## The stream

The broadcast is three pieces: a capture process, the studio, and two on-screen panels.

**Capture and encode.** `stream-app/capture-window.swift` uses ScreenCaptureKit to capture only
the RimWorld window, letterboxed onto a fixed 1920x1080 canvas, plus system audio with the
microphone explicitly excluded. `stream-app/streamer.mjs` encodes through `h264_videotoolbox` at
30 fps, 4500 kbps, 2-second keyframes. If RimWorld restarts mid-broadcast the capture emits black
frames and reattaches to the new window, so the RTMP session survives a game restart.

    curl -s -H 'Host: localhost:18888' http://127.0.0.1:18888/api/stream/status | jq
    curl -s -X POST -H 'Host: localhost:18888' http://127.0.0.1:18888/api/stream/start -d '{}'

`running: false` with `captureState: "idle"` means the broadcast is dead even though the studio
process is alive. The supervisor restarts it; check it anyway.

**Two panels are drawn inside the game window**, so they are part of the captured video and need
no OBS browser source. Both are on the right edge, stacked, clear of RimWorld's own resource
readout along the top:

- **Twitch chat**, top right. Fed by `POST /chat/push`. It renders real emotes as images and
  viewer badges as coloured marks, not as plain text.
- **AI plan**, directly below it. Fed by `POST /hud/tasks`. Shows what the agent is trying to do,
  what it finished and what it is blocked on.

**The browser overlay** at `http://localhost:18888/overlay` carries the same plan plus colonist
cards, resources and research, for anyone who would rather composite it in OBS.
`/overlay?parts=chat,hud,alerts,poll,voice` selects panels.

### Emotes

`stream-app/emotes.mjs` resolves a chat message into ordered parts before it reaches the game:

- **Twitch's own emotes** come already located in the IRC `emotes` tag as `25:0-4,12-16`, id then
  character ranges. No lookup and no API call, and the tag is authoritative because it knows
  which emotes that particular viewer was entitled to use. The ranges are indexed by **code
  point**, not UTF-16 unit, so a message with an emoji before an emote slices correctly.
- **7TV, BetterTTV and FrankerFaceZ** global and per-channel sets are fetched at connect and
  refreshed hourly, matched on whole words only. The channel id they key on is learned from the
  `room-id` tag on the first message rather than from an API call.

One real limit, stated plainly: RimWorld draws these through `Texture2D.LoadImage`, which decodes
**PNG and JPG only**. 7TV serves WebP and AVIF for everything and adds a PNG only for static
emotes, so **animated 7TV emotes cannot be drawn** and the HUD falls back to showing the name the
viewer typed. That is a deliberate choice: a name is true, a blank gap is not.

### Getting chat fully working

Reading chat already works with no credentials at all: the bot connects anonymously as
`justinfan`, which is why viewer messages appear on the in-game HUD. **Posting** needs a token,
and the token flow needs a Twitch application, which does not exist yet.

`.env` currently has `TWITCH_CHANNEL` and `TWITCH_STREAM_KEY` set, and
**`TWITCH_CLIENT_ID`, `TWITCH_BOT_USERNAME` and `TWITCH_BOT_OAUTH` all empty**. The blocker is
the client id: `/auth/twitch` cannot start an OAuth flow without one.

These steps need the account owner and must not be done by an agent:

1. At `https://dev.twitch.tv/console/apps`, register an application. OAuth redirect URL
   `http://localhost:18888/auth/callback`, category Chat Bot.
2. Copy the **Client ID** into `.env` as `TWITCH_CLIENT_ID=...`.
3. Restart the studio: `node stream-app/server.mjs`.
4. Open `http://localhost:18888/auth/twitch` in a browser and log in as whichever account should
   speak in chat. The requested scopes are `chat:read`, `chat:edit` and
   `channel:manage:broadcast` (the last one lets the studio set the stream title and category).
5. Confirm: `curl -s -H 'Host: localhost:18888' http://127.0.0.1:18888/api/settings | jq` should
   show `hasOauth: true` and `hasClientId: true`.

Until that is done the AI can read chat and answer on the in-game HUD, but it cannot post a
message to the channel.

---

## Facts, and where they come from

`reference/GAME-FACTS.md` records what RimWorld's own data files say, at
`/Applications/RimWorld.app/Data/Core/Defs/`. Read it. The short version:

- **Design constants come from the def files. Resolved runtime state comes from the game.**
  Guessing at either is what produced every bug this project has had.
- `harvestMinGrowth` is **0.65** for every Core plant. Designating anything less grown sends a
  colonist across the map to a job RimWorld cancels on arrival.
- Harvesting a ripe **crop** is `Growing` work (`GrowerHarvest`). Harvesting a designated **wild**
  plant or felling a tree is `PlantCutting` (`PlantsCut`). They are different work types, so
  suppressing Growing during a food emergency suppresses the harvest that would end it.
- Delivering materials to a blueprint is a **Construction** giver, not only a Hauling one, so
  Hauling can stay at 3 or below without starving a build site.
- `ThingDef.IsWeapon` is **true for WoodLog** — a log is an improvised melee weapon. Ask whether
  something is stuff before asking whether it could be swung.
- A `DiningChair` is 8000 work against a `Stool`'s 450 for the same seat at the same table.
- Sleeping rough is three separate -4 thoughts (`SleptOutside`, `SleptInCold`, `SleptOnGround`)
  that stack to -12 a night against a 35% break threshold.
- A pawn completes every job at one priority before it looks at the next, and ignores distance
  while doing so. Two work types sharing a priority is a real decision, not a tie.

---

## Rules

- **Do not fabricate.** Never write that something is built, verified or approved without the
  tool output that shows it. Everything here is checkable against the live game, which you
  cannot fake. If you did not do it, say you did not do it. Mark unmade decisions **UNDECIDED**
  and illustrative blocks **TEMPLATE**.
- **A passing curl is not a working system.** Check the game state, not your own logs.
- Do not restart RimWorld without saving first (`POST /game/save`) — restarting drops the live
  colony to the main menu and the run is lost.
- Slow to speed 1 during raids, mental breaks, injuries and letters. Speed 3 is fine while the
  colony is only chopping, sowing and hauling. The agent does this itself; do not pin `--speed`
  unless you mean to override it.
- No dev mode, no god mode, no `/dev/*` routes.
- Save daily.

## What to report

Colonist count, what rooms actually stand (from `/things/summary?cat=Building&player=1`), the
current blocker, and any code you changed with the reason. Quote the tool output.
