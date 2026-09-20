# Handoff: run Persona Core to ten colonists

You are taking over a live RimWorld 1.6 colony that is already running. The game is open, the
bridge is up, and the stream is broadcasting. Nothing needs installing.

## The goal

Reach **10 colonists** without dev mode and without god mode. `GET /status` reports `devMode`
and `godMode`; both must stay false. Every action goes through the HTTP bridge as a real game
order. No mouse automation.

## How to talk to the game

    curl -s -H 'X-Agent-Id: persona-core' http://127.0.0.1:18800/help | jq

That prints every route with its contract. The ones you will use most:

- `GET /snapshot`, `/colony`, `/pawns?player=1&detail=1`, `/pawn/{idOrName}?detail=1`
- `GET /things?def=X&detail=1&limit=N`, `/things/summary?cat=Building&player=1`
- `GET /resources` — **read the warning below**
- `GET /fertility?x=&z=&w=&h=&block=&min=&limit=` — ranks plantable soil, x/z is the CENTRE
- `POST /build`, `/build/bulk`, `/designate`, `/zone`, `/zone/update`, `/bill`, `/set_work`,
  `/pawn/schedule`, `/draft`, `/attack`, `/job`, `/speed`, `/game/save`
- Mutating routes need the header `X-Agent-Id: persona-core` (the agent lease).

The autonomous player is `scripts/colony-agent.mjs`. Start it with:

    node scripts/colony-agent.mjs        # adaptive speed
    node scripts/colony-agent.mjs --speed=1   # pin the speed

It logs to `.agent-state/agent.log` and journals each run to `runs/*.jsonl` and `.md`.

## Where the colony is right now

Founder **Castro**, 32. Melee 10★★, Plants 8★, Construction 4★, Mining 4★, Medicine 4.
Traits: Undergrounder, Jogger, **Night owl** (he is on a night shift: asleep 9h-15h).
Naked Brutality, Cassandra, Rough, temperate forest, large hills, spring, map 250.
Base anchor **(117, 100)**. Day 4. Food is solved: about 6 days stored, 60 cassowary and rat
meat, berries. Mood has been hovering near the 35% break threshold.

Built so far: sleeping spot, crafting spot, butcher spot. **No campfire, no bed, no house.**

## The bug that is blocking everything, already diagnosed

`GET /resources` reports only **stockpiled** material. Anything lying where it fell is not
counted. The colony has **329 wood in nine piles** around the base and `/resources` says
**12**. Every build gate in `colony-agent.mjs` reads that 12, so:

- the campfire (20 wood) is never placed,
- `cheapDone` in `manageBase` never becomes true, because it requires a campfire and a bed,
- therefore **not one room is ever laid out**.

Verify it yourself before you act on it:

    curl -s -H 'X-Agent-Id: persona-core' 'http://127.0.0.1:18800/things?def=WoodLog&detail=1&limit=100' \
      | python3 -c "import sys,json;ts=json.load(sys.stdin)['things'];print(sum(t.get('count',1) for t in ts))"
    curl -s -H 'X-Agent-Id: persona-core' http://127.0.0.1:18800/resources | grep -o '"WoodLog":[0-9]*'

A method `trueResources(snap)` was written for this and is **present but not wired in**. It sums
loose stacks within 45 cells of the base and merges them over `/resources`. Wiring it is:

1. In `runTurn`, replace `const resources = snap.resources ?? {};` with
   `const resources = await this.trueResources(snap);`
2. In `manageBase`, the campfire and bed are gated on `wood >= 20` / `wood >= 45`. Drop those
   gates: a blueprint costs nothing to place and tells the colonist what the wood is for.

## The house it is supposed to build

`roomPlan()` in `colony-agent.mjs` lays out named rooms that share walls, each with its own door:

    bed3 | bed4            (bands extend north as the colony grows)
    bed1 | bed2
    workshop -- great hall -- kitchen -- cold room
              warehouse                              prison (detached)

The great hall is the hub with four doors, one per adjoining room, and costs about 200 wood
(a wall is 5, a door is 25). `buildRoom` refuses to order a room it cannot pay for in full,
because an unclosed rectangle gets no roof. Storage is sorted: goods indoors, food and fresh
carcasses in the cold room, human bodies and insect bodies in separate far pits.

## Rules

- **Do not fabricate.** Do not write that something is built, verified or approved unless you
  have the tool output showing it. Claims here are checked against the live game, which you
  cannot fake. If you did not do it, say you did not do it.
- Mark anything undecided as **UNDECIDED**. Mark illustrative output **TEMPLATE**.
- No dev mode, no god mode, no `/dev/*` routes.
- Slow the game to speed 1 during raids, mental breaks, injuries and letters. Speed 3 is fine
  while the colony is only chopping, sowing and hauling.
- Save daily with `POST /game/save`.

## What to report back

The colonist count, what rooms actually stand (from `/things/summary?cat=Building&player=1`),
and anything you changed in the code with the reason.
