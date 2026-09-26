# Operations reference

The operator runbook is `AGENTS.md`; start there. This file is the accumulated difference between
what previous agents assumed about RimWorld and this stack and what is actually true, and every
item in it was learned by losing a colony. Read the section you need before touching the code
it describes.

## The goal

The long goal is **50 colonists** (the stream title's "50-Colonist Challenge"; `POPULATION_TARGET`
in `.env`). No colony has yet lived past day 9, so the goal that matters now is the next rung of
the ladder in `PROGRESS.md`: survive the day-4 threat, survive the day-6 raid and take the raider
alive, then a second colonist. Each run's `runs/*.md` lists the milestones it reached.

No dev mode, no god mode: `GET /status` reports `devMode` and `godMode` and both must stay false.
Every action is a real game order through the HTTP bridge. No mouse or keyboard automation.

---

## Start everything

    cd ~/Desktop/rimworld-ai
    npm run preflight          # everything ready? starts nothing, prints no secrets
    npm run up -- --new        # studio + supervisor; a fresh colony at the title screen
    npm run status             # what is running, the colonists, whether the channel is LIVE
    npm run down               # end the broadcast cleanly, stop everything (-- --quit-game too)

`up` refuses to start on a failed preflight, installs the bridge mod first if the installed build
is stale and the game is closed, opens RimWorld, and starts the studio and the supervisor. The
supervisor then does the rest: it starts the colony (`--new`) or loads the newest save after 90
seconds at the title screen, starts the colony agent, and starts the broadcast **only once a
colony is loaded**. Without `--new`, `up` resumes the newest save.

Logs: `logs/studio.log`, `logs/supervisor.log`, `.agent-state/agent.log`. Each run is journaled to
`runs/*.jsonl` with a summary in `runs/*.md`: milestones reached, and how the run ended.

Check it is actually alive, every time:

    npm run status
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
blocking dialogs when the tick stops moving, restarts the agent, restarts the broadcast. It also
relaunches RimWorld if it vanishes, loads the newest save when the game sits at the title screen,
and after a wipe starts a fresh Naked Brutality colony. `npm run up` starts it.

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

## Standing orders

**Test a change on a fresh game, never a save.** After any change to the mod or the agent, start
a brand new colony with `npm run down -- --quit-game` then `npm run up -- --new`. A save carries
the state the old code produced, so a fix looks like it worked when it only inherited a world the
bug already built. A mod change needs a RimWorld restart to load the new assembly.

The one exception is a crash with no code change: then the supervisor loading the newest save is
exactly right, because nothing about the player changed.

`curatePawn` scores hundreds of random founder rolls and keeps a strong one. Nothing about the
pawn is edited, so the start is a legitimate roll, just a well chosen one. It requires
Construction 3 or better, because ConstructionSpeed is 0.3 at skill zero and a founder who
cannot build never gets a roof.

**Keep improving as you play.** The point of a run is not only to reach the next milestone, it is to
find the next thing the agent believes that is not true. Every bug in this project has been that
shape, and every one was found by watching a run rather than by reading the code. So while it
plays:

- Watch `.agent-state/agent.log` and the in-game plan board. When the colony looks busy and is
  not achieving anything, that is the signal. Call `GET /diagnose` and read what it says.
- When you find a cause, fix it in the code, write down in the commit what was believed and what
  was actually true, then start a **new run** to test the fix.
- Add what you learn to `reference/GAME-FACTS.md`, with the belief it corrects. That file is the
  accumulated difference between what this agent assumed and what RimWorld actually does.
- If a number came from your memory rather than from the def files or from the live game, treat
  it as a guess and go and check it. Several already were, and each one cost a colony.

## The scripted first week

RimWorld's Cassandra and Phoebe storytellers run `StorytellerComp_ClassicIntro` (read from
`Assembly-CSharp` in 1.6.4871). It fires the same incidents on the same ticks in every run:

| Tick | When | What |
|---|---|---|
| 150,000 | day 3, 12h | friendly visitors (a chance to trade) |
| 204,000 | day 4, ~10h | one ThreatSmall: a single wild animal of combat power 40 or less (squirrel, rat, raccoon, vulture, ...) goes manhunter; with Anomaly, possibly a small shambler swarm |
| 264,000 | day 5, ~10h | one random Misc incident |
| 324,000 | day 6, ~10h | a 40-point raid; one raider is **forced to be downed instead of killed** and never flees |

Five colonies on 2026-09-22/23 lived to tick 204,000. All five met a hostile within 300 ticks of
it, three were downed by it, and one of the two survivors was kidnapped by the 324,000 raid while
starving through a mental break. The agent now prepares (`prepareForScriptedThreats`): a weapon
from day 3, speed 1 around each threat, an announcement to chat an hour ahead, and a prisoner
sleeping spot before day 6, because that downed raider is the colony's first recruit.

## Combat

`decideCombat` in `scripts/tactics.mjs` decides, from the game's own combat power numbers in
`reference/game-data.json` (regenerate with `npm run build:data`):

- **Contact means fight.** Turning away hands out free hits.
- **A small animal (combat power 45 or less) means fight**, even unarmed. Every animal a founder
  has met is at least as fast as a person, and Odyssey's birds fly.
- **Outmatched with a finished house closer than the enemy: go inside and hold.** Animals cannot
  open doors; raiders have to break them.
- **Otherwise fight.** There is no "run to the map edge": that order was given toward a corner the
  game called unreachable, and the founder was downed from behind.

A ranged colonist first walks to three quarters of its weapon's range, then shoots: a drafted
ranged attack out of range is refused, not walked into. The bridge's `/attack` does the same now
(it finds a firing position), and only falls back to melee for pawns with no ranged weapon.

## The house

`roomPlan()` in `colony-agent.mjs` lays out named rooms that share walls, each with its own door:

    bed3 | bed4            (bands extend north as the colony grows)
    bed1 | bed2
    workshop -- great hall -- kitchen -- cold room
              warehouse                              prison (detached)

`buildRoom` refuses to order a room it cannot pay for in full: an unclosed rectangle gets no
roof, no temperature and none of the mood that justified building it. The great hall is 20 walls
and 4 doors, 200 wood and 6100 work, so at Construction 4 it is most of two in-game days. That
is the honest reason a house does not appear on day one.

Storage is sorted, not piled: goods indoors, food and fresh animal carcasses in the cold room,
human bodies and insect bodies in separate pits far from anyone's line of sight. The cold room
needs a **Cooler**: 90 steel and 3 components, so it is gated on mining and trade, not on wood.

---

## The task board

`POST /hud/tasks` draws the agent's plan inside the game window, top left, where the stream can
read it:

    {"goal":"1 of 50 colonists","day":"Day 5","blocker":"great hall needs 40 more wood",
     "tasks":[{"label":"Campfire","state":"done"},
              {"label":"Great hall","state":"blocked","note":"175/215 wood"}]}

`state` is `done`, `doing`, `blocked` or `queued`. The agent posts this automatically whenever
it re-plans (founding, each day boundary, or when something invalidates the plan). The same
payload goes to the browser overlay at `POST /api/plan` on the studio.


---

## The stream

The broadcast is three pieces: a capture process, the studio, and two on-screen panels.

**Capture and encode.** `stream-app/capture-window.swift` uses ScreenCaptureKit to capture only
the RimWorld window, letterboxed onto a fixed 1280x720 canvas at 25 fps (1080p30 fell behind real
time on this Mac), plus system audio with the microphone explicitly excluded.
`stream-app/streamer.mjs` encodes through `h264_videotoolbox` at 4500 kbps with 2-second
keyframes and writes FLV to `stream-app/bin/rtmps-relay`, which publishes to Twitch over RTMPS.
**The stream key is never in any process's arguments or environment**: the relay reads the URL
from file descriptor 3 and refuses anything but `rtmps://`. If RimWorld restarts mid-broadcast
the capture emits black frames and reattaches to the new window; if the window stays gone past
`STREAM_WINDOW_LOST_GRACE_MS` (120 s) the broadcast is cut rather than pushing a frozen frame.
Rebuild both binaries with `npm run build:stream`.

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

### Twitch chat is already connected

This is done; do not redo it. The Twitch application "RimWorld AI Streamer" exists, its
`TWITCH_CLIENT_ID` is in `.env`, and the OAuth token is stored, so the bot posts as
`sonoflilith94` with the scopes `chat:read`, `chat:edit` and `channel:manage:broadcast`. The
studio also sets the channel title and category on start.

Check it rather than assume it:

    curl -s -H 'Host: localhost:18888' http://127.0.0.1:18888/api/settings | jq '{hasClientId,hasOauth,botUsername}'

Both flags should be true. If `hasOauth` goes false the token has expired, and re-authorising
means a human opening `http://localhost:18888/auth/twitch` in a browser and signing in. An agent
cannot do that step and must not try: say so and carry on without chat posting, which costs
nothing else, because reading chat works anonymously.

Send a message with:

    curl -s -X POST -H 'Host: localhost:18888' -H 'Content-Type: application/json' \
      http://127.0.0.1:18888/api/chat/send -d '{"message":"..."}'

The field is `message`, not `text`. A message beginning with `!` is handled as a command rather
than posted.

Speak in chat sparingly and only when there is something to say: a colonist joining or dying, a
raid, a room finished, or an answer to a viewer. Unprompted play-by-play from the streamer's own
account reads as a bot flooding its own channel, which is why commentary goes to the overlay and
the in-game HUD instead.

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
- `ThingDef.IsWeapon` is **true for WoodLog**: a log is an improvised melee weapon. Ask whether
  something is stuff before asking whether it could be swung.
- A `DiningChair` is 8000 work against a `Stool`'s 450 for the same seat at the same table.
- Sleeping rough is three separate -4 thoughts (`SleptOutside`, `SleptInCold`, `SleptOnGround`)
  that stack to -12 a night against a 35% break threshold.
- A pawn completes every job at one priority before it looks at the next, and ignores distance
  while doing so. Two work types sharing a priority is a real decision, not a tie. With a house
  blueprinted and a cook bill running, a colonist will cook the twelfth meal before laying the
  first wall unless Construction outranks Cooking.
- `/things` caps `limit` at 500 and lists things in spawn order, so an unfiltered listing of a big
  rect fills with trees and rock cells before the blueprints, which spawn last. That is how the
  agent once laid out five rooms on three hundred wood. Always filter (`cat=Ethereal`,
  `cat=Building&player=1`). The colony-building query in `occupancy()` has the same 500 ceiling:
  fine for a dozen rooms, and something to page with `offset` before the house passes about
  twenty rooms.
- Blueprints and frames are `ThingCategory.Ethereal`, and `/things` leaves Ethereal out of an
  unfiltered listing. Ask for `cat=Ethereal`, or a def containing `Blueprint` or `Frame`, or the
  pending build is invisible and the agent will re-order a room it already paid for.
- Lay blueprints as soon as the material exists. A blueprint costs nothing and takes no time; it
  is how the colonist is given the work. Waiting for one build to finish before ordering the next
  left a house unstarted behind a bed that had nine ticks of work left. Order one room at a time
  though, because each room is checked against the same pile of wood and four of them will all
  pass the same check.

---

## Rules

- **Do not fabricate.** Never write that something is built, verified or approved without the
  tool output that shows it. Everything here is checkable against the live game, which you
  cannot fake. If you did not do it, say you did not do it. Mark unmade decisions **UNDECIDED**
  and illustrative blocks **TEMPLATE**.
- **A passing curl is not a working system.** Check the game state, not your own logs.
- A mod change needs a RimWorld restart, and a restart means a new run. Do not reload a save to
  test a fix: the save carries the world the old code built, so a fix can look like it worked
  when it only inherited someone else's result.
- Slow to speed 1 during raids, mental breaks, injuries and letters. Speed 3 is fine while the
  colony is only chopping, sowing and hauling. The agent does this itself; do not pin `--speed`
  unless you mean to override it.
- No dev mode, no god mode, no `/dev/*` routes.
- Save daily. The agent does, and the daily save's `503` is expected, not an error.
- Never paste `ps` output, logs or screenshots that could carry the stream key without checking.
  `npm run status` redacts; raw `ps` of an old build does not. A leaked key must be rotated in the
  Twitch dashboard.
- Run `npm test` before and after any change to the agent. Every test names the run that failed
  without the behaviour it checks.

## What to report

Colonist count, the milestones in the current `runs/*.md`, what rooms actually stand (from
`/things/summary?cat=Building&player=1`), the current blocker, and any code you changed with the
reason. Quote the tool output.
