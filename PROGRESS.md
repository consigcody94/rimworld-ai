# RimWorld AI Bridge Progress

## The goal, as a ladder

The campaign is Naked Brutality on Cassandra, Rough: one colonist with nothing, toward the
**50-colonist challenge** in the stream title. No run has lived past day 9 yet, so the goal is
the next rung, not the last one. Each rung is a milestone the agent records in its run summary
(`runs/*.md`, "Milestones"), so progress is read off the runs rather than claimed.

| # | Milestone | Journal key | Best so far |
|---|---|---|---|
| 1 | Campfire, bed and the great hall standing | `campfire`, `bed`, `house` | campfire and bed; the hall was laid out, but founders still logged "Slept outside" on day 4 and day 9 |
| 2 | Armed before day 4 | `armed` | some runs, by luck of the founder's kit |
| 3 | Survive the scripted day-4 threat (tick 204,000) | `survived-small-threat` | 2 of 5 runs that reached it |
| 4 | Survive the scripted day-6 raid (tick 324,000) | `survived-intro-raid` | never |
| 5 | Take the day-6 raider alive and recruit him: a second colonist | `pop-2` | never; the capture code could not run. Return_e2lsge accepted a transport-pod survivor (Vaughan) as its founder was kidnapped; Vaughan then starved at mood 0 |
| 6 | A research project under way | `research` | never; research lived behind an unreachable phase |
| 7 | Alive on day 15, past Cassandra's first big-threat cycle (day 11+) | `day-15` | never |
| 8 | 5 colonists, each with a bedroom | `pop-5` | never |
| 9 | 10 colonists | `pop-10` | never |
| 10 | 20, 30, 40, 50 colonists | `pop-20` ... `pop-50` | never |

Streaming goals, standing: the broadcast runs only while a colony is loaded, never outlives the
game, never exposes the stream key, and chat hears about real events only.

## Now

2026-09-24. Nothing running; everything below verified offline (tests, compile, loopback), not in
a live game. The next step is a live run: `npm run up -- --new`, then watch days 3 to 7.

## Why colonies died, from the journals

Read from `runs/*.jsonl` (14 runs, 2026-09-22 and 23) and the game's own code.

1. **The phase gate was dead.** `currentPhase` waited on a `"hut"` key that nothing has set since
   the house became a plan of rooms. All 14 journals show only the food, basics and house phases:
   research, steel mining, defenses, trading and recruiting never ran once. Fixed: the house phase
   ends when the great hall stands (or two days after it was laid out), and research, rescue,
   capture and prisoners now run in every phase.
2. **The first week is scripted, and the agent did not know.** Cassandra and Phoebe run
   `StorytellerComp_ClassicIntro`: a manhunter animal of combat power 40 or less at tick 204,000
   and a 40-point raid at 324,000 whose one raider is forced downed rather than killed. Five runs
   reached day 4; all five met a hostile within 300 ticks of 204,000 and three were downed. Fixed:
   `prepareForScriptedThreats` arms the colony from day 3, slows to speed 1 around each threat,
   tells chat an hour ahead, and lays a prisoner spot before day 6.
3. **Combat odds were invented.** "Skill plus six for a weapon" against "three for any animal"
   made a naked founder think he outweighed a vulture 18 to 3, or flee from one toward a map corner
   the game called unreachable. Fixed: `decideCombat` uses the game's combat power table
   (`reference/game-data.json`), fights small animals and anything in contact, retreats only behind
   a finished door it can reach first, and never runs across open ground.
4. **Bows fired out of range.** `/attack` was refused as "Out of range" three times while a drifter
   closed in. Fixed in both places: the agent walks an archer to three quarters of its range first,
   and the bridge's `/attack` finds a firing position instead of meleeing with a bow.
5. **Prisoners could never be taken.** The capture code ordered the capture of an undefined
   variable and swallowed the error; the bed logic would have made the founder's only bed the
   prison bed. Fixed and tested.
6. **Mood bled out through the same few thoughts.** "Ate corpse" (-12, for days) from ordering a
   founder to eat raccoons whole, and a despised short bow (-10 a day from Ideology). Fixed: corpses
   are eaten only below 12% food, and a despised weapon switches the colony to the other kind.
7. **The daily save looked like a crash.** Its 503 was journaled as an error every day. Fixed.
8. **"Half a house."** The blueprint scan used one unfiltered listing of a 53x120 rect; on a forest
   map the page filled with trees and rock cells before the blueprints, so the agent saw no pending
   builds and laid out a new room on every pass. Return_e6zjy1 blueprinted five rooms in thirty
   seconds on 314 wood, and rooms whose blueprints did not all land were marked done and never
   revisited. Fixed: two filtered queries, a room stays "in progress" until every cell stands, and a
   cell the game refuses as occupied is treated as the wall it is.
9. **"Won't get wood."** The food emergency flag went up on day 1 and never came down (it waited for
   four days of stored food on a naked start), and while it was up no tree was ever designated and
   trees marked by hand were cancelled. Fixed: a fed colonist with walls waiting goes for wood, the
   flag clears when the colonist is fed, only the agent's own designations are ever cancelled, and
   the wood target is what the blueprints on the board still need.
10. **"It just stops."** A hung agent process looked alive to the supervisor. Fixed: the agent writes
   a heartbeat every turn and the supervisor kills and restarts it when that goes stale; the agent
   also kicks itself (work plan, unforbid, trees) after 25 idle turns with work on the board.

## Log

- 2026-09-19 Follow camera, in-game chat HUD, Vocello TTS, first broadcast. Run one: founder
  starved on day 3 inside a recreation timetable. Fixed, with the first 12 regression tests.
- 2026-09-19 The broadcast pushed a frozen frame for 62 minutes after RimWorld quit. Capture
  watchdog added.
- 2026-09-20 Base sited in fog: every blueprint refused. Fixed. Everything stopped; bridge mod
  disabled for normal play; GitHub up to date at `6551fed`.
- 2026-09-22/23 (Codex, uncommitted) Repo re-cloned into a Codex workspace with a Desktop symlink.
  Native RTMPS relay so the key leaves ffmpeg's argv; capture cut to 720p25; voice off; chat spam
  filter; safer eating; mud rejected for building; saved state keyed to map and founder;
  supervisor starts a fresh colony after a wipe; population target 50. Fourteen runs journaled
  across at least eight colonies; none past day 9.
- 2026-09-24 (Claude) Offline review of every run journal against the game's own code. Fixed the
  phase gate, combat, bow range, capture, beds, corpse eating, despised weapons, trap placement and
  save-time errors; added the scripted-week preparation and milestones. New `tactics.mjs`,
  `stack.mjs` (preflight/status/up/down) and supervisor crash resume. `/attack` finds a firing
  position. Child processes no longer inherit Twitch secrets. MCP server rebuilt (its `dist/` was
  missing from the new checkout, which is why every client reported it failed to connect).
  46 tests pass; 14 of the new agent tests fail against the previous agent. The relay was proven
  end to end over loopback RTMPS. Not yet run live.
- 2026-09-26 (Claude) Read the last run's log against the code and found the two stalls the human
  kept seeing: the truncated blueprint scan ("half a house") and the permanent food flag ("won't
  get wood"). Fixed both, plus a heartbeat watchdog, a stall kick, bedrooms right after the hall,
  a lighter resource scan, `npm run report`, `npm run pause/resume`, an OpenAI-compatible chat
  backend (NVIDIA NIM), and a one-page operator runbook (AGENTS.md = GEMINI.md, long reference
  moved to OPERATIONS.md). 58 tests; the seven new ones fail on the previous agent. Still offline.
