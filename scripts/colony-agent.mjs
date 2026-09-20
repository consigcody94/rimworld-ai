#!/usr/bin/env node
/**
 * Autonomous RimWorld Colony Agent ("Persona Core")
 *
 * Plays RimWorld through the AI Bridge mod (http://127.0.0.1:18800) with no dev mode and no
 * god mode. Built for a Naked Brutality caveman start that grows into a real colony, but every
 * routine is generic: needs first, threats second, then food, shelter, production, research,
 * trade and stream presentation.
 *
 * Loop shape:
 *   observe (/snapshot)  ->  react (combat, needs, letters)  ->  plan (periodic routines)  ->  present (camera, overlay, voice)
 *   Peacetime turns run every `stepMs` at game speed `speed`; combat turns run every `combatMs` at speed 1.
 *
 *   Speed defaults to 1, not 3. A turn costs real wall-clock time: reading the colony, deciding,
 *   and issuing orders. At 3x the game ran roughly three in-game hours per decision, so a raid,
 *   a hunt gone wrong or a mental break played out entirely between two turns and the agent only
 *   ever saw the aftermath. A colony was lost that way, one colonist dead and one kidnapped, with
 *   no order issued during either event. Speed 1 keeps decisions inside the events they concern.
 *
 * CLI: node scripts/colony-agent.mjs [--speed=1] [--step-ms=700] [--combat-ms=250] [--turns=N] [--no-save] [--quiet]
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = path.join(ROOT, ".agent-state");
const RUNS_DIR = path.join(ROOT, "runs");

const API_BASE = (process.env.RIMWORLD_API ?? "http://127.0.0.1:18800").replace(/\/$/, "");
const STUDIO_BASE = (process.env.STREAM_STUDIO ?? "http://127.0.0.1:18888").replace(/\/$/, "");
const AGENT_ID = process.env.RIMWORLD_AGENT_ID ?? "persona-core";

// ============================================================================
// HTTP helpers
// ============================================================================

async function request(method, path, body = null, timeoutMs = 30000) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: { "Content-Type": "application/json", "X-Agent-Id": AGENT_ID },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok && json.ok !== true) {
    const err = new Error(`${json.error ?? res.statusText ?? "request failed"} (HTTP ${res.status} ${method} ${path})`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

const api = {
  get: (path) => request("GET", path),
  post: (path, body) => request("POST", path, body),
  /** POST that swallows errors and returns null. Most game orders are best-effort. */
  tryPost: async (path, body) => { try { return await request("POST", path, body); } catch { return null; } },
};

async function studio(path, body) {
  try {
    await fetch(STUDIO_BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1500),
    });
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dist = (a, b) => Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.z ?? 0) - (b.z ?? 0));

// ============================================================================
// Knowledge
// ============================================================================

/** Research order. The agent picks the first available project from this list, else the first available. */
/**
 * Research order, once survival is handled.
 *
 * Naked Brutality already starts with Electricity, Air conditioning and Nutrient paste, so this
 * does not waste time re-earning them. The order is weapons, then clothes, then food that keeps,
 * then power, because a colony dies to a raid or to winter long before it dies of having no
 * solar panels.
 */
const TECH_ORDER = [
  // Weapons and the bench that makes them.
  "Smithing",              // unlocks the smithy: real melee weapons
  "RecurveBow",            // better bow, still neolithic cheap
  "Greatbow",
  "Gunsmithing",           // firearms
  "BlowbackOperation",
  "PrecisionRifling",
  // Clothes and the bench that makes them.
  "ComplexClothing",
  "Stonecutting",          // blocks for walls that do not burn
  // Food that keeps.
  "Pemmican",              // 70 day shelf life, no cooking skill needed
  "PackagedSurvivalMeal",
  "NutrientPaste",
  // Power and the comforts it buys.
  "Batteries",
  "SolarPanels",
  "WatermillGenerator",
  "AirConditioning",       // a freezer ends food spoilage permanently
  "PassiveCooler",
  // Everything after this is a long game.
  "ComplexFurniture",
  "MicroelectronicsBasics",
  "Machining",
  "Hydroponics",
  "MedicineProduction",
  "Fabrication",
  "AdvancedFabrication",
  "Bionics",
  "ShipBasics",
];

/** Animals a lone bow hunter can take without real risk. Matched against the pawn kind label. */
const SMALL_GAME = ["squirrel", "hare", "rat", "chinchilla", "turkey", "chicken", "duck", "guinea pig", "raccoon", "capybara", "muffalo calf", "tortoise", "snake", "cobra", "iguana", "monkey", "cat",
  // Birds. Every one of these was missing, and on the map this colony landed on the two nearest
  // animals to the base were a quail and a bluebird, so a starving founder was told there was no
  // safe game within seventy five cells while breakfast stood twenty cells away.
  "quail", "bluebird", "sparrow", "crow", "pigeon", "goose", "duck", "gull", "emu", "ostrich", "cassowary", "chinchilla", "boomrat"];
/** Tiny game an unarmed colonist can safely beat to death when there is nothing else to eat. */
const TINY_GAME = [
  "squirrel", "rat", "hare", "rabbit", "chinchilla", "chicken", "duck", "guinea pig", "turkey",
  "tortoise", "monkey", "cat", "pigeon", "swan", "goose", "raccoon", "sparrow", "finch", "crow",
  "gazelle fawn", "capybara", "iguana", "snake", "cobra", "tailed", "lizard", "hen", "rooster",
];
/** Never hunt these; they revenge. */
const DANGEROUS_GAME = ["bear", "wolf", "warg", "cougar", "panther", "lynx", "boar", "boomalope", "boomrat", "rhino", "elephant", "thrumbo", "megasloth", "muffalo", "bison", "alpaca", "deer", "elk", "caribou", "horse", "donkey"];

/** The run's objective. Everything in manageGrowth exists to reach this. */
const POPULATION_TARGET = Number(process.env.POPULATION_TARGET ?? 10);

/** Letter labels that mean a person may be joining. Cast wide: this is the growth path. */
const JOIN_LETTER = /join|wander|refugee|joins|asks to join|ally|gift|escape pod|crash|survivor|shelter|seeks|stranger|man in black|beggar/;

/** Jobs that mean "this pawn is busy doing something worth watching". */
const IDLE_JOBS = new Set(["Wait", "Wait_Wander", "Wait_MaintainPosture", "GotoWander", "Goto"]);

// ============================================================================
// Agent
// ============================================================================

export class ColonyAgent {
  constructor(options = {}) {
    this.speed = options.speed ?? 1;
    // Pinned only when the caller asked for a specific speed on the command line.
    this.autoSpeed = options.autoSpeed ?? true;
    this.lastSpeed = null;
    this.stepMs = options.stepMs ?? 700;
    this.combatMs = options.combatMs ?? 250;
    this.saveDaily = options.saveDaily ?? true;
    this.quiet = options.quiet ?? false;

    this.turn = 0;
    this.lastLease = 0;
    this.base = null;              // { x, z }
    this.placed = new Map();       // key -> { def, x, z }
    this.failedPlacements = new Map(); // key -> attempts
    this.placedAt = new Map();
    this.builtDefs = new Set();
    this.phase = null;
    this.phaseReason = "";     // key -> turn it was last placed, so blueprints are not re-placed
    this.zones = new Set();
    this.configured = new Set();   // pawn ids with settings applied
    this.joyMode = new Map();      // pawn id -> turn the joy schedule started
    this.seenLetters = new Set();
    this.inCombat = false;
    this.combatPosture = null;
    this.lastAttackOrder = new Map(); // pawn id -> turn
    this.lastDay = null;
    this.lastSavedDay = null;
    this.lastVoiceAt = new Map();  // topic -> ms
    this.lastRoutine = new Map();  // routine -> turn
    this.followTarget = null;
    this.followSince = 0;
    this.foodEmergency = false;
    this.weaponRush = false;
    this.workPlanMode = null;
    this.appliedSchedule = new Map();  // pawn id -> schedule preset last applied
    this.helpless = false;
    this.fleeSet = new Set();
    this.evadeGoal = new Map();
    this.seenQuests = new Set();
    this.lastKnownPopulation = null;
    this.skillCache = new Map();
    this.stats = { turns: 0, combatTurns: 0, orders: 0, errors: 0 };
  }

  // ---------------------------------------------------------------- journal

  /**
   * Every run writes a JSONL journal plus a Markdown summary under runs/. The point is to be
   * able to read back afterwards why a colony died, which decisions preceded it, and what the
   * colony looked like at the time, rather than reconstructing it from console scrollback.
   */
  openJournal(snap) {
    if (this.journalPath) return;
    try { mkdirSync(RUNS_DIR, { recursive: true }); } catch {}
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const name = (snap.colonyName ?? "colony").replace(/[^a-z0-9]/gi, "_");
    this.runId = `${name}-${stamp}`;
    this.journalPath = path.join(RUNS_DIR, `${this.runId}.jsonl`);
    this.runStarted = Date.now();
    this.journalCounts = {};
    this.journal("run-start", {
      colony: snap.colonyName,
      date: snap.date,
      tick: snap.tick,
      colonists: (snap.colonists ?? []).map((c) => c.name),
      agentOptions: { speed: this.speed, stepMs: this.stepMs, combatMs: this.combatMs, target: POPULATION_TARGET },
    });
    this.log(`Journal: ${this.journalPath}`);
  }

  /** Append one structured event. Never throws: a broken journal must not stop the run. */
  journal(type, data = {}, snap = null) {
    if (!this.journalPath) return;
    this.journalCounts[type] = (this.journalCounts[type] ?? 0) + 1;
    const row = {
      at: new Date().toISOString(),
      turn: this.turn,
      tick: this.lastTick ?? null,
      day: this.lastDay ?? null,
      type,
      ...data,
    };
    if (snap) {
      row.vitals = {
        colonists: (snap.colonists ?? []).length,
        nutrition: snap.foodNutrition ?? 0,
        wood: snap.resources?.WoodLog ?? 0,
        steel: snap.resources?.Steel ?? 0,
        research: snap.research ? `${snap.research.label} ${Math.round((snap.research.progress ?? 0) * 100)}%` : null,
        hostiles: (snap.hostiles ?? []).length,
        moods: (snap.colonists ?? []).map((c) => Math.round((c.needs?.mood ?? 0) * 100)),
        health: (snap.colonists ?? []).map((c) => Math.round((c.health?.pct ?? 1) * 100)),
      };
    }
    try { appendFileSync(this.journalPath, JSON.stringify(row) + "\n"); } catch {}
  }

  /** Write a human-readable summary next to the journal. Called on each new day and on exit. */
  writeRunSummary(snap) {
    if (!this.journalPath) return;
    const mins = Math.round((Date.now() - this.runStarted) / 60000);
    const cols = snap?.colonists ?? [];
    const lines = [
      `# Run ${this.runId}`,
      "",
      `- Colony: ${snap?.colonyName ?? "?"}`,
      `- In-game: day ${this.lastDay ?? "?"}, ${snap?.date ?? "?"}`,
      `- Wall clock: ${mins} minutes`,
      `- Turns: ${this.stats.turns} (${this.stats.combatTurns} in combat)`,
      `- Orders issued: ${this.stats.orders}`,
      `- Errors: ${this.stats.errors}`,
      `- Population: ${cols.length} of ${POPULATION_TARGET}`,
      "",
      "## Colonists",
      ...(cols.length ? cols.map((c) => `- ${c.name}: ${Math.round((c.health?.pct ?? 1) * 100)}% health, mood ${Math.round((c.needs?.mood ?? 0) * 100)}%, ${c.weapon ? `armed with ${c.weapon}` : "unarmed"}`) : ["- none"]),
      "",
      "## Event counts",
      ...Object.entries(this.journalCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`),
      "",
      `Full journal: \`${path.relative(ROOT, this.journalPath)}\``,
      "",
    ];
    try { writeFileSync(this.journalPath.replace(/\.jsonl$/, ".md"), lines.join("\n")); } catch {}
  }

  // ---------------------------------------------------------------- logging

  log(msg) { if (!this.quiet) console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }

  async thought(text) {
    this.log(`THOUGHT ${text}`);
    this.journal("thought", { text });
    await studio("/api/thought", { text });
    // Deliberately NOT pushed to the in-game chat HUD. That box is the real Twitch channel and
    // nothing else: filling it with the agent's own internal notes makes it read as fabricated
    // chat, which is worse than an empty box.
  }

  /**
   * Report a game event to the studio, which writes and speaks a line about it.
   * Nothing here is a pre-written script: the agent supplies the fact, the studio's
   * brain turns it into live commentary grounded in the colony and the chat room.
   * `topic` is only a cooldown key so one kind of event cannot spam the stream.
   */
  async narrate(topic, event, detail, cooldownMs = 90000, options = {}) {
    const last = this.lastVoiceAt.get(topic) ?? 0;
    if (Date.now() - last < cooldownMs) return;
    this.lastVoiceAt.set(topic, Date.now());
    await studio("/api/commentary", {
      event,
      detail,
      priority: options.priority ?? "normal",
      askChat: Boolean(options.askChat),
    });
  }

  every(routine, turns) {
    const last = this.lastRoutine.get(routine) ?? -Infinity;
    if (this.turn - last < turns) return false;
    this.lastRoutine.set(routine, this.turn);
    return true;
  }

  // ---------------------------------------------------------------- lifecycle

  async ensureLease() {
    if (Date.now() - this.lastLease < 60000) return;
    await api.tryPost("/agent/claim", { agent: AGENT_ID, leaseSec: 300 });
    this.lastLease = Date.now();
  }

  async waitUntilPlaying() {
    let announced = false;
    for (;;) {
      try {
        const h = await api.get("/health");
        if (h.playing && !h.loading) return;
        if (!announced) { this.log(`Waiting for a running game (state=${h.programState}, loading=${h.loading})...`); announced = true; }
      } catch (e) {
        if (!announced) { this.log(`Bridge unreachable (${e.message}); waiting...`); announced = true; }
      }
      await sleep(2000);
    }
  }

  async runForever(maxTurns = Infinity) {
    await this.waitUntilPlaying();
    let count = 0;
    while (count < maxTurns) {
      try {
        const combat = await this.runTurn();
        count++;
        await sleep(combat ? this.combatMs : this.stepMs);
      } catch (err) {
        this.stats.errors++;
        this.log(`TURN ERROR ${err.message}`);
        this.journal("error", { message: err.message, status: err.status ?? null });
        if (/not in playing|unreachable|fetch failed|timeout|HTTP 409|HTTP 503/i.test(err.message)) {
          await this.waitUntilPlaying();
        } else {
          await sleep(1500);
        }
      }
    }
  }

  // ---------------------------------------------------------------- one turn

  async runTurn() {
    this.turn++;
    this.stats.turns++;
    await this.ensureLease();

    const snap = await api.get("/snapshot");
    this.lastTick = snap.tick ?? null;
    this.openJournal(snap);
    const colonists = (snap.colonists ?? []).filter((c) => !c.dead);
    const hostiles = snap.hostiles ?? [];
    // Counts loose logs and steel around the base as well as stockpiled material, because a
    // blueprint is served just as well by a log lying where the tree fell.
    const resources = await this.trueResources(snap);
    this.lastCounted = resources;
    const day = Math.floor((snap.tick ?? 0) / 60000) + 1;
    if (this.every("built-scan", 6)) {
      try {
        const sum = await api.get("/things/summary?cat=Building&player=1");
        this.builtDefs = new Set((sum.groups ?? []).map((g) => g.def));
      } catch {}
    }

    if (colonists.length === 0) {
      await this.thought("No living colonists. Waiting for a game with colonists.");
      await sleep(5000);
      return false;
    }

    // First contact: anchor the base on the founder and set the colony up.
    if (!this.base) await this.foundColony(snap, colonists);

    // Never sit paused: close popups and restore speed. Dialogs like settlement naming get accepted.
    if (snap.paused) {
      await api.tryPost("/dialog/close", { all: true });
    }

    const threats = this.activeThreats(colonists, hostiles);
    if (threats.length > 0) {
      await this.combatTurn(colonists, threats, snap);
      // A helpless colony should not spin at combat cadence; pace it like peacetime.
      return !this.helpless;
    }
    if (this.inCombat) await this.endCombat(colonists);

    // Adaptive: fast through the grind, back to 1 the moment anything needs a decision.
    const want = this.autoSpeed ? this.desiredSpeed(colonists, snap, threats) : this.speed;
    if (snap.paused || snap.speed !== want) {
      await api.tryPost("/speed", { speed: want });
      if (want !== this.lastSpeed) {
        this.log(`Speed ${want}x: ${this.speedReason}.`);
        this.lastSpeed = want;
      }
    }

    // 1. Colonist needs, threats and letters are always on. Everything else is gated by the
    //    current phase.
    await this.manageNeeds(colonists, snap, resources);
    await this.manageLetters(snap, colonists);
    await this.diagnoseMood(colonists, snap);

    // 2. One objective at a time.
    //
    //    An earlier version ran every routine every turn: sowing, chopping, hauling, bed
    //    placement, foraging and research all at once. A single colonist cannot do six things,
    //    so it finished none of them, and the colony starved on day 2 with a half built hut, an
    //    unsown field and no bed. A phase completes before the next one starts.
    const phase = this.currentPhase(colonists, snap, resources);
    if (phase !== this.phase) {
      this.phase = phase;
      this.phaseStartedTurn = this.turn;
      this.log(`PHASE -> ${phase}`);
      this.journal("phase", { phase, reason: this.phaseReason }, snap);
      await this.thought(`Phase: ${phase}. ${this.phaseReason}`);
      await this.narrate(`phase-${phase}`, "new objective", `${this.phaseReason}`, 60000);
    }

    // Whatever the phase, nobody is left standing drafted in peacetime.
    if (threats.length === 0 && this.every("undraft", 4)) await this.endMeleeHunt(colonists, threats);

    // Blueprints go down in every phase, including the food phase.
    //
    // This is the bug that ended four colonies with no house. Placing buildings lived only in
    // the build phases, and a colony of one is under the forty five percent hunger line most of
    // the time, so the phase was "food" almost continuously and manageBase ran once in an entire
    // run. No campfire was ever placed, which meant the cheap-things gate never opened, which
    // meant no room was ever laid out. The founder cut wood he was never asked to use.
    //
    // Deciding WHAT to order and deciding WHAT TO DO FIRST are different jobs. The work
    // priorities already answer the second one, and they answer it every time the colonist picks
    // up a new job rather than once per phase. So the board is kept stocked here unconditionally,
    // and a hungry colonist simply eats before it builds, which is what the priorities are for.
    await this.equipFoundWeapons(colonists);
    await this.maybeReplan(colonists, snap, resources, threats);
    if (this.every("build", 8)) await this.manageBase(colonists, resources);

    switch (phase) {
      case "food":
        // Nothing but calories. Cutting trees and harvesting berries are the same work type, so
        // leaving chop designations standing means the colonist fells a poplar while starving.
        await this.allowFood();
        // Chopping a tree and picking a berry are the same designation and the same work type,
        // so the colony can want one or the other but never both. That decision used to be made
        // twice, by two routines on different clocks: one designated trees for the bow, the
        // other cancelled them to protect the foraging, and with the colonist standing idle
        // between them the pair thrashed every few seconds and issued hundreds of dead orders.
        // It is one decision now, made here, from how much food is actually in store.
        // Twenty wood is a campfire, and a campfire is the difference between a cooked meal and
        // "ate corpse", which is minus twelve mood and the single largest thing holding this
        // colony at its break threshold. So chopping is only suspended in a real emergency, when
        // someone is genuinely close to collapsing, and not merely because food is short: at
        // forty percent fed with berries in the pile, an hour with an axe is worth more than
        // another hour of picking.
        const collapsing = (this.hungriest ?? 1) < 0.28;
        const built = this.builtDefs ?? new Set();
        const needsFire = !built.has("Campfire") && (resources.WoodLog ?? 0) < 25;
        if (collapsing && !needsFire) {
          if (this.every("clear-chop", 10)) await this.clearWoodDesignations();
        } else if (((resources.WoodLog ?? 0) < 30 || needsFire) && this.every("wood-for-fire", 10)) {
          await this.manageWood(resources);
        }
        if (this.every("food", 3)) await this.manageFood(colonists, snap, resources);
        // Crops are not a later phase, they are the way out of this one. A growing zone costs
        // nothing, sowing is Growing work rather than PlantCutting so it never competes with
        // foraging, and rice feeds a colonist from about day six. Every colony that starved here
        // starved before day six.
        if (this.every("farm", 20)) await this.manageFarms(colonists.length);
        await this.manageSchedules(colonists);
        // The free structures are part of the food solution, not a distraction from it: the
        // crafting spot makes the bow, the butcher spot turns a kill into meat, and both cost
        // nothing and take almost no work.
        if (this.every("free-build", 10)) await this.ensureFreeStructures();
        // The bow is PART of solving hunger, not a project that waits until hunger is solved.
        // RimWorld will not let a pawn take a hunt job without a ranged weapon, so a colony with
        // no bow cannot eat meat at all. Leaving the bow to its own phase deadlocked the agent:
        // it stayed in the food phase forever because food was low, while the one thing that
        // would have produced food sat behind a phase it could never reach.
        if (colonists.every((c) => !c.weapon) && (resources.WoodLog ?? 0) >= 30) {
          if (this.every("weapons", 6)) await this.manageWeapons(colonists, resources);
          if (this.every("bills", 8)) await this.manageBills(resources);
        }
        break;

      case "basics":
        // Campfire and a bed. Cheap, fast, and they stop the mood spiral before it starts.
        if (this.every("wood", 8)) await this.manageWood(resources);
        if (this.every("food", 10)) await this.manageFood(colonists, snap, resources);
        break;

      case "comfort":
        if (this.every("wood", 12)) await this.manageWood(resources);
        if (this.every("food", 10)) await this.manageFood(colonists, snap, resources);
        break;

      case "weapon":
        await this.allowFood();
        if (this.every("weapons", 6)) await this.manageWeapons(colonists, resources);
        if (this.every("bills", 8)) await this.manageBills(resources);
        if (this.every("food", 5)) await this.manageFood(colonists, snap, resources);
        // Only fetch more wood if the bow cannot be paid for yet.
        if ((resources.WoodLog ?? 0) < 30 && this.every("wood", 10)) await this.manageWood(resources);
        break;

      case "house":
        if (this.every("wood", 8)) await this.manageWood(resources);
        if (this.every("food", 10)) await this.manageFood(colonists, snap, resources);
        break;

      case "farm":
        if (this.every("farm", 10)) await this.manageFarms(colonists.length);
        if (this.every("food", 8)) await this.manageFood(colonists, snap, resources);
        break;

      case "grow":
      default:
        await this.manageDefenses(resources);
        if (this.every("food", 8)) await this.manageFood(colonists, snap, resources);
        if (this.every("wood", 15)) await this.manageWood(resources);
        if (this.every("steel", 40)) await this.manageSteel(resources, colonists, day);
        if (this.every("build", 12)) await this.manageBase(colonists, resources);
        if (this.every("bills", 25)) await this.manageBills(resources);
        if (this.every("research", 20)) await this.manageResearch(snap.research);
        if (this.every("trade", 20)) await this.manageTrade();
        await this.manageGrowth(colonists, snap, resources);
        if (this.every("prisoners", 15)) await this.managePrisoners(colonists, snap);
        break;
    }

    // 3. Always on, cheap, and needed in every phase.
    await this.manageCorpses();
    await this.manageUpgrades();
    if (this.every("work", 30)) await this.manageWork(colonists);
    await this.enableAllWork(colonists);
    if (this.every("supplies", 40)) await this.manageSupplies(resources);

    if (colonists.length >= POPULATION_TARGET && this.every("milestone", 300)) {
      await this.thought(`Milestone: ${colonists.length} colonists.`);
      await this.narrate("milestone", "milestone reached", `The colony has reached ${colonists.length} living colonists on day ${day}.`, 0, { priority: "high", askChat: true });
    }

    if (day !== this.lastDay) await this.onNewDay(day, snap, colonists);

    // 11. Camera and status.
    await this.manageCamera(colonists, false);
    if (this.every("status", 5)) this.printStatus(snap, day, colonists);
    return false;
  }

  // ---------------------------------------------------------------- diagnostics

  /**
   * Read the actual mood ledger for a colonist: every thought and what it is worth.
   *
   * Guessing at mood cost a colony. The real numbers on a day-3 naked start were Malnourished
   * -20, then Slept in the cold, Slept outside, Slept on ground and Uncomfortable for another
   * -15 between them, against a break threshold of 35. Food and a bed are not two separate
   * problems, they ARE the mood problem.
   */
  async moodLedger(pawnId) {
    try {
      const d = await api.get(`/pawn/${pawnId}?detail=1`);
      const thoughts = (d.thoughts ?? []).map((t) => {
        const m = String(t).match(/^(.*?)\s*([+-]\d+(?:\.\d+)?)$/);
        return m ? { label: m[1].trim(), effect: Number(m[2]) } : { label: String(t), effect: 0 };
      });
      const negatives = thoughts.filter((t) => t.effect < 0).sort((a, b) => a.effect - b.effect);
      return { thoughts, negatives, worst: negatives[0] ?? null };
    } catch { return { thoughts: [], negatives: [], worst: null }; }
  }

  /** Log the mood breakdown when a colonist is near breaking, so the cause is on the record. */
  async diagnoseMood(colonists, snap) {
    for (const c of colonists) {
      const mood = c.needs?.mood ?? 1;
      const threshold = c.moodBreakThreshold ?? 0.35;
      if (mood > threshold + 0.12) continue;
      if (!this.every(`mood-diag-${c.id}`, 60)) continue;
      const { negatives } = await this.moodLedger(c.id);
      if (negatives.length === 0) continue;
      const top = negatives.slice(0, 4).map((t) => `${t.label} ${t.effect}`).join(", ");
      const total = negatives.reduce((a, t) => a + t.effect, 0);
      this.log(`MOOD ${c.name} at ${Math.round(mood * 100)}% (break ${Math.round(threshold * 100)}%): ${top} [total ${total}]`);
      this.journal("mood-breakdown", {
        pawn: c.name,
        mood: Math.round(mood * 100),
        threshold: Math.round(threshold * 100),
        negatives: negatives.map((t) => [t.label, t.effect]),
      }, snap);
      this.worstMood = { pawn: c.name, negatives };
    }
  }

  // ---------------------------------------------------------------- phases

  /**
   * Exactly one objective is active at a time, chosen by what the colony is missing most.
   * Ordering is survival first: calories, then something to fight with, then a roof, then the
   * mood furniture, then fields, then everything else.
   */
  currentPhase(colonists, snap, resources) {
    const nutrition = snap.foodNutrition ?? 0;
    const hungriest = Math.min(...colonists.map((c) => c.needs?.food ?? 1));
    const daysOfFood = colonists.length ? nutrition / (colonists.length * 1.6) : 99;
    const wood = resources.WoodLog ?? 0;
    const built = this.builtDefs ?? new Set();
    const unarmed = colonists.filter((c) => !c.weapon && !c.downed).length;
    const hasTable = built.has("Table1x2c") || built.has("Table2x2c");
    const hasChair = built.has("Stool") || built.has("DiningChair");

    // Ordered by value per unit of wood and time, which is not the same as order of size. A bed
    // is 45 wood and removes a mood penalty every single night; a hut is 85 wood and several
    // hours of construction. One run chopped 224 wood and still had no house, because the walls
    // were started before the cheap things that actually keep a colonist alive and sane.
    // A field of ripening rice is food, even though none of it is in a stockpile yet. Counting
    // only what is stored pinned the colony in the food phase with a fed colonist, twenty seven
    // rice plants in the ground and no house, because stored nutrition read zero and always
    // would until the first harvest came in.
    const cropDays = (this.sownCrops ?? 0) * 0.28 / Math.max(1, colonists.length * 1.6);
    const supply = daysOfFood + Math.min(cropDays, 4);
    this.foodDays = daysOfFood;
    this.cropDays = cropDays;
    this.hungriest = hungriest;
    if (hungriest < 0.45 || supply < 1.5) {
      this.phaseReason = `Food first: the hungriest colonist is at ${Math.round(hungriest * 100)} percent, ${daysOfFood.toFixed(1)} days stored` +
        (cropDays > 0 ? ` and about ${cropDays.toFixed(1)} more standing in the fields.` : ".");
      return "food";
    }
    // House, bed, food, table, in that order once there is a survival floor of food.
    //
    // A roof and a bed are worth more than anything else the colony can spend wood on: sleeping
    // outdoors on the ground in the cold is Slept in the cold, Slept outside, Slept on ground and
    // Uncomfortable all at once, about minus fifteen mood every night, against a break threshold
    // of thirty five. A table is another three. Those thoughts are most of why colonies here have
    // broken down, so they come before a weapon and before expanding the fields.
    if (!built.has("Campfire") || !this.hasAnyBed(built)) {
      this.phaseReason = !built.has("Campfire")
        ? "A campfire next: warmth, light and cooked meals for twenty wood."
        : "A bed next: sleeping on the ground costs mood every single night, and it is forty five wood.";
      return "basics";
    }
    if (!this.placed.has("hut")) {
      this.phaseReason = `Walls and a roof now, with ${wood} wood on hand. Sleeping outside is worth about minus fifteen mood a night on its own.`;
      return "house";
    }
    if (!hasTable || !hasChair) {
      this.phaseReason = "A table and a stool. Eating off the floor is a penalty paid at every single meal, for about fifty wood.";
      return "comfort";
    }
    // Only once there is a roof: a bow matters, but not more than not freezing.
    if (unarmed === colonists.length && wood >= 30) {
      this.phaseReason = `Nothing here can hunt or fight. A short bow is thirty wood and it is the difference between foraging scraps and eating meat.`;
      return "weapon";
    }
    if (daysOfFood < 6) {
      this.phaseReason = `Fields next: ${daysOfFood.toFixed(1)} days of food is not a buffer.`;
      return "farm";
    }
    this.phaseReason = `Survival is handled. Growing the colony toward ${POPULATION_TARGET}.`;
    return "grow";
  }

  /**
   * Is a bed handled? A frame or a blueprint counts.
   *
   * This gated the entire house. A bed under construction is `Frame_Bed`, which this used to
   * reject, so the colony waited for the bed to be finished before a single wall blueprint was
   * laid. Laying a blueprint costs nothing and takes no time: it is how the colonist is given
   * the work in the first place. Waiting for one job to finish before ordering the next is the
   * opposite of how a RimWorld work board is meant to be used.
   */
  hasAnyBed(built) {
    for (const def of built) {
      const clean = String(def).replace(/^(Blueprint|Frame)_/i, "");
      if (/^(Bed|DoubleBed|RoyalBed|Bedroll)/.test(clean)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- founding

  stateFile(snap) {
    const key = `${(snap.colonyName ?? "colony").replace(/[^a-z0-9]/gi, "_")}`;
    return path.join(STATE_DIR, `${key}.json`);
  }

  loadState(snap) {
    try {
      const f = this.stateFile(snap);
      if (!existsSync(f)) return null;
      return JSON.parse(readFileSync(f, "utf8"));
    } catch { return null; }
  }

  saveState(snap) {
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(this.stateFile(snap), JSON.stringify({
        base: this.base,
        mapSize: this.mapSize,
        zones: [...this.zones],
        placed: [...this.placed.entries()],
      }, null, 2));
    } catch {}
  }

  /**
   * Where to put the house, given where the good soil is.
   *
   * Anchoring on whatever cell the founder happened to be standing on put the base on top of the
   * only fertile ground within twenty cells, and then the farm planner had to reject that ground
   * precisely because the house was going to be built on it. The colony ended up walking twenty
   * cells to sow every seed on soil no better than the soil it was standing on.
   *
   * So the soil is chosen first and the house is placed beside it: far enough east that the
   * workshop wall never lands on a crop, close enough that sowing, weeding and hauling the
   * harvest are all a few seconds' walk. A candidate is rejected if the ground the house itself
   * would stand on is water, since nothing can be built there.
   */
  async chooseBase(founder) {
    const margin = 30, size = this.mapSize ?? 250, max = size - margin;
    const clamp = (v) => Math.round(Math.min(max, Math.max(margin, v)));
    const fallback = { x: clamp(founder.x), z: clamp(founder.z) };

    let best = null;
    try {
      const scan = await api.get(`/fertility?x=${Math.round(founder.x)}&z=${Math.round(founder.z)}&w=56&h=56&block=7&min=0.95&limit=30`);
      const near = (scan.best ?? []).filter((c) => c.distanceFromCentre <= 26);
      for (const soil of near) {
        // House core sits east of the field, with the workshop's west wall clear of the last row.
        const cand = { x: clamp(soil.x + 19), z: clamp(soil.z + 3) };
        if (dist(cand, founder) > 30) continue;
        if (await this.buildableGround(cand)) { best = { cand, soil }; break; }
      }
    } catch {}

    if (!best) {
      this.log("No fertile block close enough to build beside; anchoring on the founder.");
      return fallback;
    }
    this.log(`Base at (${best.cand.x}, ${best.cand.z}), ${best.soil.distanceFromCentre} cells from the founder, with ${best.soil.fertility} fertility soil starting ${best.cand.x - best.soil.x - 7} cells west of the workshop wall.`);
    return best.cand;
  }

  /**
   * Would the house stand up here?
   *
   * Two ways it cannot. Water, which nothing builds on, and fog: RimWorld refuses every
   * blueprint in territory the colony has not discovered, with "Cannot place in undiscovered
   * areas". The fog check was missing and it cost a whole run. The base was sited nineteen cells
   * from the best soil, in ground the founder had never walked, so every build order was refused
   * and place() swallowed the error. The colony held a hundred and forty eight wood, the plan
   * read "doing: Campfire", and not one blueprint existed.
   */
  async buildableGround(b) {
    const samples = [[0, 0], [-8, 0], [14, 0], [0, -8], [0, 8], [-8, -8], [14, 8], [0, 20]];
    try {
      const cells = await Promise.all(samples.map(([dx, dz]) =>
        api.get(`/cell?x=${b.x + dx}&z=${b.z + dz}`).catch(() => null)));
      let bad = 0, fogged = 0;
      for (const c of cells) {
        if (!c) { bad++; continue; }
        if (c.fogged) fogged++;
        const terrain = String(c.terrain ?? "");
        if (/Water|Marsh|Lake|Ice/i.test(terrain)) bad++;
      }
      // Any fog in the footprint at all disqualifies the site: a colony cannot build its way out
      // of ground it has not seen, and it will not wander there on its own to reveal it.
      if (fogged > 0) return false;
      return bad <= 1;
    } catch { return true; }
  }

  async foundColony(snap, colonists) {
    try {
      const m = await api.get("/map");
      this.mapSize = m.size?.x ?? 250;
    } catch { this.mapSize = 250; }

    // A base anchor is permanent for the life of a colony: reload it rather than
    // re-anchoring wherever the founder happens to be standing after a restart.
    const saved = this.loadState(snap);
    if (saved?.base) {
      this.base = saved.base;
      for (const z of saved.zones ?? []) this.zones.add(z);
      for (const [k, v] of saved.placed ?? []) this.placed.set(k, v);
      this.log(`Resuming colony at saved base (${this.base.x}, ${this.base.z}).`);
      await this.thought(`Resuming ${snap.colonyName ?? "the colony"} at (${this.base.x}, ${this.base.z}).`);
      return;
    }

    // Fresh colony: put the house beside the best farmland, not on top of it.
    const founder = colonists[0];
    this.base = await this.chooseBase(founder);
    const b = this.base;
    this.log(`Founding colony at (${b.x}, ${b.z}) with ${colonists.map((c) => c.name).join(", ")}.`);
    await this.thought(`Founded ${snap.colonyName ?? "the colony"} at (${b.x}, ${b.z}). Founder: ${founder.name}.`);
    await this.narrate("founding", "colony founded", `${founder.name} has landed with nothing at all. Naked Brutality start, no weapon, no food, no shelter. Base anchored at ${b.x}, ${b.z} in a ${snap.weather ?? "clear"} ${snap.temperatureC ?? "?"} degree temperate forest.`, 0, { priority: "high", askChat: true });

    // Deliberately NOT designating trees here. The build footprint can wait: a chop designation
    // issued at founding is the first thing on the work board, shares the HarvestPlant
    // designation and the PlantCutting work type with berries, and a pawn clears every job at one
    // priority before looking at the next. Three founders spent their first two days felling oaks
    // at single digit food because of this one call.
    // Home area around the base so items on the ground count and get hauled.
    const home = await api.tryPost("/area/home", { rect: { x: b.x - 16, z: b.z - 16, w: 33, h: 33 }, add: true });
    this.log(`Home area: ${home ? JSON.stringify(home).slice(0, 120) : "failed"}`);
    await api.tryPost("/allow", { home: true });
    // The outdoor stockpile is a staging area only: everything moves indoors to the warehouse as
    // soon as that room stands. Goods left in the weather deteriorate, and a colonist fetching
    // steel from across the map loses an hour to it.
    if (!this.zones.has("stockpile")) {
      const z = await api.tryPost("/zone", { type: "stockpile", rect: { x: b.x - 2, z: b.z - 7, w: 5, h: 3 }, priority: "Normal", label: "Staging" });
      if (z) this.zones.add("stockpile");
    }
    // The sorted pits (human, insect, rubble) and the cold room come from manageStorage, which
    // waits until their rooms exist. This one catches anything that dies before then.
    if (!this.zones.has("dumping")) {
      const z = await api.tryPost("/zone", { type: "dumping", rect: { x: b.x - 32, z: b.z - 30, w: 5, h: 5 }, label: "Far pit" });
      if (z) {
        this.zones.add("dumping");
        await this.thought("Far pit placed thirty cells out: a rotting corpse in sight is minus eighteen mood, every time anyone walks past it.");
      }
    }
    // Five of the most important early buildings cost nothing at all and take no work. There is
    // never a resource excuse for skipping them, so they go down on the first turn.
    await this.place("sleepingspot", "SleepingSpot", b.x - 1, b.z - 1);
    await this.place("craftingspot", "CraftingSpot", b.x - 6, b.z + 1);
    // Rice, immediately. A growing zone costs nothing, sowing is Growing work rather than
    // PlantCutting so it does not compete with foraging, and 25 tiles feeds one colonist
    // indefinitely from about day six. Every colony that starved did so before day six.
    await this.manageFarms(colonists.length);
    // Arming the colony is the single highest-value thing in the first two days. Two founders
    // have now been lost to a drifter while the colony had hundreds of wood and no weapon.
    this.weaponRush = true;
    // A butcher spot is free and is the only way a hunted animal becomes food.
    await this.place("butcherspot", "ButcherSpot", b.x + 6, b.z + 2);
    await this.manageWork(colonists);
    await this.manageWood(snap.resources ?? {});
    this.saveState(snap);
  }

  // ---------------------------------------------------------------- combat

  activeThreats(colonists, hostiles) {
    return hostiles.filter((h) => {
      if (h.dead || h.downed) return false;
      const report = `${h.job?.def ?? ""} ${h.job?.report ?? ""}`.toLowerCase();
      if (report.includes("attack") || report.includes("fight") || report.includes("hunt")) return true;
      const near = Math.min(...colonists.map((c) => dist(c, h)));
      return near < 30;
    });
  }

  isHumanlike(t) {
    return Boolean(t.gender) || Boolean(t.faction) || /raider|pirate|tribal|mercenary|scavenger|outlander|soldier|thief|hunter|warrior|grenadier|sniper/i.test(`${t.kind ?? ""} ${t.faction ?? ""}`);
  }

  isBigAnimal(t) {
    const k = (t.kind ?? "").toLowerCase();
    return DANGEROUS_GAME.some((d) => k.includes(d));
  }

  /** A point `range` cells from `from`, directly away from `threat`, clamped to the map. */
  awayFrom(from, threat, range = 28) {
    const dx = from.x - threat.x, dz = from.z - threat.z;
    const len = Math.hypot(dx, dz) || 1;
    const size = this.mapSize ?? 250;
    const x = Math.round(Math.min(size - 8, Math.max(8, from.x + (dx / len) * range)));
    const z = Math.round(Math.min(size - 8, Math.max(8, from.z + (dz / len) * range)));
    return { x, z };
  }

  /** Does this hostile shoot? A ranged attacker cannot be out-walked; a melee one can be fought. */
  isRanged(t) {
    const w = (t.weapon ?? "").toLowerCase();
    if (!w) return false;
    return /rifle|gun|pistol|revolver|shotgun|bow|launcher|cannon|charge|sniper|smg|carbine|lmg|minigun|grenade|spear thrower|blowgun/.test(w);
  }

  /**
   * Decide the posture for this fight. Three cases, in order:
   *  - Any hostile already in melee contact: FIGHT. Walking away from a drawn knife just
   *    hands the attacker free hits in the back, which is how a solo founder dies.
   *  - Ranged attackers we cannot answer, a large predator, or being outnumbered 2 to 1: EVADE.
   *  - Otherwise: FIGHT.
   */
  /** Rough melee capability: skill plus whether they are holding anything at all. */
  meleePower(c) {
    const skills = this.skillCache.get(c.id) ?? {};
    const raw = skills.Melee;
    const lvl = typeof raw === "number" ? raw : parseInt(String(raw ?? "0"), 10) || 0;
    return lvl + (c.weapon ? 6 : 0) + ((c.health?.pct ?? 1) > 0.8 ? 1 : 0);
  }

  /**
   * Decide the posture for this fight.
   *
   * Learned the hard way, twice: a single colonist with no weapon and Melee 0 does NOT beat a
   * drifter carrying a knife. The first run fled and was cut down from behind; the second stood
   * and fought and was beaten unconscious. Neither is survivable, so the only winning move for
   * an outmatched colony is to break contact early, before the enemy is adjacent, and keep the
   * colonists inside the base where a door and distance buy time.
   */
  decidePosture(colonists, threats) {
    const able = colonists.filter((c) => !c.downed && (c.health?.pct ?? 1) > 0.25);
    if (able.length === 0) return { evade: false, reason: "nobody can act" };

    const armedThreats = threats.filter((t) => t.weapon);
    const ourPower = able.reduce((a, c) => a + this.meleePower(c), 0);
    // A raider with a weapon is worth roughly a skilled armed colonist.
    const theirPower = threats.reduce((a, t) => a + (t.weapon ? 8 : 3) + (this.isBigAnimal(t) ? 6 : 0), 0);
    const outmatched = ourPower < theirPower;

    const inContact = threats.some((t) => able.some((c) => dist(c, t) <= 2.0));
    if (inContact && !outmatched) {
      return { evade: false, reason: "already in contact and we can take them" };
    }
    if (outmatched) {
      return {
        evade: true,
        reason: `outmatched ${Math.round(ourPower)} to ${Math.round(theirPower)}: ${able.filter((c) => c.weapon).length} of ${able.length} armed against ${armedThreats.length} armed hostile(s)`,
      };
    }
    if (threats.some((t) => this.isBigAnimal(t)) && able.every((c) => !c.weapon)) {
      return { evade: true, reason: "large predator and nothing to fight it with" };
    }
    return { evade: false, reason: `we outweigh them ${Math.round(ourPower)} to ${Math.round(theirPower)}` };
  }

  async combatTurn(colonists, threats, snap) {
    this.stats.combatTurns++;
    const able = colonists.filter((c) => !c.downed && (c.health?.pct ?? 1) > 0.15);

    // Nobody can act. Holding the game at speed 1 here just makes downed colonists bleed out in
    // real time while the agent issues nothing, so hand the clock back and stop re-entering
    // combat mode until someone is on their feet.
    if (able.length === 0) {
      if (!this.helpless) {
        this.helpless = true;
        this.log(`COMBAT no able colonists; releasing the clock and waiting for recovery.`);
        await this.thought(`Every colonist is down or too hurt to fight. Nothing left to order. Letting the clock run and hoping someone gets up.`);
        await this.narrate("helpless", "colony incapacitated", `All ${colonists.length} colonist(s) are downed or under 15 percent health with ${threats.length} hostile(s) still on the map.`, 0, { priority: "high" });
      }
      await api.tryPost("/speed", { speed: this.speed });
      this.inCombat = false;
      return;
    }
    this.helpless = false;
    const armed = able.filter((c) => c.weapon);
    const posture = this.decidePosture(colonists, threats);
    // Posture is sticky for a fight: flip-flopping between fleeing and fighting is the worst option.
    if (!this.inCombat) {
      this.combatPosture = posture;
      this.inCombat = true;
      const names = [...new Set(threats.map((t) => t.kind ?? t.name))].join(", ");
      this.log(`COMBAT ${threats.length} threat(s): ${names} (${posture.evade ? "EVADE" : "FIGHT"}: ${posture.reason})`);
      this.journal("combat-start", {
        threats: threats.map((t) => ({ kind: t.kind, weapon: t.weapon ?? null, faction: t.faction ?? null })),
        posture: posture.evade ? "evade" : "fight",
        reason: posture.reason,
        armed: armed.length,
        able: able.length,
      }, snap);
      await this.thought(`Threat: ${names}. ${posture.evade ? "Evading" : "Fighting"}, because ${posture.reason}.`);
      await this.narrate("combat", posture.evade ? "threat, evading" : "threat, fighting",
        `${threats.length} hostile ${names}${threats[0]?.weapon ? ` carrying a ${threats[0].weapon}` : ""}. We have ${armed.length} armed of ${able.length}. Decision: ${posture.evade ? "evade" : "fight"}, because ${posture.reason}. Do not claim anyone is dead, hurt or winning: report only this decision.`,
        30000, { priority: "high" });
    } else if (this.combatPosture?.evade && !posture.evade) {
      // Contact was made while running. Turn and fight.
      this.combatPosture = posture;
      this.log("COMBAT posture switched to FIGHT (contact made).");
      await this.thought("They caught us. Turning to fight rather than taking hits in the back.");
    }
    if (snap.speed !== 1 || snap.paused) await api.tryPost("/speed", { speed: 1 });

    if (this.combatPosture?.evade) {
      for (const c of able) {
        const nearest = threats.slice().sort((a, b2) => dist(a, c) - dist(b2, c))[0];
        if (!nearest) continue;
        // Hostility response is sticky; setting it every turn just floods the main thread pump.
        if (!this.fleeSet.has(c.id)) {
          await api.tryPost("/pawn/settings", { pawn: c.id, hostility: "Flee" });
          this.fleeSet.add(c.id);
        }
        // Run for the base, not simply away: the hut is walled with a door, and standing in the
        // open getting chased is how both previous founders died. Only pick a new destination
        // when the current one stops making sense, so the pawn is not restarting its path every
        // 250 ms and effectively standing still.
        const homeDist = dist(c, this.base);
        const threatToHome = dist(nearest, this.base);
        const goal = (homeDist > 6 && threatToHome > homeDist)
          ? { x: this.base.x, z: this.base.z }
          : this.awayFrom(c, nearest, 32);
        const last = this.evadeGoal.get(c.id);
        const moved = !last || Math.hypot(last.x - goal.x, last.z - goal.z) > 6;
        const idle = !(c.job?.def ?? "").startsWith("Goto");
        if (moved || idle) {
          this.evadeGoal.set(c.id, goal);
          await api.tryPost("/move", { pawn: c.id, x: goal.x, z: goal.z, draft: true });
          this.stats.orders++;
        }
      }
    } else {
      for (const c of able) {
        const target = threats.slice().sort((a, b2) => dist(a, c) - dist(b2, c))[0];
        if (!target) continue;
        const attacking = (c.job?.def ?? "").toLowerCase().includes("attack");
        const last = this.lastAttackOrder.get(c.id) ?? -99;
        if (!attacking || this.turn - last > 8) {
          await api.tryPost("/attack", { pawn: c.id, target: target.id, draft: true });
          this.lastAttackOrder.set(c.id, this.turn);
          this.stats.orders++;
        }
      }
      // Only pull a badly hurt colonist out if someone else is still holding the line.
      for (const c of colonists) {
        if (c.downed || (c.health?.pct ?? 1) > 0.3 || able.length <= 1) continue;
        await api.tryPost("/move", { pawn: c.id, x: this.base.x, z: this.base.z, draft: true });
      }
    }
    await this.manageCamera(colonists, true);
  }

  async endCombat(colonists) {
    this.fleeSet.clear();
    this.evadeGoal.clear();
    this.journal("combat-end", {
      hurt: colonists.filter((c) => (c.health?.pct ?? 1) < 0.9).map((c) => ({ name: c.name, health: Math.round((c.health?.pct ?? 1) * 100) })),
    });
    this.inCombat = false;
    this.combatPosture = null;
    for (const c of colonists) {
      if (c.drafted) await api.tryPost("/draft", { pawn: c.id, drafted: false });
      await api.tryPost("/pawn/settings", { pawn: c.id, hostility: "Attack", selfTend: true });
    }
    await api.tryPost("/speed", { speed: this.speed });
    await this.thought("Threat cleared. Back to work; wounds get tended first.");
    await this.narrate("combat-end", "threat cleared", `The fight is over. ${colonists.filter((c) => (c.health?.pct ?? 1) < 0.9).length} colonist(s) came out hurt. Undrafting and tending wounds.`, 30000);
  }

  // ---------------------------------------------------------------- needs

  async manageNeeds(colonists, snap, resources) {
    for (const c of colonists) {
      const n = c.needs ?? {};
      const food = n.food ?? 1, rest = n.rest ?? 1, mood = n.mood ?? 1, joy = n.joy ?? 1;
      const threshold = c.moodBreakThreshold ?? 0.35;
      const h = c.health ?? {};
      const job = c.job?.def ?? "";

      if (!this.configured.has(c.id)) {
        // Self-tend is not optional for a solo colony: without it one bleeding wound ends the run.
        await api.tryPost("/pawn/settings", { pawn: c.id, selfTend: true, medicalCare: "Best", hostility: "Flee" });
        this.configured.add(c.id);
      }

      // Hunger cancels recreation, and it has to be checked here, above every early return.
      // A pawn put on the joy timetable by Rule 4 stays there until Rule 4's own exit branch
      // clears it, and that branch sits at the bottom of this loop, past Rule 1's `continue`.
      // So a pawn that grew hungry while in joy mode could never leave it: the food emergency
      // below skips joy-mode pawns, and Rule 1 returned before the exit branch could run. It
      // swam and slept through its own starvation while the agent narrated that food was the
      // only priority. That is how the 2026-09-19 run lost its founder. Hunger wins.
      if (this.joyMode.has(c.id) && food < 0.35) {
        this.joyMode.delete(c.id);
        await api.tryPost("/pawn/schedule", { pawn: c.id, preset: "anything" });
        await this.thought(`${c.name} is at ${Math.round(food * 100)}% food; recreation window cut short and back on the work timetable.`);
      }

      // The default Anything schedule is deliberately left in place. Pawns on it work and manage
      // their own needs; a permanent Work timetable carries a high mental break risk, and forcing
      // one onto a starving colonist is how a run ended with a pawn in psychosis at 3% mood.

      // Rule 0: bleeding out is faster than starving, so a serious injury is handled even when
      // the pawn is also hungry. The hunger branch below returns early, which used to skip this.
      const seriouslyHurt = (h.bleedRate ?? 0) > 0.15 || (h.needsTending && (h.pct ?? 1) < 0.6);
      if (seriouslyHurt && !c.inBed && !c.drafted && !this.inCombat && this.every(`bedrest-${c.id}`, 60)) {
        const bed = await this.nearestBed(c);
        if (bed) { await api.tryPost("/job", { pawn: c.id, job: "LayDown", targetA: bed.id }); this.stats.orders++; }
        await this.thought(`${c.name} is hurt (${Math.round((h.pct ?? 1) * 100)}% health, bleed ${h.bleedRate ?? 0}); bed rest and self tending.`);
        await this.narrate(`hurt-${c.id}`, "colonist injured", `${c.name} is at ${Math.round((h.pct ?? 1) * 100)} percent health with a bleed rate of ${h.bleedRate ?? 0}. Ordering bed rest and self tending.`, 240000);
      }

      // Rule 0b: a pawn in a mental break ignores every order the bridge can send. Issuing
      //          more of them wastes the main-thread pump and hides the actual cause, which is
      //          almost always hunger or mood that was let slide too far.
      if (c.mentalState) {
        if (this.every(`break-${c.id}`, 60)) {
          await this.thought(`${c.name} is in a mental break (${c.mentalState}) and will not take orders. Mood ${Math.round(mood * 100)}%, food ${Math.round(food * 100)}%.`);
          await this.narrate(`break-${c.id}`, "mental break", `${c.name} has broken down: ${c.mentalState}. They are beyond orders until it passes. Mood was ${Math.round(mood * 100)} percent and food ${Math.round(food * 100)} percent.`, 180000, { priority: "high" });
        }
        continue;
      }

      // Rule 1: a hungry pawn eats before anything else. Never send a starving pawn to bed.
      // The threshold is deliberately high. Three colonies died of the same spiral: hunger drags
      // mood down, low mood triggers a break, a broken pawn refuses orders, and by then nothing
      // can be done. Eating at 55% costs a few minutes of work; eating at 30% costs the run.
      if (food < 0.55) {
        // If anything edible is reachable, eat it. The colony's own AI normally handles this,
        // so this only fires in the case that actually kills colonists: food exists and the
        // pawn is busy with something else.
        if (await this.eatSomething(c)) continue;
        if ((snap.foodNutrition ?? 0) < 4) await this.forage(c);
        if (food < 0.15) {
          // A rested pawn asleep or at recreation on 15% food is dying of a timetable, not of
          // exhaustion. Interrupt it. A genuinely tired pawn (rest under 30%) is left alone.
          const atLeisure = c.asleep || /joy|play|relax|watch|skygaze|meditat|social|swim/i.test(job);
          if (atLeisure && rest > 0.3 && !c.drafted && this.every(`wake-${c.id}`, 20)) {
            await api.tryPost("/job/cancel", { pawn: c.id });
            this.stats.orders++;
            await this.thought(`${c.name} was ${c.asleep ? "asleep" : job || "at leisure"} on ${Math.round(food * 100)}% food with ${Math.round(rest * 100)}% rest. Interrupted.`);
          }
          if (this.every(`starving-${c.id}`, 40)) {
            await this.thought(`${c.name} is starving (${Math.round(food * 100)}%). Food is the only priority.`);
            await this.narrate(`starving-${c.id}`, "starvation risk", `${c.name} is at ${Math.round(food * 100)} percent food with only ${snap.foodNutrition ?? 0} nutrition stockpiled. Every other job is being dropped for food.`, 180000, { priority: "high", askChat: true });
            await this.huntSmallGame(colonists, resources, true);
          }
        }
        continue;
      }

      // Rule 3: exhaustion outside the sleep window, once.
      if (rest < 0.1 && !c.asleep && !c.inBed && !c.drafted && this.every(`exhausted-${c.id}`, 60)) {
        const bed = await this.nearestBed(c);
        if (bed) { await api.tryPost("/job", { pawn: c.id, job: "LayDown", targetA: bed.id }); this.stats.orders++; }
      }

      // Rule 4: mood. Only when a break is imminent and joy is actually low, and only for a short window.
      // `food >= 0.4` is load bearing. Without it this rule and the hunger check above fight
      // each other: mood puts the pawn on the joy timetable, hunger pulls them straight back
      // off, and the pair thrash every single turn while the pawn does neither.
      if (!this.joyMode.has(c.id) && mood < threshold + 0.02 && joy < 0.45 && food >= 0.4 && !this.inCombat) {
        this.joyMode.set(c.id, this.turn);
        await api.tryPost("/pawn/schedule", { pawn: c.id, preset: "joy" });
        await this.thought(`${c.name} mood ${Math.round(mood * 100)}% at break threshold ${Math.round(threshold * 100)}%. Short recreation window.`);
        await this.narrate(`mood-${c.id}`, "mood crisis", `${c.name} mood ${Math.round(mood * 100)} percent against a break threshold of ${Math.round(threshold * 100)} percent, joy ${Math.round(joy * 100)} percent. Switching them to a recreation schedule.`, 240000, { askChat: true });
      } else if (this.joyMode.has(c.id) && (mood > threshold + 0.08 || this.turn - this.joyMode.get(c.id) > 45)) {
        this.joyMode.delete(c.id);
        // Back to Anything, never to a forced Work timetable.
        await api.tryPost("/pawn/schedule", { pawn: c.id, preset: "anything" });
      }
    }
  }

  /**
   * Order a hungry pawn to eat the nearest edible item. Returns true if an eat order stuck.
   *
   * RimWorld's own pawn AI eats on its own when the timetable allows and the food is allowed
   * and reachable, so this is a backstop, not the main path. It exists for the failure that
   * actually kills colonists: there is food on the map and the pawn is doing something else.
   */
  async eatSomething(c) {
    if (/ingest/i.test(c.job?.def ?? "")) return true;      // already eating; leave it alone
    if (c.drafted || c.downed) return false;
    // Only step in when the pawn is plainly not feeding itself. RimWorld's own needs AI eats
    // when food is reachable and unforbidden, and a forced Ingest order cancels whatever it just
    // started, so issuing one every few turns actively prevents eating.
    const job = c.job?.def ?? "";
    const busyEating = /ingest|feedpatient/i.test(job);
    if (busyEating) return true;
    const idle = IDLE_JOBS.has(job) || job === "";
    if (!idle && (c.needs?.food ?? 1) > 0.12) return false;
    if (!this.every(`eat-${c.id}`, 25)) return false;
    const origin = this.base ?? c;
    const r = 60;
    try {
      // Items first (harvested food), then plants. A colonist can eat straight off a berry bush,
      // and a founder starved to death next to 83 of them because this only looked at items.
      const [items, plants] = await Promise.all([
        api.get(`/things?cat=Item&detail=1&rect=${origin.x - r},${origin.z - r},${r * 2 + 1},${r * 2 + 1}&limit=300`).catch(() => ({})),
        api.get(`/things?cat=Plant&detail=1&rect=${origin.x - 45},${origin.z - 45},91,91&limit=400`).catch(() => ({})),
      ]);
      const edible = [...(items.things ?? []), ...(plants.things ?? [])]
        .filter((t) => (t.nutrition ?? 0) > 0 && t.humanEdible !== false && t.x != null)
        .sort((a, b) => {
          // Prefer real food over grazing, then prefer whatever is closest.
          const kind = (t) => (t.cat === "Plant" ? 1 : 0);
          return (kind(a) - kind(b)) || (dist(a, c) - dist(b, c));
        });
      let target = edible.find((t) => !t.forbidden);
      // Starving beats tidy. Crash debris, drop pods, corpses and anything outside the home area
      // all arrive forbidden, so a hungry pawn can stand next to a survival meal and die of the
      // forbidden flag. Unforbid the one item it is about to eat, and nothing else.
      if (!target && edible.length > 0) {
        target = edible[0];
        await api.tryPost("/allow", { things: [target.id] });
        await this.thought(`Unforbidding ${target.label ?? target.def} so ${c.name} can eat it.`);
      }
      if (!target) return false;
      const edibleItem = target;
      const ok = await api.tryPost("/job", { pawn: c.id, job: "Ingest", targetA: edibleItem.id, count: 1 });
      if (!ok) return false;
      this.stats.orders++;
      await this.thought(`${c.name} sent to eat ${edibleItem.label ?? edibleItem.def} at ${edibleItem.x}, ${edibleItem.z}: ${Math.round((c.needs?.food ?? 0) * 100)}% food and it was busy with something else.`);
      return true;
    } catch { return false; }
  }

  async nearestBed(c) {
    try {
      // `def` on /things is a substring match, so this returns Bed, DoubleBed, RoyalBed and
      // HospitalBed. Exclude animal beds rather than anchoring the pattern, which used to throw
      // away exactly the good beds a colony upgrades to.
      const beds = await api.get("/things?cat=Building&player=1&def=Bed");
      const spots = await api.get("/things?cat=Building&player=1&def=SleepingSpot");
      const all = [...(beds.things ?? []), ...(spots.things ?? [])]
        .filter((t) => /bed|sleepingspot|bedroll/i.test(t.def ?? "") && !/animal/i.test(t.def ?? ""));
      // Prefer a medical bed for someone who needs tending, then the nearest.
      all.sort((a, b) => {
        const med = (t) => (/hospital/i.test(t.def ?? "") || t.medical ? 0 : 1);
        return (med(a) - med(b)) || (dist(a, c) - dist(b, c));
      });
      return all[0] ?? null;
    } catch { return null; }
  }

  // ---------------------------------------------------------------- food

  async manageFood(colonists, snap, resources) {
    const nutrition = snap.foodNutrition ?? 0;
    const raw = (resources.RawBerries ?? 0) + (resources.RawPotatoes ?? 0) + (resources.RawRice ?? 0) + (resources.RawCorn ?? 0);
    const meat = Object.entries(resources).filter(([k]) => k.startsWith("Meat_")).reduce((a, [, v]) => a + v, 0);
    const days = colonists.length > 0 ? nutrition / (colonists.length * 1.6) : 99;
    const hungriest = Math.min(...colonists.map((c) => c.needs?.food ?? 1));
    const starving = hungriest < 0.25 && nutrition < 2;

    try {
      const sown = await Promise.all(["Plant_Rice", "Plant_Potato", "Plant_Corn"].map((d) =>
        api.get(`/things?def=${d}&limit=300`).catch(() => ({}))));
      this.sownCrops = sown.reduce((n, r) => n + (r.things?.length ?? 0), 0);
    } catch {}

    if (days < 3 || starving) {
      // Armed? Hunt. That is where the calories are. Foraging is the fallback, not the plan.
      const armed = colonists.some((c) => c.weapon && !c.downed);
      if (armed) await this.huntSmallGame(colonists, resources, starving);
      await this.forage(colonists[0]);
      if (!armed) {
        await this.huntSmallGame(colonists, resources, starving);
        await this.meleeHunt(colonists, starving);
      }
      await this.endMeleeHunt(colonists);
    }

    // Starvation overrides the normal work plan: food work outranks wood and building until
    // there is a buffer again. Restored as soon as the colony has a few days of food.
    if (starving && !this.foodEmergency) {
      this.foodEmergency = true;
      this.journal("food-emergency", { nutrition, hungriest: Math.round(hungriest * 100), days: Number(days.toFixed(2)) }, snap);
      await this.syncWorkPlan(colonists);
      await this.thought("Food emergency. Hunting, growing and cooking outrank every other job until we have a buffer.");
    } else if (this.foodEmergency && days > 2.5) {
      this.foodEmergency = false;
      this.journal("food-recovered", { nutrition, days: Number(days.toFixed(2)) }, snap);
      await this.syncWorkPlan(colonists);
      await this.thought("Food buffer restored. Back to the normal work plan.");
    }
    // Make sure the butcher and cook bills exist as soon as there is anything to process.
    if ((raw > 0 || meat > 0 || starving || !this.placed.has("bill-butcher-any")) && this.every("food-bill", 15)) {
      await this.manageBills(resources);
    }
  }

  /** Count outstanding designations of a kind, so the agent never re-designates work already queued. */
  async pendingDesignations(kind) {
    try {
      const m = await api.get("/map");
      return (m.designations ?? {})[kind] ?? 0;
    } catch { return 0; }
  }

  async forage(near) {
    // Re-designating every twelve turns kept the board permanently full of berry bushes, and
    // since harvesting outranks sowing during a food emergency the founder never got back to the
    // rice. On a map whose wild bushes are a third grown, four berries is a tenth of a day's
    // nutrition and the rice field is nine days of it, three days out. Once a crop is in the
    // ground, foraging becomes the thing done between sowing jobs rather than instead of them.
    const cropsGrowing = (this.sownCrops ?? 0) > 0;
    if (!this.every("forage", cropsGrowing ? 45 : 12)) return;
    // Deliberately not gated on the HarvestPlant count: trees share that designation, so a board
    // full of oaks used to look like a board full of food and suppressed foraging entirely.
    const origin = this.base ?? near;
    try {
      // Find the food plants by definition across the whole map and take the nearest ones. A
      // rectangle around the base only catches what happens to be inside it: on one map that was
      // a single bush while a hundred stood a short walk away, and the founder starved.
      // Only plants whose harvest is actually food. "Plant_Bush" was in this list and is not: it
      // is the ordinary decorative bush, there are four hundred of them on a temperate map, and
      // they are always the nearest thing to the base. The colony spent its first days cutting
      // them for nothing while the berry bushes stood untouched.
      const defs = ["Plant_Berry", "Plant_Berry_Leafless", "Plant_Strawberry_Wild",
                    "Plant_Agave", "Plant_Nutrifungus", "Glowstool", "Agarilux"];
      const results = await Promise.all(defs.map((d) =>
        api.get(`/things?def=${d}&detail=1&limit=400`).catch(() => ({}))));
      const bushes = results
        .flatMap((r) => r.things ?? [])
        // 0.65, taken from the game's own plant definitions rather than guessed. Every Core
        // plant sets harvestMinGrowth to 0.65, and RimWorld refuses the harvest job below it:
        // a bush designated at a third grown is a walk across the map for a cancelled job. The
        // previous 0.32 here was a guess, and it was wrong.
        .filter((t) => t.x != null && (t.growth ?? 1) >= 0.65)
        .map((t) => ({ ...t, d: dist(t, origin) }))
        .sort((a, b) => a.d - b.d);
      if (bushes.length === 0) {
        this.log(`No grown food plants on the map yet (${results.flatMap((r) => r.things ?? []).length} still growing).`);
        return;
      }
      const take = bushes.slice(0, 25);
      const r = await api.tryPost("/designate", { type: "harvest", things: take.map((t) => t.id) });
      if (r && (r.designated ?? 0) > 0) {
        this.stats.orders++;
        await this.thought(`Foraging: ${r.designated} food plants designated, nearest ${Math.round(take[0].d)} cells from the base.`);
      }
    } catch {}
  }

  /**
   * Hunting with your hands, when there is no bow and no time to make one.
   *
   * RimWorld refuses a hunt job to anyone without a ranged weapon, which is correct for the work
   * board and wrong for a starving colony whose founder has Melee 10. A drafted pawn can walk up
   * to a quail and kill it, and that is the fastest food on the map: a bow is thirty wood and
   * several hours of crafting away, while the quail is twenty cells away right now.
   *
   * Only small, harmless game, only while genuinely starving, and only with a colonist who will
   * win. Sending a bad fighter at an animal barehanded is how a colony loses its founder.
   */
  async meleeHunt(colonists, starving) {
    if (!starving) return false;
    if (!this.every("melee-hunt", 20)) return false;
    if (colonists.some((c) => c.weapon && !c.downed)) return false;     // a bow exists: hunt properly

    const fighter = colonists.find((c) => !c.downed && !c.drafted &&
      (c.health?.pct ?? 1) > 0.75 && this.meleePower(c) >= 6);
    if (!fighter) return false;

    // Kills already on the ground come first. Chasing a third animal thirty cells out while two
    // carcasses lie unbutchered beside the base is how a hunter starves next to its own meat.
    try {
      const near = await api.get(`/things?cat=Item&detail=1&rect=${this.base.x - 20},${this.base.z - 20},41,41&limit=120`);
      const waiting = (near.things ?? []).filter((t) =>
        (t.corpse || /corpse/i.test(String(t.label ?? ""))) && !/human|raider|tribal|insect|mech/i.test(`${t.def} ${t.label}`));
      if (waiting.length >= 2) {
        if (this.every("hunt-hold", 30)) this.log(`Holding the hunt: ${waiting.length} carcasses still to butcher.`);
        return false;
      }
    } catch {}

    try {
      const res = await api.get("/pawns?role=wild_animal&limit=200");
      const prey = (res.pawns ?? [])
        .filter((a) => !a.dead && !a.downed && a.x != null)
        .filter((a) => {
          const kind = (a.kind ?? "").toLowerCase();
          if (DANGEROUS_GAME.some((d) => kind.includes(d))) return false;
          return SMALL_GAME.some((sm) => kind.includes(sm));
        })
        .map((a) => ({ ...a, d: dist(a, fighter) }))
        .filter((a) => a.d < 40)
        .sort((a, b) => a.d - b.d);
      if (prey.length === 0) return false;

      const target = prey[0];
      if (this.meleeTarget === target.id && this.turn - (this.meleeSince ?? 0) < 60) return true;
      this.meleeTarget = target.id;
      this.meleeSince = this.turn;

      await api.tryPost("/attack", { pawn: fighter.id, target: target.id, draft: true });
      this.stats.orders++;
      await this.thought(`${fighter.name} is going after a ${target.kind} bare handed, ${Math.round(target.d)} cells out. Melee ${this.meleePower(fighter)} against a ${target.kind}: that is a meal, and it is faster than carving a bow.`);
      await this.narrate("melee-hunt", "hunting bare handed", `No weapon and no food, so ${fighter.name} is walking down a ${target.kind} with bare hands. Melee skill ${this.meleePower(fighter)}.`, 180000, { priority: "high" });
      return true;
    } catch { return false; }
  }

  /**
   * Nobody stays drafted by accident.
   *
   * A drafted colonist does not eat, does not sleep and does not work: it stands where it was
   * put. The founder was left drafted after a hunt order when the agent process restarted and
   * lost track of the target, and spent the next in-game hours "watching for targets" at nine
   * percent food while its mood fell from thirty six to twenty one. So this does not depend on
   * remembering anything: if there is no fight and no live quarry, the draft comes off.
   */
  async endMeleeHunt(colonists, threats = []) {
    try {
      if (threats.length > 0) return;
      if (this.meleeTarget) {
        const still = await api.get(`/thing/${this.meleeTarget}`).catch(() => null);
        const alive = still && !still.dead && !still.downed;
        if (alive && this.turn - (this.meleeSince ?? 0) < 90) return;
        this.meleeTarget = null;
      }
      for (const c of colonists) {
        if (!c.drafted) continue;
        await api.tryPost("/draft", { pawn: c.id, drafted: false });
        this.log(`${c.name} was still drafted with nothing to fight; sent back to work.`);
      }
    } catch {}
  }

  async huntSmallGame(colonists, resources, starving = false) {
    // RimWorld will not assign a hunt job to a pawn without a ranged weapon, so designating
    // animals for an unarmed colony produces work nobody can take. One run stood idle at zero
    // percent food with eleven hunt designations on the board.
    const hunter = colonists.find((c) => c.weapon && !c.downed);
    if (!hunter) {
      if (starving && this.every("hunt-blocked", 40)) {
        this.log("Cannot hunt: nobody has a weapon, and RimWorld will not take a hunt job without one.");
      }
      return;
    }
    const meat = Object.entries(resources).filter(([k]) => k.startsWith("Meat_")).reduce((a, [, v]) => a + v, 0);
    if (meat > 40 && !starving) return;
    if (!this.every("hunt", starving ? 12 : 30)) return;
    // Unarmed colonists only hunt animals they can beat with their fists.
    const allowed = SMALL_GAME;
    try {
      const res = await api.get("/pawns?role=wild_animal");
      const prey = (res.pawns ?? []).filter((a) => {
        if (a.dead || a.downed) return false;
        const kind = (a.kind ?? "").toLowerCase();
        if (DANGEROUS_GAME.some((d) => kind.includes(d))) return false;
        if (!allowed.some((sm) => kind.includes(sm))) return false;
        return dist(a, this.base ?? hunter) < (starving ? 75 : 45);
      });
      prey.sort((a, b) => dist(a, hunter) - dist(b, hunter));
      const take = prey.slice(0, starving ? 3 : 2);
      if (take.length === 0) {
        if (starving) this.log(`No safe game within ${starving ? 75 : 45} cells of the base.`);
        return;
      }
      const r = await api.tryPost("/designate", { type: "hunt", things: take.map((p) => p.id) });
      if (r && (r.designated ?? 0) > 0) {
        this.stats.orders++;
        await this.thought(`${hunter.name} hunting ${take.map((p) => p.kind).join(" and ")}${hunter.weapon ? ` with the ${hunter.weapon}` : " bare handed"}.`);
        await this.narrate("hunt", "hunting", `${hunter.name} is hunting ${take.map((p) => p.kind).join(" and ")}${hunter.weapon ? ` with a ${hunter.weapon}` : " bare handed, with no weapon at all"}.`, 240000);
      }
    } catch {}
  }

  /**
   * Designate wood only when something queued actually needs it, and only enough for that.
   *
   * The previous version topped the colony up to 250 wood on a timer. Because felling a tree is
   * PlantCutting work and a pawn completes every job at one priority before looking at the next,
   * a standing wood order meant the colonist did nothing but cut plants and haul the result. The
   * observed behaviour across four colonies was exactly that: plant cutting and hauling, almost
   * nothing built.
   */
  /**
   * Outstanding chop designations, counted by looking at the trees themselves.
   *
   * There is no separate designation for felling: a tree marked for cutting and a berry bush
   * marked for harvesting both carry HarvestPlant, so the only honest way to ask how much wood
   * work is queued is to ask the trees.
   */
  async pendingTreeDesignations() {
    try {
      const treeDefs = ["Plant_TreeOak", "Plant_TreePoplar", "Plant_TreePine", "Plant_TreeBirch",
                        "Plant_TreeWillow", "Plant_TreeMaple", "Plant_TreeCypress", "Plant_TreeTeak"];
      const pages = await Promise.all(treeDefs.map((d) =>
        api.get(`/things?def=${d}&detail=1&limit=300`).catch(() => ({}))));
      return pages.flatMap((r) => r.things ?? []).filter((t) => t.designation).length;
    } catch { return 0; }
  }

  async manageWood(resources) {
    const wood = resources.WoodLog ?? 0;
    const built = this.builtDefs ?? new Set();

    // A food emergency used to switch wood cutting off completely. It sounds right and it nearly
    // killed this colony: the campfire is twenty wood, and a campfire is cooked food instead of
    // "ate corpse", which is minus twelve mood and was the largest single line in the founder's
    // ledger while he sat at nineteen percent mood with no shelter. Twenty wood IS the food fix,
    // so the emergency only suspends chopping once the fire exists.
    const needsFire = !built.has("Campfire") && wood < 25;
    if (this.foodEmergency && !needsFire) return;

    const need = this.woodNeeded(resources);
    if (wood >= need) return;

    // Count trees, not "plant work". Felling a tree and picking a berry are both HarvestPlant
    // designations, so a forager that had just marked twenty five bushes made this look like a
    // board full of queued wood work and wood cutting was never designated again. Across a whole
    // run the colony chopped nothing at all and held twelve wood on day three.
    const pending = await this.pendingTreeDesignations();
    if (pending > 6) return;

    // About 20 wood per tree, so ask for the shortfall and nothing more.
    const shortfall = need - wood;
    const wanted = Math.min(12, Math.max(2, Math.ceil(shortfall / 20)));
    const b = this.base;
    try {
      const treeDefs = ["Plant_TreeOak", "Plant_TreePoplar", "Plant_TreePine", "Plant_TreeBirch", "Plant_TreeWillow", "Plant_TreeMaple"];
      const pages = await Promise.all(treeDefs.map((d) =>
        api.get(`/things?def=${d}&detail=1&limit=200`).catch(() => ({}))));
      const trees = pages
        .flatMap((r) => r.things ?? [])
        .filter((t) => t.x != null && (t.growth ?? 1) > 0.5)
        .map((t) => ({ ...t, d: dist(t, b) }))
        .sort((a, c) => a.d - c.d)
        .slice(0, wanted);
      if (trees.length === 0) return;
      const r = await api.tryPost("/designate", { type: "chop", things: trees.map((t) => t.id) });
      if (r && (r.designated ?? 0) > 0) {
        this.stats.orders++;
        this.log(`Designated ${r.designated} tree(s) for ${need} wood (have ${wood}, need it for: ${this.woodReason}).`);
      }
    } catch {}
  }

  /** Exactly what the next build step costs, so the colony never cuts wood it has no use for. */
  /**
   * How much wood the colony should be holding, given what it has not built yet.
   *
   * These are the real prices, counted off the plan rather than guessed: a wall is five wood and
   * a door is twenty five, so the great hall with its four doors, one per adjoining room, is two
   * hundred. The old target stopped at a hundred and fifty for "walls and a door", which is the
   * price of a hut and not of a house, so the colony stopped chopping while still short of its
   * first room and stood around with the blueprints unpaid for.
   */
  woodNeeded(resources) {
    const built = this.builtDefs ?? new Set();
    if (!built.has("Campfire")) { this.woodReason = "a campfire"; return 20; }
    if (!this.hasAnyBed(built)) { this.woodReason = "a bed"; return 45; }
    if (!this.placed.has("room-hall")) { this.woodReason = "the great hall: twenty walls and four doors"; return 215; }
    if (!this.placed.has("room-bed1")) { this.woodReason = "the first bedroom"; return 160; }
    if (!this.placed.has("room-warehouse")) { this.woodReason = "the warehouse"; return 160; }
    if (!this.placed.has("room-kitchen")) { this.woodReason = "the kitchen"; return 160; }
    if (!this.placed.has("room-freezer")) { this.woodReason = "the cold room"; return 140; }
    if (!this.placed.has("room-workshop")) { this.woodReason = "the workshop"; return 140; }
    this.woodReason = "the next bedroom, furniture and repairs";
    return 220;
  }

  async manageSteel(resources, colonists = [], day = 1) {
    if ((resources.Steel ?? 0) >= 60) return;
    if (!this.placed.has("hut") || (colonists.length < 2 && day < 8)) return;
    try {
      const b = this.base;
      const res = await api.get(`/things?def=MineableSteel&rect=${b.x - 45},${b.z - 45},91,91&limit=200`);
      const ore = (res.things ?? []).sort((a, b2) => dist(a, b) - dist(b2, b)).slice(0, 6).map((t) => t.id);
      if (ore.length > 0 && (await this.pendingDesignations("Mine")) < 4) {
        const r = await api.tryPost("/designate", { type: "mine", things: ore });
        if (r && (r.designated ?? 0) > 0) {
          this.stats.orders++;
          await this.thought(`Mining ${r.designated} compacted steel deposits for the research bench.`);
        }
      }
      const loose = await api.get(`/things?def=Steel&rect=${b.x - 45},${b.z - 45},91,91&limit=50`);
      const ids = (loose.things ?? []).map((t) => t.id);
      if (ids.length > 0) await api.tryPost("/allow", { things: ids });
    } catch {}
  }

  // ---------------------------------------------------------------- base

  /** Place a blueprint once. Retries nearby cells if the spot is blocked. */
  /**
   * Returns "placed" on a fresh placement, "already" if the ledger says it was done earlier,
   * false if it could not be placed. Pass { force: true } when the caller has already checked
   * the world and knows the structure is missing, otherwise a burned-down campfire is never
   * rebuilt because the ledger still remembers placing one.
   */
  /**
   * Place a blueprint once, and once only.
   *
   * Placing a blueprint on a cell that already holds one is a TOGGLE in RimWorld: it cancels the
   * pending build. So re-issuing a build order for something already queued does not reinforce
   * it, it destroys it. That is the "construction botched" spam, and it is why the colony kept
   * starting a sleeping spot and never finishing one.
   *
   * The rule is tell it once. `force` no longer means "issue it again"; it means "check the cell
   * and only place if there is genuinely nothing there".
   */
  async place(key, def, x, z, opts = {}) {
    if (this.placed.has(key) && !opts.force) return "already";

    // Ask the world, not the ledger.
    //
    // `this.placed` is empty after any restart, and the agent restarts often, so every relaunch
    // re-ordered everything it had already ordered. Because place() tries neighbouring cells
    // when the target is taken, the duplicate landed one cell over rather than being refused,
    // and the colony ended up with two campfires, two beds and two of every free spot, each
    // wanting its own wood and its own hauling trip. This check was written for exactly that and
    // could never work until blueprints stopped being invisible to /things.
    if (!opts.allowDuplicate && await this.alreadyHave(def)) {
      this.placed.set(key, { def, x, z });
      return "already";
    }
    const attempts = this.failedPlacements.get(key) ?? 0;
    if (attempts > 6) return false;

    if (opts.force && this.placed.has(key)) {
      // Something already stands here or is being built here: leave it alone.
      const prev = this.placed.get(key);
      if (prev && await this.cellOccupied(prev.x, prev.z)) return "already";
      this.placed.delete(key);
    }

    let lastError = null;
    const offsets = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [0, 2], [-2, 0], [0, -2]];
    for (const [dx, dz] of offsets.slice(0, opts.exact ? 1 : offsets.length)) {
      const tx = x + dx, tz = z + dz;
      if (await this.cellOccupied(tx, tz)) continue;
      try {
        await api.post("/build", { def, x: tx, z: tz, rot: opts.rot ?? 0, stuff: opts.stuff });
        this.placed.set(key, { def, x: tx, z: tz });
        this.placedAt.set(key, this.turn);
        this.stats.orders++;
        this.log(`Placed ${def} at (${tx}, ${tz}).`);
        return "placed";
      } catch (e) { lastError = e?.message ?? String(e); }
    }
    this.failedPlacements.set(key, attempts + 1);
    // Say why. Every offset was refused and the reason was thrown away, so a base sited in fog
    // looked identical to a base that simply had no room, and the run sat on a hundred and
    // forty eight wood with nothing ordered and nothing in the log to explain it.
    if (lastError && this.every(`place-fail-${key}`, 30)) {
      this.log(`Could not place ${def} near (${x}, ${z}): ${lastError}`);
    }
    return false;
  }

  /** Is there a building, blueprint or frame on this cell already? One call, and definitive. */
  async cellOccupied(x, z) {
    try {
      const c = await api.get(`/cell?x=${x}&z=${z}`);
      return (c.things ?? []).some((t) => {
        const def = String(t.def ?? "");
        // Blueprints and frames are category Ethereal, named Blueprint_<Def> and Frame_<Def>.
        return (String(t.cat ?? "") === "Building" && def !== "SleepingSpot") || /^(Blueprint|Frame)_/i.test(def);
      });
    } catch { return false; }
  }

  /**
   * Does this colony already have this thing, built or pending, anywhere near the base?
   *
   * Asked of the world rather than of the agent's own ledger, because the ledger is empty after
   * any restart. Trusting it meant the agent re-placed a sleeping spot one cell over on every
   * relaunch, and since placing a blueprint where one already stands cancels it, the colony
   * churned through half built spots and finished none.
   */
  async alreadyHave(def) {
    const b = this.base;
    try {
      const [done, pending, frames] = await Promise.all([
        api.get(`/things?def=${def}&player=1&limit=50`).catch(() => ({})),
        api.get(`/things?def=Blueprint_${def}&limit=50`).catch(() => ({})),
        api.get(`/things?def=Frame_${def}&limit=50`).catch(() => ({})),
      ]);
      const all = [...(done.things ?? []), ...(pending.things ?? []), ...(frames.things ?? [])];
      // No base yet, or the thing is further out than expected: having one anywhere on the map
      // still means the colony has one. The 25-cell leash was silently turning this check off
      // whenever the base anchor had not loaded, which is every first turn after a restart, and
      // a restart is exactly when the in-memory ledger is empty and this check is all there is.
      if (b?.x == null) return all.length > 0;
      return all.some((t) => t.x != null && dist(t, b) < 60);
    } catch { return false; }
  }

  /**
   * The house, as a plan rather than as a pile of walls.
   *
   * A single 7x7 hut was never a home. Everything happened in one room: the cook stood over the
   * campfire beside the bed, raw meat sat next to the table, and the first corpse hauled indoors
   * cost every colonist mood for days. RimWorld rewards separation directly, through room
   * ownership, room cleanliness, room impressiveness and temperature, so the base is laid out as
   * named rooms with one purpose each and a door of their own.
   *
   * Everything shares a wall with its neighbour, which is both cheaper and warmer:
   *
   *                      bed7 | bed8          (bands grow north as the colony grows)
   *                      bed5 | bed6
   *                  hospital | research
   *                      bed3 | bed4
   *                      bed1 | bed2
   *     workshop --  great hall  -- kitchen -- freezer
   *                    warehouse                          prison (detached, south east)
   *
   * The great hall is the hub: every adjoining room opens off it, so a colonist crosses one room
   * to reach any other and never walks outside in a toxic fallout or a cold snap. The corridor
   * running north is one cell wide between the facing bedroom walls, which costs no walls of its
   * own; only its north cap is placed, and as a door, so the next pair of bedrooms can extend
   * through it without tearing anything down.
   *
   * Rects are outer, walls included, so neighbours overlap on exactly the wall they share.
   */
  roomPlan(population = 1) {
    const b = this.base;
    const R = (key, label, purpose, x0, z0, x1, z1, doors, opts = {}) => ({
      key, label, purpose,
      x0: b.x + x0, z0: b.z + z0, x1: b.x + x1, z1: b.z + z1,
      doors: doors.map(([dx, dz]) => ({ x: b.x + dx, z: b.z + dz })),
      ...opts,
    });

    const rooms = [
      // The hub. Four doors, one per adjoining room, built in from the start so no wall ever has
      // to be torn out to open a way through.
      R("hall", "Great hall", "dining and recreation", -3, -3, 3, 3,
        [[0, -3], [0, 3], [3, 0], [-3, 0]], { first: true }),

      // The founder stops sleeping in the dining room. A 4x4 bedroom is large enough to stop
      // counting as cramped, and an owned bedroom is worth real mood every single night.
      R("bed1", "Bedroom 1", "sleeping", -6, 3, -1, 8, [[-1, 5]], { bedroom: true, cap: [0, 8] }),

      // Goods and supplies out of the weather, one room from the front door.
      R("warehouse", "Warehouse", "goods, supplies, materials", -3, -9, 3, -3, [[0, -9]]),

      // Cooking away from the beds: a kitchen's cleanliness decides food poisoning chance.
      R("kitchen", "Kitchen", "stove and butcher table", 3, -3, 9, 3, [[9, 0]]),

      // The cold room. One door only, opening into the kitchen, so the cold stays in.
      R("freezer", "Cold room", "meals, raw food, fresh carcasses", 9, -3, 15, 3, [], { freezer: true }),

      R("workshop", "Workshop", "crafting, smithing, tailoring", -9, -3, -3, 3, [[-9, 0]]),

      R("bed2", "Bedroom 2", "sleeping", 1, 3, 6, 8, [[1, 5]], { bedroom: true, cap: [0, 8] }),
      R("bed3", "Bedroom 3", "sleeping", -6, 8, -1, 13, [[-1, 10]], { bedroom: true, cap: [0, 13] }),
      R("bed4", "Bedroom 4", "sleeping", 1, 8, 6, 13, [[1, 10]], { bedroom: true, cap: [0, 13] }),

      R("hospital", "Hospital", "medical beds", -6, 13, -1, 18, [[-1, 15]], { cap: [0, 18] }),
      R("research", "Research room", "research bench", 1, 13, 6, 18, [[1, 15]], { cap: [0, 18] }),

      R("bed5", "Bedroom 5", "sleeping", -6, 18, -1, 23, [[-1, 20]], { bedroom: true, cap: [0, 23] }),
      R("bed6", "Bedroom 6", "sleeping", 1, 18, 6, 23, [[1, 20]], { bedroom: true, cap: [0, 23] }),
      R("bed7", "Bedroom 7", "sleeping", -6, 23, -1, 28, [[-1, 25]], { bedroom: true, cap: [0, 28] }),
      R("bed8", "Bedroom 8", "sleeping", 1, 23, 6, 28, [[1, 25]], { bedroom: true, cap: [0, 28] }),

      // Detached on purpose. A prison break should not open into the corridor the colony sleeps on.
      R("prison", "Prison", "prisoners", 9, -13, 15, -7, [[12, -13]], { prison: true }),
    ];

    // Only ever plan bedrooms the colony has people for, plus one spare for the next arrival.
    return rooms.filter((r) => !r.bedroom || Number(r.key.replace("bed", "")) <= population + 1);
  }

  /** Every cell along a rect's perimeter, corners included, once each. */
  static perimeter(r) {
    const cells = [];
    for (let x = r.x0; x <= r.x1; x++) { cells.push([x, r.z0]); cells.push([x, r.z1]); }
    for (let z = r.z0 + 1; z <= r.z1 - 1; z++) { cells.push([r.x0, z]); cells.push([r.x1, z]); }
    return cells;
  }

  /**
   * What already stands on the house footprint, as a lookup keyed "x,z".
   *
   * Refreshed once per build pass rather than per cell. Shared walls mean most of a new room's
   * perimeter is already there, and asking the game about each of twenty four cells in turn cost
   * more time than the whole rest of the turn.
   */
  async occupancy() {
    const b = this.base;
    const held = new Map();
    try {
      const res = await api.get(`/things?rect=${b.x - 26},${b.z - 26},53,60&limit=900`);
      for (const t of res.things ?? []) {
        const def = String(t.def ?? "");
        const isBuilding = String(t.cat ?? "") === "Building";
        const pending = /^(Blueprint|Frame)_/i.test(def);
        if (!isBuilding && !pending) continue;
        const clean = def.replace(/^(Blueprint|Frame)_/i, "");
        held.set(`${t.x},${t.z}`, { def: clean, pending });
      }
    } catch {}
    return held;
  }

  /**
   * Put a room up, skipping the walls its neighbours already provided.
   *
   * Nothing is ordered unless the whole room can be paid for. A half funded room is worse than no
   * room: the colonist spends the day carrying wood to blueprints that cannot finish, and an
   * unclosed rectangle is not a room at all, so it gets no roof, no temperature and none of the
   * mood that made it worth building.
   */
  /**
   * Take a room's ground back from the fields.
   *
   * Fields are sited beside the colony on day one, when there is no house to avoid, so by the
   * time a room is paid for a crop may be standing where its floor goes. RimWorld will not put a
   * growing zone and a building on the same cell, so the blueprints would simply be refused,
   * silently, one cell at a time, and the room would never close.
   */
  async clearZoneFor(room) {
    try {
      const map = await api.get("/map");
      const cells = [];
      for (let x = room.x0; x <= room.x1; x++) for (let z = room.z0; z <= room.z1; z++) cells.push([x, z]);
      for (const z of map.zones ?? []) {
        if (z.type !== "Growing" && z.type !== "Stockpile") continue;
        const hits = cells.filter(([x, cz]) => x >= z.minX && x <= z.maxX && cz >= z.minZ && cz <= z.maxZ);
        if (hits.length === 0) continue;
        // Whole zone swallowed by the room: it has no reason to exist any more.
        if (hits.length >= z.cells) {
          await api.tryPost("/zone/update", { id: z.id, delete: true });
          this.zones.delete([...this.zones].find((k) => k.startsWith(String(z.label ?? "").toLowerCase())) ?? "");
          this.log(`${z.label} removed: ${room.label} is being built on all of it.`);
        } else {
          await api.tryPost("/zone/update", { id: z.id, removeCells: hits });
          this.log(`${z.label} trimmed by ${hits.length} cells to make room for ${room.label}.`);
        }
      }
    } catch {}
  }

  /**
   * What a room would cost right now, counting only the walls its neighbours have not already
   * built. Shared walls are most of the saving: the workshop costs ninety wood rather than two
   * hundred because the great hall already paid for its east side.
   */
  estimateRoomCost(room, held) {
    const doors = new Set(room.doors.map((d) => `${d.x},${d.z}`));
    let walls = 0, doorCount = 0;
    for (const [x, z] of ColonyAgent.perimeter(room)) {
      const key = `${x},${z}`;
      if (held.has(key)) continue;
      if (doors.has(key)) doorCount++; else walls++;
    }
    if (room.cap) {
      const capKey = `${this.base.x + room.cap[0]},${this.base.z + room.cap[1]}`;
      if (!held.has(capKey)) doorCount++;
    }
    return walls * 5 + doorCount * 25;
  }

  async buildRoom(room, wood, held) {
    if (this.placed.has(`room-${room.key}`)) return "already";
    await this.clearZoneFor(room);

    const doors = new Map(room.doors.map((d) => [`${d.x},${d.z}`, d]));
    const items = [];

    // The corridor cap. It is a door and not a wall so the next pair of bedrooms can extend
    // straight through it without anything being torn down, and it sits in the one cell between
    // the two facing bedrooms, which belongs to neither room's perimeter. Adding it to the door
    // map did nothing at all for exactly that reason: the perimeter loop never visited the cell,
    // so the corridor was left open to the sky, unroofed and unheated.
    if (room.cap) {
      const cx = this.base.x + room.cap[0], cz = this.base.z + room.cap[1];
      const there = held.get(`${cx},${cz}`);
      if (!there) items.push({ def: "Door", stuff: "WoodLog", x: cx, z: cz });
    }

    let standingWalls = 0;
    for (const [x, z] of ColonyAgent.perimeter(room)) {
      const key = `${x},${z}`;
      const there = held.get(key);
      const wantsDoor = doors.has(key);
      if (there) {
        // A door already in the right cell is the shared wall doing its job.
        if (wantsDoor && there.def === "Door") doors.delete(key);
        standingWalls++;
        continue;
      }
      if (wantsDoor) { items.push({ def: "Door", stuff: "WoodLog", x, z }); doors.delete(key); continue; }
      items.push({ def: "Wall", stuff: "WoodLog", x, z });
    }
    // Any door cell that is currently a plain wall: leave it. Tearing a finished wall out to fit a
    // door costs a colonist-hour and the room still works; the plan puts doors in from the start.
    if (items.length === 0) {
      this.placed.set(`room-${room.key}`, { def: "Room", x: room.x0, z: room.z0 });
      return "already";
    }

    const wallCount = items.filter((i) => i.def === "Wall").length;
    const doorCount = items.length - wallCount;
    const cost = wallCount * 5 + doorCount * 25;
    (this.roomCost ?? (this.roomCost = new Map())).set(room.key, cost);
    if (wood < cost + 15) return { short: cost + 15 - wood, cost };

    const r = await api.tryPost("/build/bulk", { items });
    const landed = (r?.results ?? []).filter((x) => x && x.ok !== false).length;
    if (!r || landed < Math.ceil(items.length * 0.6)) {
      this.log(`${room.label}: only ${landed} of ${items.length} blueprints landed, will retry.`);
      return false;
    }
    this.placed.set(`room-${room.key}`, { def: "Room", x: room.x0, z: room.z0 });
    this.stats.orders++;
    await this.thought(`${room.label} laid out for ${room.purpose}: ${landed} new walls and doors, ${standingWalls} already shared with the rooms beside it, about ${cost} wood.`);
    await this.narrate("room-" + room.key, `${room.label} started`,
      `${room.label} blueprinted off the great hall for ${room.purpose}. ${landed} new cells, ${standingWalls} walls shared with neighbouring rooms, roughly ${cost} of the ${wood} wood in store.`,
      0, { priority: "high" });
    return "placed";
  }

  /**
   * Where each thing belongs, in the room built for it.
   *
   * Keyed by room, so a bench never ends up in the corridor and a bed never ends up beside the
   * stove. Coordinates are interior cells, offset from the base origin.
   */
  static FURNITURE = {
    // Great hall: the table sits in the north west quarter, clear of all four door approaches,
    // with its stools cardinally adjacent. A stool on a diagonal is not a seat: RimWorld only
    // counts a chair as a place to eat when it shares an edge with a table cell, and the run
    // before this one had its one stool placed corner to corner with the table, so nobody ever
    // ate at it and the colony carried "ate without a table" for five days.
    hall: [
      { key: "table", def: "Table1x2c", x: -2, z: 1, rot: 0, stuff: "WoodLog", wood: 28 },
      { key: "stool", def: "Stool", x: -1, z: 1, rot: 3, stuff: "WoodLog", wood: 25 },
      // A stool is 25 stuff and 450 work. A dining chair is 45 stuff and 8000 work, eighteen
      // times the labour for the same seat, which is a whole day of a lone colonist's life.
      { key: "stool2", def: "Stool", x: -1, z: 2, rot: 3, stuff: "WoodLog", wood: 25, needPop: 2 },
    ],
    // Cooking and butchering together, away from where anyone sleeps.
    kitchen: [
      { key: "campfire2", def: "Campfire", x: 4, z: 2, wood: 20, replaces: "campfire" },
      // 20 wood in the cost list plus 75 stuff, not the 120 this used to guess at.
      { key: "butchertable", def: "TableButcher", x: 6, z: 2, rot: 0, stuff: "WoodLog", wood: 95 },
      { key: "stove", def: "FueledStove", x: 4, z: 0, rot: 0, steel: 80 },
    ],
    workshop: [
      { key: "craftingspot", def: "CraftingSpot", x: -6, z: 1 },
      { key: "research", def: "SimpleResearchBench", x: -6, z: -1, rot: 0, stuff: "WoodLog", wood: 75, steel: 25 },
      { key: "smithy", def: "ElectricSmithy", x: -7, z: -1, rot: 0, steel: 100, optional: true },
    ],
    bed1: [{ key: "bed1", def: "Bed", x: -4, z: 6, rot: 0, stuff: "WoodLog", wood: 45 }],
    bed2: [{ key: "bed2", def: "Bed", x: 3, z: 6, rot: 0, stuff: "WoodLog", wood: 45 }],
    bed3: [{ key: "bed3", def: "Bed", x: -4, z: 11, rot: 0, stuff: "WoodLog", wood: 45 }],
    bed4: [{ key: "bed4", def: "Bed", x: 3, z: 11, rot: 0, stuff: "WoodLog", wood: 45 }],
    bed5: [{ key: "bed5", def: "Bed", x: -4, z: 21, rot: 0, stuff: "WoodLog", wood: 45 }],
    bed6: [{ key: "bed6", def: "Bed", x: 3, z: 21, rot: 0, stuff: "WoodLog", wood: 45 }],
    bed7: [{ key: "bed7", def: "Bed", x: -4, z: 26, rot: 0, stuff: "WoodLog", wood: 45 }],
    bed8: [{ key: "bed8", def: "Bed", x: 3, z: 26, rot: 0, stuff: "WoodLog", wood: 45 }],
    hospital: [
      { key: "medbed1", def: "Bed", x: -4, z: 15, rot: 0, stuff: "WoodLog", wood: 45 },
      { key: "medbed2", def: "Bed", x: -4, z: 17, rot: 0, stuff: "WoodLog", wood: 45 },
    ],
    research: [{ key: "research2", def: "SimpleResearchBench", x: 3, z: 16, rot: 0, stuff: "WoodLog", wood: 100, steel: 25, optional: true }],
    prison: [{ key: "prison_bed", def: "Bed", x: 12, z: -10, rot: 0, stuff: "WoodLog", wood: 45 }],
  };

  /**
   * What the colony actually has, not just what it has tidied away.
   *
   * /resources reports stockpiled material. Anything lying where it fell does not count, and a
   * colony that cuts trees faster than it hauls logs therefore reads as having almost nothing.
   * This colony held three hundred and twenty nine wood in nine piles around the base while
   * every build gate in this agent read twelve, so the campfire was never placed, the cheap
   * things gate never opened, and not one room was ever laid out. Four colonies ended with a
   * founder sleeping outdoors beside a small forest of his own logs.
   *
   * Loose material is perfectly usable: a colonist will carry it to a blueprint. So the gates
   * count both, and the agent decides on what the colony owns rather than on what it has filed.
   */
  async trueResources(snap) {
    const stockpiled = { ...(snap.resources ?? {}) };
    const counted = { ...stockpiled };
    try {
      const defs = ["WoodLog", "Steel", "Cloth", "Silver", "ComponentIndustrial",
                    "BlocksGranite", "BlocksMarble", "BlocksSandstone", "BlocksLimestone", "BlocksSlate"];
      const pages = await Promise.all(defs.map((d) =>
        api.get(`/things?def=${d}&detail=1&limit=200`).catch(() => ({}))));
      // On the very first turn of a session the base anchor has not been loaded yet, because
      // foundColony runs later in the turn. Measuring distance from an undefined base gives NaN,
      // every comparison against it is false, and the count silently falls back to the
      // stockpiled figure: the first plan of the run said "Great hall 12/200 wood" while 264
      // logs lay around the site. Without a base, count everything on the map instead, which is
      // wrong only in the direction of being too generous for one turn.
      const origin = this.base?.x != null ? this.base : null;
      pages.forEach((page, i) => {
        const loose = (page.things ?? [])
          .filter((t) => t.x != null && (origin === null || dist(t, origin) < 45))
          .reduce((n, t) => n + (t.count ?? 1), 0);
        if (loose > 0) counted[defs[i]] = loose;
      });
    } catch { return stockpiled; }

    const wood = counted.WoodLog ?? 0, filed = stockpiled.WoodLog ?? 0;
    if (wood - filed > 40 && this.every("loose-stock", 60)) {
      this.log(`${wood} wood around the base, ${filed} of it in a pile. Counting all of it: a blueprint is served by a log on the ground just as well.`);
    }
    return counted;
  }

  /**
   * Decide once, then execute against the decision.
   *
   * Until now there was no plan. Every four seconds the agent re-derived everything from nothing,
   * which is why it designated trees and cancelled them seconds later, picked the farm site three
   * separate times, and could answer "what are you doing" only with whatever job the colonist
   * happened to hold. A plan makes those one decision instead of hundreds, and writing it down
   * makes it checkable: when the house did not get built, the plan is what shows why.
   *
   * It is re-made at founding, at each in-game day boundary, and whenever something happens that
   * genuinely invalidates it. It is pushed to the in-game task board so the stream can read it.
   */
  async makePlan(colonists, snap, resources, reason) {
    const survey = await this.survey();
    const built = this.builtDefs ?? new Set();
    const wood = resources.WoodLog ?? 0;
    const tasks = [];
    let blocker = null;

    const add = (label, state, note) => tasks.push({ label, state, note });

    // Food first, always, but judged on what the colony can actually reach rather than on what
    // has been filed into a stockpile.
    const daysFood = this.foodDays ?? 0;
    const cropDays = this.cropDays ?? 0;
    if (daysFood >= 2 || cropDays >= 2) {
      add("Food secured", "done", `${daysFood.toFixed(1)}d stored${cropDays > 0.1 ? ` +${cropDays.toFixed(1)}d growing` : ""}`);
    } else if (survey && (survey.wildFoodGrown > 0 || (survey.game ?? []).some((g) => g.safeToHuntBarehanded))) {
      add("Get food", "doing", `${survey.wildFoodGrown} bushes, ${(survey.game ?? []).filter((g) => g.safeToHuntBarehanded).length} small game`);
    } else {
      add("Get food", "blocked", "nothing grown or huntable in range");
      blocker = "no reachable food";
    }

    // The cheap survival buildings, in the order they pay back.
    add("Campfire", built.has("Campfire") ? "done" : (wood >= 20 ? "doing" : "blocked"),
        built.has("Campfire") ? "cooked meals" : `${wood}/20 wood`);
    add("Bed", this.hasAnyBed(built) ? "done" : (wood >= 45 ? "doing" : "blocked"),
        this.hasAnyBed(built) ? null : `${wood}/45 wood`);

    // Then the house, room by room, with the real price of each.
    const plan = this.roomPlan(colonists.length);
    try {
      const held = await this.occupancy();
      this.roomCost = this.roomCost ?? new Map();
      for (const room of plan.slice(0, 6)) this.roomCost.set(room.key, this.estimateRoomCost(room, held));
    } catch {}
    let roomsShown = 0;
    for (const room of plan) {
      if (roomsShown >= 4) break;
      const done = this.placed.has(`room-${room.key}`);
      if (done) { add(room.label, "done", null); roomsShown++; continue; }
      const cost = this.roomCost?.get(room.key);
      const state = cost && wood < cost ? "blocked" : "doing";
      add(room.label, state, cost ? `${wood}/${cost} wood` : room.purpose);
      if (state === "blocked" && !blocker) blocker = `${room.label} needs ${cost - wood} more wood`;
      roomsShown++;
      break;                    // one room at a time; the rest are queued
    }
    for (const room of plan.slice(roomsShown).slice(0, 3)) {
      if (this.placed.has(`room-${room.key}`)) continue;
      add(room.label, "queued", room.purpose);
    }

    if (survey && survey.unhauledItems > 60) {
      add("Haul the loose piles", "queued", `${survey.unhauledItems} items on the ground`);
    }
    const corpseCount = Object.values(survey?.corpses ?? {}).reduce((a, b) => a + b, 0);
    if (corpseCount > 0) add("Clear bodies", "doing", `${corpseCount} waiting`);

    const goal = `${colonists.length} of ${POPULATION_TARGET} colonists`;
    const day = snap.dateString ? String(snap.dateString).slice(0, 26) : `Day ${snap.day ?? "?"}`;

    this.plan = { goal, day, blocker, tasks, madeAt: this.turn, reason };
    await api.tryPost("/hud/tasks", { goal, day, blocker, tasks });
    await studio("/api/plan", { goal, day, blocker, tasks, reason });
    this.journal("plan", { reason, goal, blocker, tasks }, snap);

    const shown = tasks.map((t) => `${t.state === "done" ? "done" : t.state}: ${t.label}${t.note ? ` (${t.note})` : ""}`).join("; ");
    this.log(`Plan (${reason}) — ${goal}. ${shown}${blocker ? ` | waiting on: ${blocker}` : ""}`);
    return this.plan;
  }

  /** One call that describes what is actually within reach, rather than fifteen that each ask for one named thing. */
  async survey(radius = 45) {
    try {
      const b = this.base ?? {};
      const q = b.x != null ? `?x=${b.x}&z=${b.z}&r=${radius}` : `?r=${radius}`;
      const s = await api.get(`/survey${q}`);
      this.lastSurvey = s;
      return s;
    } catch { return this.lastSurvey ?? null; }
  }

  /**
   * Re-plan when the plan has stopped describing reality: a new day, a new colonist, a fight, a
   * casualty, or the blocker clearing. Not on a timer, which is what the old loop effectively was.
   */
  async maybeReplan(colonists, snap, resources, threats) {
    const day = snap.day ?? 0;
    // Every material the plan can be blocked on, in coarse buckets.
    //
    // A plan whose tasks read "blocked: needs more wood" is worthless the moment the wood
    // arrives, and nothing else here changes when it does: the first plan of a run said
    // 12/200 and stood unchanged while the pile grew to 264. Buckets rather than raw counts,
    // because a plan that re-made itself every time a single log was hauled would be the
    // four-second re-derivation this replaced. Fifty wood, or fifty steel, is roughly the
    // granularity at which a build decision actually changes.
    const BUCKET = 50;
    const stockKeys = ["WoodLog", "Steel", "Cloth", "ComponentIndustrial", "Silver",
                       "BlocksGranite", "BlocksMarble", "BlocksSandstone", "BlocksLimestone", "BlocksSlate"];
    const stockPrint = stockKeys.map((k) => Math.floor((resources[k] ?? 0) / BUCKET)).join(",");
    const woodBucket = Math.floor((resources.WoodLog ?? 0) / BUCKET);
    const fingerprint = [
      day,
      stockPrint,
      colonists.length,
      threats.length > 0 ? "fight" : "calm",
      colonists.some((c) => c.downed) ? "down" : "up",
      [...this.placed.keys()].filter((k) => k.startsWith("room-")).length,
      (this.builtDefs?.has("Campfire") ?? false) ? "fire" : "cold",
      this.hasAnyBed(this.builtDefs ?? new Set()) ? "bed" : "ground",
    ].join("|");

    if (fingerprint === this.planFingerprint) return;
    const reason = !this.planFingerprint ? "first plan"
      : day !== this.planDay ? `day ${day}`
      : threats.length > 0 ? "hostiles"
      : stockPrint !== this.planStock ? `materials changed (wood ${resources.WoodLog ?? 0}, steel ${resources.Steel ?? 0})`
      : "something finished or broke";
    this.planFingerprint = fingerprint;
    this.planDay = day;
    this.planWoodBucket = woodBucket;
    this.planStock = stockPrint;
    await this.makePlan(colonists, snap, resources, reason);
  }

  async manageBase(colonists, resources) {
    const b = this.base;
    const wood = resources.WoodLog ?? 0;
    const steel = resources.Steel ?? 0;
    let built = new Set();
    try {
      const s = await api.get("/things/summary?cat=Building&player=1");
      built = new Set((s.groups ?? s.summary ?? []).map((g) => g.def));
    } catch {}

    // The three things worth more than any wall: something to cook on, somewhere to sleep, and a
    // table to eat at. All three cost less than a fifth of a room and go in before one.
    if (!built.has("ButcherSpot") && !built.has("TableButcher")) {
      await this.place("butcherspot", "ButcherSpot", b.x + 6, b.z + 2, { force: true });
    }
    if (!built.has("Campfire")) {
      if ((await this.place("campfire", "Campfire", b.x + 2, b.z + 2, { force: true })) === "placed") {
        await this.thought("Campfire down: warmth, light and cooked food. It moves into the kitchen once there is a kitchen.");
      }
    }
    if (!this.hasAnyBed(built)) {
      await this.place("bed", "Bed", b.x - 1, b.z - 1, { stuff: "WoodLog", rot: 0, force: true });
    }

    // Rooms, in the order a colony actually needs them. Each one waits until the colony can pay
    // for the whole thing, so nothing is ever left as an unclosed rectangle.
    // Ordered, not finished. The campfire and the bed only have to be on the board before the
    // rooms go on it too, because the whole point of a blueprint is to queue work the colonist
    // walks to next. Requiring them to be complete meant the house waited on a bed that had
    // nine ticks of work left.
    const cheapDone = (built.has("Campfire") || built.has("Frame_Campfire") || built.has("Blueprint_Campfire"))
      && this.hasAnyBed(built);
    if (cheapDone) {
      const held = await this.occupancy();

      // One room in flight at a time.
      //
      // Each room is checked against the wood in store, so four rooms in a row all passed
      // against the same 264 logs and the colony committed to roughly 620 wood of blueprints it
      // could not pay for. A colonist then spreads itself across four unfinished rectangles,
      // none of which gets a roof, which is the exact failure the "pay for the whole room"
      // rule existed to prevent. So nothing new is ordered while anything already ordered is
      // still standing as a blueprint or a frame.
      const outstanding = [...held.values()].filter((v) => v.pending).length;
    this.pendingBuilds = outstanding;
      if (outstanding > 0) {
        if (this.every("room-wip", 40)) this.log(`${outstanding} wall or door still unbuilt; not starting another room until they are up.`);
      } else {

      const plan = this.roomPlan(colonists.length);
      for (const room of plan) {
        if (room.prison && (colonists.length < 2 || !this.placed.has("room-hall"))) continue;
        if (!room.first && !this.placed.has("room-hall")) continue;
        const result = await this.buildRoom(room, wood, held);
        if (result === "placed") break;                 // one room at a time, finish it first
        if (result && result.short) {
          if (this.every(`short-${room.key}`, 120)) this.log(`${room.label} needs about ${result.cost} wood, ${result.short} more than the ${wood} in store.`);
          break;                                        // and do not skip ahead to a cheaper room
        }
      }
      }
    }

    // Furniture, but only into rooms that exist. A bed blueprinted where a bedroom has not been
    // built yet is a bed standing in a field.
    for (const [roomKey, items] of Object.entries(ColonyAgent.FURNITURE)) {
      if (!this.placed.has(`room-${roomKey}`)) continue;
      for (const it of items) {
        if (it.needPop && colonists.length < it.needPop) continue;
        if (it.wood && wood < it.wood) continue;
        if (it.steel && steel < it.steel) continue;
        if (built.has(it.def) && it.optional) continue;
        await this.place(it.key, it.def, b.x + it.x, b.z + it.z, { stuff: it.stuff, rot: it.rot ?? 0, exact: true });
      }
    }

    // Recreation stays outdoors until there is a room with space for it: a horseshoes pin needs a
    // clear lane in front of it, and indoors that lane is a doorway.
    if (wood >= 30 && !built.has("HorseshoesPin")) {
      await this.place("horseshoes", "HorseshoesPin", b.x - 6, b.z - 7, { stuff: "WoodLog", rot: 0 });
    }

    // Traps sit south of the warehouse door, off the path anyone walks, once there is something
    // behind them worth defending.
    if (wood >= 150 && this.placed.has("room-warehouse")) {
      const trapCoords = [[-4, -11], [4, -11], [-2, -13], [2, -13], [-6, -9], [6, -9]];
      for (let i = 0; i < trapCoords.length; i++) {
        await this.place(`trap-${i}`, "TrapSpike", b.x + trapCoords[i][0], b.z + trapCoords[i][1], { stuff: "WoodLog", exact: true });
      }
    }

    await this.manageStorage(colonists);
    await this.manageFarms(colonists.length);
  }

  async managePrisoners(colonists, snap) {
    try {
      const beds = await api.get("/things?cat=Building&player=1&def=Bed");
      const pBed = (beds.things ?? []).find(t => dist(t, { x: this.base.x + 10, z: this.base.z }) < 4);
      if (pBed && !pBed.forPrisoners) {
        await api.tryPost("/bed/settings", { thing: pBed.id, forPrisoners: true });
      }
    } catch {}

    try {
      const prisoners = await api.get("/pawns?role=prisoner");
      for (const p of prisoners.pawns ?? []) {
        if (!this.configured.has(`recruit-${p.id}`)) {
          await api.tryPost("/pawn/settings", { pawn: p.id, prisonerMode: "Recruit", medicalCare: "Best" });
          this.configured.add(`recruit-${p.id}`);
          await this.thought(`Prisoner ${p.name} set to Recruit mode.`);
        }
      }
    } catch {}

    const doctor = colonists.find(c => !c.downed && !c.drafted);
    if (doctor) {
      try {
        const downedHostiles = (snap.hostiles ?? []).filter(h => h.downed && !h.dead && (h.role === "enemy" || h.kind?.includes("colonist") || h.kind?.includes("tribal") || h.kind?.includes("pirate") || h.kind?.includes("raider")));
        if (downedHostiles.length > 0) {
          const target = downedHostiles[0];
          const beds = await api.get("/things?cat=Building&player=1&def=Bed");
          const pBed = (beds.things ?? []).find(t => t.forPrisoners) ?? (beds.things ?? [])[0];
          if (pBed) {
            await api.tryPost("/job", { pawn: doctor.id, job: "Capture", targetA: target.id, targetB: pBed.id });
            await this.thought(`Capturing downed enemy ${target.name ?? target.id} for recruitment.`);
            await this.narrate("capture", "taking a prisoner", `${target.name ?? "A downed hostile"} is being carried to a prison bed to be tended and recruited.`, 60000, { priority: "high", askChat: true });
          }
        }
      } catch {}
    }
  }

  /**
   * Weapon recipes a neolithic colony can actually make at a crafting spot with no research,
   * cheapest and most useful first. A short bow beats a club: range decides fights.
   */
  /**
   * Weapons a colony can make at a free crafting spot with no research.
   * A short bow needs Crafting 2 and gives 22.9 tiles of reach, which is what makes hunting
   * possible at all. A club has no skill requirement, so it is the fallback for a pawn who
   * cannot make the bow. Both beat bare fists, which do 4.1 DPS against a knife's 7.02.
   */
  static WEAPON_RECIPES = [
    { recipe: "Make_Bow_Short", key: "bill-bow", wood: 30, minCrafting: 2, label: "short bow", note: "reach, and the only way to hunt at all" },
    { recipe: "Make_MeleeWeapon_Club", key: "bill-club", wood: 40, minCrafting: 0, label: "club", note: "no skill needed, and far better than fists" },
  ];

  /**
   * The nearest bench of a kind, not simply the first one the game lists.
   *
   * Taking `[0]` put the standing butcher bill on a spot fifty cells away, left over from a base
   * anchor the colony had already abandoned. The founder killed three animals, the bill existed,
   * and nothing was ever butchered, because the only bench carrying it was most of a day's walk
   * from the kills.
   */
  async nearestBench(defs) {
    const found = await Promise.all(defs.map((d) =>
      api.get(`/things?def=${d}&player=1&limit=30`).catch(() => ({}))));
    const all = found.flatMap((r) => r.things ?? []).filter((t) => t.x != null);
    if (all.length === 0) return null;
    return all.sort((a, b) => dist(a, this.base) - dist(b, this.base))[0];
  }

  async manageBills(resources) {
    const colonistSkills = [...this.skillCache.values()];
    try {
      const spot = await this.nearestBench(["ElectricSmithy", "TableSmithy", "CraftingSpot"]);
      if (spot) {
        const info = await api.get(`/thing/${spot.id}`).catch(() => ({}));
        const bills = JSON.stringify(info.bills ?? []).toLowerCase();
        let wood = resources.WoodLog ?? 0;
        const crafting = Math.max(0, ...colonistSkills.map((sk) => {
          const v = sk.Crafting;
          return typeof v === "number" ? v : parseInt(String(v ?? "0"), 10) || 0;
        }));
        for (const w of ColonyAgent.WEAPON_RECIPES) {
          if (this.placed.has(w.key) || bills.includes(w.label)) continue;
          if (wood < w.wood) continue;
          if (crafting < w.minCrafting) continue;   // nobody here can make it
          const r = await api.tryPost("/bill", { thing: spot.id, recipe: w.recipe, mode: "count", count: 1 });
          if (r) {
            this.placed.set(w.key, {});
            wood -= w.wood;
            await this.thought(`Queued a ${w.label} at the crafting spot: ${w.note}.`);
          }
        }
        const leather = Object.entries(resources).filter(([k]) => k.startsWith("Leather_")).reduce((a, [, v]) => a + v, 0);
        if (leather >= 60 && !bills.includes("tribal") && !this.placed.has("bill-tribalwear")) {
          const r = await api.tryPost("/bill", { thing: spot.id, recipe: "Make_Apparel_TribalA", mode: "count", count: 1 });
          if (r) { this.placed.set("bill-tribalwear", {}); await this.thought("Tribalwear queued. Clothes are temperature range and mood."); }
        }
      }
    } catch {}

    // Butchering is the step that turns a hunted animal into food. Without it, corpses rot
    // where they fall and the colony starves next to its own kills.
    try {
      const bench = await this.nearestBench(["TableButcher", "ButcherSpot"]);
      // Keyed on the bench, so moving the colony or upgrading the spot to a table re-queues the
      // bill on the one that is actually beside the kills.
      if (bench && !this.placed.has(`bill-butcher-${bench.id}`)) {
        const r = await api.tryPost("/bill", { thing: bench.id, recipe: "ButcherCorpseFlesh", mode: "forever" });
        if (r) {
          this.placed.set(`bill-butcher-${bench.id}`, {});
          this.placed.set("bill-butcher-any", {});
          await this.thought(`Standing butcher bill set on the ${bench.def === "TableButcher" ? "butcher table" : "butcher spot"} ${Math.round(dist(bench, this.base))} cells from the base. Every kill now becomes meat and leather.`);
        }
      }
    } catch {}

    // Standing cook bill: keep a stock of simple meals rather than eating raw.
    try {
      const stoves = await api.get("/things?def=Campfire&player=1");
      const stove = (stoves.things ?? [])[0];
      if (stove && !this.placed.has("bill-cook")) {
        const r = await api.tryPost("/bill", { thing: stove.id, recipe: "CookMealSimple", mode: "target", count: 12 });
        if (r) { this.placed.set("bill-cook", {}); await this.thought("Standing cook bill set to keep a dozen simple meals on hand."); }
      }
    } catch {}
  }

  /**
   * An unarmed colony is one raid away from ending. Until every colonist who can fight has a
   * weapon, crafting one outranks building, and finished weapons get equipped immediately.
   */
  /**
   * Pick up a weapon that is already lying on the map.
   *
   * RimWorld refuses a hunt job to anyone without a ranged weapon, so an unarmed colony cannot
   * eat meat at all, and the agent's answer to that was always to craft a bow: thirty wood and
   * several hours at a crafting spot. Meanwhile a short bow was lying twenty cells from the
   * founder, dropped by whoever left the three corpses nearby, and nothing in this agent ever
   * looked. A weapon on the ground is free and immediate, and it is the single biggest change to
   * what the colony can do that costs nothing at all.
   *
   * Ranged first, because ranged is what unlocks hunting; melee only if there is nothing better
   * and the colonist is holding nothing.
   */
  async equipFoundWeapons(colonists) {
    if (!this.every("scavenge-weapons", 25)) return;
    const unarmed = colonists.filter((c) => !c.weapon && !c.downed && !c.dead);
    if (unarmed.length === 0) return;

    try {
      const res = await api.get(`/things?cat=Item&detail=1&rect=${this.base.x - 40},${this.base.z - 40},81,81&limit=300`);
      const weapons = (res.things ?? [])
        .filter((t) => t.weapon && t.x != null && !t.forbidden)
        // A wooden log is flagged IsWeapon by the game. Anything that is also stuff is material.
        .filter((t) => !/Log|Block|Chunk|Steel|Cloth|Leather/i.test(String(t.def)))
        .map((t) => ({ ...t, ranged: /bow|gun|rifle|pistol|revolver|shotgun|launcher|bolt/i.test(`${t.def} ${t.label}`) }))
        .sort((a, b) => (b.ranged - a.ranged) || (dist(a, this.base) - dist(b, this.base)));
      if (weapons.length === 0) return;

      for (const c of unarmed) {
        const w = weapons.shift();
        if (!w) break;
        await api.tryPost("/allow", { things: [w.id] });
        const r = await api.tryPost("/job", { pawn: c.id, job: "Equip", targetA: w.id });
        if (r) {
          this.stats.orders++;
          await this.thought(`${c.name} is picking up a ${w.label} lying at ${w.x}, ${w.z}. ${w.ranged ? "A ranged weapon is what makes hunting possible at all." : "Better than bare hands."} Free, and already made.`);
        }
      }
    } catch {}
  }

  async manageWeapons(colonists, resources) {
    const fighters = colonists.filter((c) => !c.downed);
    const unarmed = fighters.filter((c) => !c.weapon);
    if (unarmed.length === 0) return;

    // Equip anything already lying around before crafting more.
    try {
      const loose = await api.get(`/things?cat=Item&rect=${this.base.x - 30},${this.base.z - 30},61,61&limit=200`);
      const weapons = (loose.things ?? []).filter((t) => /Bow_|Gun_|MeleeWeapon_|Club|Knife|Spear|Axe|Mace|Sword/i.test(t.def ?? ""));
      if (weapons.length > 0) {
        weapons.sort((a, b) => dist(a, unarmed[0]) - dist(b, unarmed[0]));
        for (let i = 0; i < Math.min(unarmed.length, weapons.length); i++) {
          await api.tryPost("/allow", { things: [weapons[i].id] });
          const r = await api.tryPost("/equip", { pawn: unarmed[i].id, thing: weapons[i].id });
          if (r) {
            this.stats.orders++;
            await this.thought(`${unarmed[i].name} is equipping a ${weapons[i].label ?? weapons[i].def} found on the ground.`);
            await this.narrate("armed", "picked up a weapon", `${unarmed[i].name} is equipping a ${weapons[i].label ?? weapons[i].def} that was lying on the map.`, 120000);
          }
        }
        return;
      }
    } catch {}

    // Otherwise make sure a weapon is queued and that the crafter is actually on it.
    if ((resources.WoodLog ?? 0) >= 40) {
      await this.manageBills(resources);
      if (!this.weaponRush) {
        this.weaponRush = true;
        await this.syncWorkPlan(colonists);
        await this.thought("No weapon in the colony. Crafting a bow outranks building until that changes.");
        await this.narrate("weapon-rush", "arming the colony", `${unarmed.length} of ${fighters.length} colonists have no weapon at all, with ${resources.WoodLog ?? 0} wood on hand. A short bow and a club are queued at the crafting spot and crafting is now the top job.`, 240000, { askChat: true });
      }
    }
  }

  // ---------------------------------------------------------------- research / trade / work

  async manageResearch(current) {
    if (current && (current.progress ?? 0) < 1) return;
    try {
      const res = await api.get("/research");
      const available = (res.available ?? []).map((a) => a.def ?? a.defName ?? a);
      if (available.length === 0) return;
      const next = TECH_ORDER.find((t) => available.includes(t)) ?? available[0];
      if (next && next !== current?.project) {
        await api.post("/research", { project: next });
        await this.thought(`Research set to ${next}.`);
        await this.narrate("research", "research started", `Research project set to ${next.replace(/([a-z])([A-Z])/g, "$1 $2")}.`, 120000, { askChat: true });
      }
    } catch {}
  }

  async manageTrade() {
    try {
      const res = await api.get("/traders");
      const traders = res.traders ?? [];
      if (traders.length === 0) return;
      const t = traders.find((x) => x.canTradeNow) ?? traders[0];
      const deal = await api.tryPost("/trade/auto", { trader: t.id ?? t.name });
      if (deal?.actuallyTraded) {
        await this.thought(`Traded with ${t.name}: bought ${(deal.bought ?? []).join(", ") || "nothing"}, sold ${(deal.sold ?? []).join(", ") || "nothing"}.`);
        await this.narrate("trade", "trade completed", `Traded with ${t.name}. Bought ${(deal.bought ?? []).join(", ") || "nothing"}. Sold ${(deal.sold ?? []).join(", ") || "nothing"}.`, 60000);
      }
    } catch {}
  }

  /**
   * One source of truth for work priorities. The plan is recomputed from colony state, so an
   * emergency cannot be silently undone by a later routine calling this again.
   * Modes, in order of precedence: food emergency, weapon rush, normal.
   */
  workPlan(skills, colonists) {
    const lvl = (k) => { const v = skills[k]; return typeof v === "number" ? v : parseInt(String(v ?? "0"), 10) || 0; };
    const solo = colonists.length === 1;

    // A pawn completes every job at one priority level before it looks at the next, and it
    // ignores distance while doing so. Two work types sharing a priority is therefore a real
    // decision, not a tie, and Hauling high enough to matter means the pawn carries every loose
    // item on the map before it does anything useful.
    const base = {
      Firefighter: 1, Patient: 1, PatientBedRest: 1, BasicWorker: 1,
      Doctor: 1,
      Cooking: 2,
      // Construction leads while anything is blueprinted. A blueprint is a promise the colony
      // already paid for: leaving it level with hauling means the wood walks past the wall.
      Construction: (this.pendingBuilds ?? 0) > 0 ? 1 : 2,
      Growing: 2,
      PlantCutting: 3,          // below Growing: sowing and harvesting beat felling trees
      Hunting: 3,
      Crafting: 3,
      Mining: 4,
      Hauling: 3,               // never 1: it would eat the whole day
      Research: 4,
      Tailoring: 4, Smithing: 4, Warden: solo ? 4 : 2,
      // Nothing is ever switched off while the colony is small.
      //
      // Zero does not mean "low", it means "never". With one colonist a zero is a whole category
      // of work that simply will not happen: nobody tames, nobody cleans, nobody wardens a
      // prisoner, nobody makes anything for the sake of mood. A single pawn has no one to
      // specialise against, so the right shape is everything on, ordered by what matters, with
      // the low-value work at 4 where it fills the gaps rather than at 0 where it vanishes.
      //
      // These become real specialisations once there are enough people to divide the work, which
      // is what the colonist-count thresholds are for.
      Art: colonists.length >= 5 ? 4 : (solo ? 4 : 0),
      Cleaning: colonists.length >= 4 ? 4 : (solo ? 4 : 0),
      Handling: colonists.length >= 3 ? 4 : (solo ? 4 : 0),
      Childcare: colonists.length >= 3 ? 3 : (solo ? 4 : 0),
    };
    if (lvl("Intellectual") >= 5) base.Research = 3;

    if (this.foodEmergency) {
      // Harvesting a berry bush is PlantCutting. It has to outrank every other plant job, and
      // hauling has to drop, or a starving colonist stockpiles wood instead of eating.
      //
      // Construction stays at 2, NOT 4. The crafting spot, butcher spot and sleeping spot are
      // free and take almost no work, and the crafting spot is what produces the bow, which is
      // the only way to hunt, which is the actual food supply. Burying Construction during a
      // food emergency meant the last founder queued a bow bill on a crafting spot that was
      // never built, and starved beside 265 wood.
      // Which of the two plant work types leads depends on what there is to pick, and the
      // game's own WorkGiverDefs decide that: GrowerHarvest sits under Growing while PlantsCut
      // sits under PlantCutting. So a ripe crop is Growing work and a designated wild bush is
      // PlantCutting work, and burying Growing during a food emergency would suppress the
      // harvest of the very field that ends it.
      //
      // Ripe crops in the ground: Growing leads. Nothing ripe yet: PlantCutting leads, so the
      // colonist picks bushes rather than walking off to sow something that pays in days.
      const ripe = (this.lastSurvey?.cropsRipe ?? 0) > 0;
      // With a house blueprinted and meals capped at a dozen, building is the work that matters.
      // A colonist left with Cooking at 1 will cook the twelfth meal before laying the first
      // wall, because a pawn finishes every job at one priority before it looks at the next.
      const buildingWaiting = (this.pendingBuilds ?? 0) > 0;
      return { ...base,
               PlantCutting: ripe ? 2 : 1,
               Growing: ripe ? 1 : 2,
               Cooking: buildingWaiting ? 2 : 1,
               Hunting: 2,
               Construction: buildingWaiting ? 1 : 2,
               Crafting: 2,
               // Hauling stays low without starving a build site: Construction carries its own
               // ConstructDeliverResourcesToBlueprints giver, so the builder fetches its own wood.
               Hauling: 4, Mining: 4, Research: 4, Tailoring: 4, Smithing: 4 };
    }
    if (this.weaponRush) {
      return { ...base, Crafting: 1, Hauling: 3, Construction: 3, Mining: 4, Research: 4 };
    }
    return base;
  }

  async applyWorkPlan(colonists, reason) {
    for (const p of colonists) {
      // Only cache a real answer: caching {} on a failed lookup used to pin every colonist to
      // the pessimistic branch of the work plan for the rest of the run.
      let skills = this.skillCache.get(p.id);
      if (!skills || Object.keys(skills).length === 0) {
        try {
          const d = await api.get(`/pawn/${p.id}`);
          skills = d.skills ?? {};
          if (Object.keys(skills).length > 0) this.skillCache.set(p.id, skills);
        } catch (e) {
          this.log(`Could not read skills for ${p.name}: ${e.message}`);
          skills = {};
        }
      }
      await api.tryPost("/work/bulk", { pawn: p.id, priorities: this.workPlan(skills, colonists) });
    }
    this.workPlanMode = this.foodEmergency ? "food" : this.weaponRush ? "weapons" : "normal";
    this.log(`Work plan applied (${this.workPlanMode}): ${reason}.`);
  }

  /** Re-apply only when the mode actually changed, so this is cheap to call every turn. */
  async syncWorkPlan(colonists) {
    const mode = this.foodEmergency ? "food" : this.weaponRush ? "weapons" : "normal";
    const knownPawns = colonists.every((c) => this.configured.has(`work-${c.id}`));
    if (mode === this.workPlanMode && knownPawns) return;
    for (const c of colonists) this.configured.add(`work-${c.id}`);
    await this.applyWorkPlan(colonists, `mode ${mode}`);
  }

  /**
   * Timetables that match the colonist rather than the clock.
   *
   * A Night owl is a real mood swing, not flavour text: awake through the night and asleep
   * through the middle of the day, they carry a standing bonus; kept on the ordinary daytime
   * schedule they carry the penalty instead, every day, for the whole colony's life. The founder
   * of this run is one, so it is worth a call on the first day rather than a note for later.
   */
  /**
   * How fast the game should be running right now.
   *
   * Speed is a trade between watching and waiting. Felling a forest, sowing a field and hauling
   * a hundred logs are long, dull jobs where nothing needs deciding for minutes at a time, and
   * running those at 1x wastes the run. A raid, a mental break, a bleeding colonist or a letter
   * asking a question are the opposite: at 3x they play out entirely between two decisions, and
   * a colony was already lost that way, one colonist dead and one kidnapped with no order issued
   * during either event.
   *
   * So the rule is simple: fast while the colony is grinding, slow the moment anything happens.
   */
  desiredSpeed(colonists, snap, threats) {
    const slow = (why) => { this.speedReason = why; return 1; };

    if (threats.length > 0) return slow("hostiles on the map");
    if (colonists.some((c) => c.downed || c.dead)) return slow("someone is down");
    if (colonists.some((c) => c.mentalState)) return slow("a colonist has broken");
    if ((snap.pendingLetters ?? 0) > 0) return slow("a letter is waiting on a decision");
    if (this.tradeOpen) return slow("a trader is here");

    // Close to a break, or close to starving: both are a few in-game minutes from a crisis.
    const worstMood = Math.min(...colonists.map((c) => (c.needs?.mood ?? 1) - (c.moodBreakThreshold ?? 0.35)));
    if (worstMood < 0.08) return slow("mood is near the break threshold");
    if ((this.hungriest ?? 1) < 0.30) return slow("someone is close to starving");
    if (colonists.some((c) => (c.health?.pct ?? 1) < 0.85)) return slow("someone is hurt");

    // Nothing is happening and the colony has a long job in front of it.
    const grinding = colonists.every((c) => {
      const job = `${c.job?.def ?? ""} ${c.job?.report ?? ""}`.toLowerCase();
      return /harvest|cut|plant|sow|haul|mine|construct|build|smooth|butcher|cook|deliver|repair|clean|research|craft|sleep|lay/.test(job);
    });
    if (grinding) { this.speedReason = "routine work, nothing to decide"; return 3; }

    this.speedReason = "watching";
    return 2;
  }

  async manageSchedules(colonists) {
    if (!this.every("schedule", 60)) return;
    for (const c of colonists) {
      if (c.downed || c.dead) continue;
      // Traits are not in the per-turn snapshot, only in the detailed pawn record. Reading them
      // off the snapshot meant every colonist looked traitless, so the owl branch never ran and
      // the day schedule was applied to a night owl instead, which is the penalty rather than
      // the bonus.
      let traits = c.traits;
      if (!traits) {
        // /pawn/{id} answers with the pawn's own fields at the top level, not wrapped.
        try { const r = await api.get(`/pawn/${c.id}?detail=1`); traits = r?.traits ?? r?.pawn?.traits ?? []; } catch { traits = []; }
      }
      const owl = (traits ?? []).some((t) => /night\s*owl/i.test(String(t)));
      const key = `sched-${c.id}-${owl ? "owl" : "day"}`;
      if (this.placed.has(key)) continue;

      if (owl) {
        // Asleep through the middle of the day, working the dark hours, with an hour of
        // recreation either side of the shift.
        const hours = [];
        for (let h = 0; h < 24; h++) {
          if (h >= 9 && h <= 15) hours.push("Sleep");
          else if (h === 16 || h === 8) hours.push("Joy");
          else hours.push("Work");
        }
        const r = await api.tryPost("/pawn/schedule", { pawn: c.id, hours });
        if (r) {
          this.placed.set(key, {});
          await this.thought(`${c.name} is a night owl: moved onto a night shift, asleep from nine to three. Working against the trait is a standing mood penalty every single day.`);
        }
      } else {
        const r = await api.tryPost("/pawn/schedule", { pawn: c.id, preset: "optimal" });
        if (r) this.placed.set(key, {});
      }
    }
  }

  /**
   * Nothing a colonist can do is left at zero.
   *
   * A blank column in the work tab is not a low priority, it is a refusal, and the work plan set
   * several of them: Art, Cleaning, Handling, Childcare and Warden were all zero for a colony of
   * one. That is the whole of a category never happening, and with a single colonist there is
   * nobody else it could fall to. This sweeps whatever the plan did not name and puts every
   * remaining work type the pawn is capable of at 4, so it is done last but it is done.
   */
  async enableAllWork(colonists) {
    if (colonists.length > 2) return;
    if (!this.every("enable-all-work", 50)) return;
    for (const c of colonists) {
      if (c.dead || c.downed) continue;
      try {
        const d = await api.get(`/debug/pawn/${c.id}`);
        const enabled = d?.workEnabled ?? {};
        const disabled = new Set(d?.workDisabled ?? []);
        const missing = Object.keys(ColonyAgent.ALL_WORK_TYPES)
          .filter((w) => !disabled.has(w) && !(w in enabled));
        if (missing.length === 0) continue;
        for (const w of missing) await api.tryPost("/set_work", { pawn: c.id, work: w, priority: 4 });
        this.log(`${c.name}: turned on ${missing.length} work type(s) that were switched off entirely (${missing.join(", ")}). With one colonist a zero is a category of work that never happens.`);
      } catch {}
    }
  }

  /** The twenty work types RimWorld ships, taken from its own WorkTypeDefs. */
  static ALL_WORK_TYPES = {
    Firefighter: 1, Patient: 1, Doctor: 1, PatientBedRest: 1, BasicWorker: 1, Warden: 1,
    Handling: 1, Cooking: 1, Hunting: 1, Construction: 1, Growing: 1, Mining: 1,
    PlantCutting: 1, Smithing: 1, Tailoring: 1, Art: 1, Crafting: 1, Hauling: 1,
    Cleaning: 1, Research: 1,
  };

  async manageWork(colonists) {
    await this.syncWorkPlan(colonists);
  }

  /**
   * Cancel outstanding tree-chopping designations. Harvesting a berry bush and felling a tree are
   * both PlantCutting work, so while the colony is starving the trees have to come off the board
   * or the colonist will happily chop wood at two percent food.
   */
  /**
   * Take the trees off the work board so food is the only plant job left.
   *
   * This is the bug that starved three colonies. In RimWorld, chopping a tree and harvesting a
   * berry bush both produce a `HarvestPlant` designation, and both are done under the
   * `PlantCutting` work type. There is no separate "chop" designation to look for. The earlier
   * version checked the `CutPlant` count, found zero, returned early and cancelled nothing,
   * while a colonist at nine percent food worked through 194 wood of oak trees with berries four
   * cells away.
   *
   * A pawn also completes every job at one priority before looking at the next and ignores
   * distance while doing so, so leaving one tree designated is enough to lose the race.
   */
  async clearWoodDesignations() {
    try {
      const b = this.base;
      // By definition, not by category. A cat=Plant query returns hundreds of grass entries
      // first, so the trees never appeared in the page and nothing was ever cancelled.
      const treeDefs = ["Plant_TreeOak", "Plant_TreePoplar", "Plant_TreePine", "Plant_TreeBirch",
                        "Plant_TreeWillow", "Plant_TreeCypress", "Plant_TreeMaple", "Plant_TreeTeak",
                        "Plant_TreeDrago", "Plant_TreeBamboo", "Plant_TreeCecropia", "Plant_TreePalm"];
      const pages = await Promise.all(treeDefs.map((d) =>
        api.get(`/things?def=${d}&detail=1&limit=300`).catch(() => ({}))));
      const trees = pages
        .flatMap((r) => r.things ?? [])
        .filter((t) => t.x != null && dist(t, b) < 70);
      if (trees.length === 0) return;
      const r = await api.tryPost("/designate", { type: "cancel", things: trees.map((t) => t.id) });
      if (r && (r.designated ?? 0) > 0) {
        this.log(`Cleared ${r.designated} tree designation(s); food is now the only plant work.`);
        // Cancelling can take food designations with it, so put those straight back.
        this.lastRoutine.delete("forage");
        await this.forage(this.base);
      }
    } catch {}
  }

  /**
   * Place the buildings that cost nothing: a sleeping spot, a crafting spot and a butcher spot.
   * All three are free, take almost no work, and two of them are the difference between a colony
   * that can feed itself and one that cannot.
   */
  async ensureFreeStructures() {
    const b = this.base;
    const built = this.builtDefs ?? new Set();
    const plan = [
      ["craftingspot", "CraftingSpot", b.x + 6, b.z + 2, true],
      ["butcherspot", "ButcherSpot", b.x + 6, b.z - 2, true],
      ["sleepingspot", "SleepingSpot", b.x + 1, b.z - 1, !this.hasAnyBed(built)],
    ];
    for (const [key, def, x, z, wanted] of plan) {
      if (!wanted) continue;
      if (await this.alreadyHave(def)) { this.placed.set(key, { def, x, z }); continue; }
      await this.place(key, def, x, z, { force: true });
    }
  }

  /**
   * Spike traps covering the approach to the door.
   *
   * Cheap, they need no research and no power, and they handle the early raids and manhunter
   * packs that a one or two person colony cannot fight in the open. Deliberately placed off the
   * direct path between the door and the fields, because a colonist who walks over their own
   * trap is a self inflicted casualty.
   */
  async manageDefenses(resources) {
    if (!this.every("defenses", 45)) return;
    const wood = resources.WoodLog ?? 0;
    if (wood < 150) return;                       // walls and furniture come first
    if (!this.placed.has("hut")) return;          // nothing to defend yet
    const b = this.base;
    const built = this.builtDefs ?? new Set();
    const have = built.has("TrapSpike") ? 1 : 0;
    if (have && this.placed.has("trap-5")) return;

    // An arc south of the hut, where raiders approach the door, two cells off the walls.
    const spots = [
      [b.x - 4, b.z - 6], [b.x - 2, b.z - 7], [b.x, b.z - 7],
      [b.x + 2, b.z - 7], [b.x + 4, b.z - 6], [b.x + 5, b.z - 4],
    ];
    let placed = 0;
    for (let i = 0; i < spots.length; i++) {
      const [x, z] = spots[i];
      const r = await this.place(`trap-${i}`, "TrapSpike", x, z, { stuff: "WoodLog", force: true });
      if (r === "placed") placed++;
    }
    if (placed > 0) {
      await this.thought(`${placed} spike trap(s) placed on the approach to the door, clear of the path the colonists use.`);
      await this.narrate("defenses", "building defenses", `Spike traps going in on the approach. They cost wood and nothing else, and they answer the early raids this colony could not fight in the open.`, 240000);
    }
  }

  /**
   * Primitive buildings that a proper one replaces.
   *
   * A sleeping spot is a bed you sleep badly in, a butcher spot is a slower butcher table with a
   * worse yield, and a crafting spot is a bench with no bonuses. Leaving the primitive standing
   * next to its replacement is clutter that a colonist can still choose to use, so once the real
   * thing exists the old one is deconstructed and its space and materials come back.
   */
  static UPGRADES = [
    { old: "SleepingSpot", replacedBy: ["Bed", "DoubleBed", "RoyalBed", "Bedroll"], note: "a real bed" },
    { old: "ButcherSpot", replacedBy: ["TableButcher"], note: "a butcher table" },
    { old: "CraftingSpot", replacedBy: ["FueledSmithy", "ElectricSmithy", "TableMachining", "HandTailoringBench", "ElectricTailoringBench"], note: "a proper workbench" },
    { old: "Campfire", replacedBy: ["FueledStove", "ElectricStove"], note: "a stove" },
  ];

  /** Tear down anything a better building has superseded. */
  async manageUpgrades() {
    if (!this.every("upgrades", 40)) return;
    const built = this.builtDefs ?? new Set();
    for (const u of ColonyAgent.UPGRADES) {
      if (!built.has(u.old)) continue;
      if (!u.replacedBy.some((d) => built.has(d))) continue;
      try {
        const res = await api.get(`/things?def=${u.old}&player=1&limit=20`);
        const ids = (res.things ?? []).map((t) => t.id);
        if (ids.length === 0) continue;
        const r = await api.tryPost("/designate", { type: "deconstruct", things: ids });
        if (r && (r.designated ?? 0) > 0) {
          this.stats.orders++;
          await this.thought(`Tearing down ${r.designated} ${u.old}: ${u.note} has replaced it.`);
          await this.narrate("upgrade", "retiring an old building", `The colony has ${u.note} now, so the old ${u.old} is coming down.`, 180000);
        }
      } catch {}
    }
  }

  /**
   * Corpses out of sight. Anything dead within the lived-in area is dragged to the far dump,
   * because every colonist who walks past one takes a mood hit that dwarfs hunger.
   */
  /**
   * Where things are kept, and what is allowed to be kept there.
   *
   * Four separate stores, because RimWorld punishes mixing them:
   *
   * - the warehouse, indoors, for goods and materials, so nothing sits out in the rain rusting
   *   and deteriorating and so a colonist fetching steel does not walk across the map for it;
   * - the cold room, for meals, raw food and carcasses fresh enough to still be worth butchering;
   * - a pit for human bodies, far enough away that nobody sees it, because a rotting corpse in
   *   sight is minus eighteen mood to everyone who walks past;
   * - a separate pit for insectoid bodies, kept apart from the human one so a hauler emptying
   *   one never wanders into the other.
   */
  static STORES = [
    {
      key: "warehouse-store", label: "Warehouse", type: "stockpile", priority: "Preferred",
      rect: (b) => ({ x: b.x - 2, z: b.z - 8, w: 5, h: 5 }), room: "room-warehouse",
      // Everything except bodies. Bodies have rooms of their own.
      filter: { denyCategories: ["CorpsesHumanlike", "CorpsesAnimal", "CorpsesMechanoid", "CorpsesInsect"] },
    },
    {
      key: "freezer-store", label: "Cold room", type: "stockpile", priority: "Important",
      rect: (b) => ({ x: b.x + 10, z: b.z - 2, w: 5, h: 5 }), room: "room-freezer",
      // Food, and carcasses that have not turned. AllowRotten off keeps the spoiled ones out, so
      // the cold room never becomes the thing it exists to prevent.
      // CorpsesInsect sits under CorpsesAnimal in the game's own category tree, so allowing
      // animal carcasses allows megaspiders too unless they are denied right after. Nobody wants
      // a megaspider in the larder.
      filter: {
        clear: true,
        categories: ["Foods", "CorpsesAnimal"],
        denyCategories: ["CorpsesInsect"],
        special: { AllowRotten: false },
      },
    },
    {
      key: "human-pit", label: "Human pit", type: "dumping", priority: "Low",
      rect: (b) => ({ x: b.x - 32, z: b.z - 30, w: 5, h: 5 }), far: true,
      filter: { clear: true, categories: ["CorpsesHumanlike"] },
    },
    {
      key: "insect-pit", label: "Insect pit", type: "dumping", priority: "Low",
      rect: (b) => ({ x: b.x + 32, z: b.z - 30, w: 5, h: 5 }), far: true,
      filter: { clear: true, categories: ["CorpsesInsect", "CorpsesMechanoid"] },
    },
    {
      key: "rubble", label: "Chunks and rubble", type: "dumping", priority: "Low",
      rect: (b) => ({ x: b.x + 14, z: b.z - 14, w: 6, h: 5 }), far: true,
      filter: { clear: true, categories: ["StoneChunks"] },
    },
  ];

  async manageStorage(colonists) {
    if (!this.every("storage", 20)) return;
    const b = this.base;
    for (const store of ColonyAgent.STORES) {
      if (this.zones.has(store.key)) continue;
      if (store.room && !this.placed.has(store.room)) continue;
      const rect = store.rect(b);
      // Keep the far pits on the map even when the colony landed near an edge.
      const size = this.mapSize ?? 250;
      rect.x = Math.max(2, Math.min(size - rect.w - 2, rect.x));
      rect.z = Math.max(2, Math.min(size - rect.h - 2, rect.z));
      const r = await api.tryPost("/zone", {
        type: store.type, rect, priority: store.priority, label: store.label, filter: store.filter,
      });
      if (!r) continue;
      this.zones.add(store.key);
      const unknown = r.filter?.unknown ?? [];
      if (unknown.length) this.log(`${store.label}: filter names the game did not recognise: ${unknown.join(", ")}`);
      await this.thought(`${store.label} zoned: ${r.filter?.summary ?? store.label}.`);
    }
  }

  /**
   * Corpses, sorted by what they are.
   *
   * Everything used to go to one dump. That put a raider, a megaspider and a deer the colony
   * meant to eat in the same pile, which wasted the meat and left the bodies in view. Now each
   * kind is hauled to the store that accepts it, and the stores' own filters decide the rest.
   */
  async manageCorpses() {
    if (!this.every("corpses", 25)) return;
    const b = this.base;
    try {
      const res = await api.get(`/things?cat=Item&detail=1&rect=${b.x - 26},${b.z - 26},53,60&limit=250`);
      const corpses = (res.things ?? []).filter((t) => t.corpse || /corpse/i.test(String(t.label ?? "")));
      if (corpses.length === 0) return;

      // Unforbidding is what actually makes a hauler pick a body up; the zone filters route it.
      await api.tryPost("/allow", { things: corpses.map((t) => t.id) });
      this.stats.orders++;

      const kind = (t) => {
        const s = `${t.def ?? ""} ${t.label ?? ""}`.toLowerCase();
        if (/megaspider|spelopede|megascarab|insect/.test(s)) return "insect";
        if (/mech|centipede|lancer|scyther|pikeman/.test(s)) return "mech";
        if (t.humanlike || /human|raider|tribal|pirate|drifter|outlander/.test(s)) return "human";
        return "animal";
      };
      const counts = corpses.reduce((acc, t) => { const k = kind(t); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
      const parts = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ");
      await this.thought(`${corpses.length} bodies to clear (${parts}). Animals to the cold room while they are still worth butchering, people to the far pit, insects to their own.`);
    } catch {}
  }

  /** Unforbid food anywhere near the base so the colony's own AI can actually eat it. */
  async allowFood() {
    if (!this.every("allow-food", 20)) return;
    const b = this.base;
    await api.tryPost("/allow", { rect: { x: b.x - 40, z: b.z - 40, w: 81, h: 81 } });
  }

  async manageSupplies(resources) {
    const b = this.base;
    await api.tryPost("/area/home", { rect: { x: b.x - 14, z: b.z - 14, w: 29, h: 29 }, add: true });
    await api.tryPost("/allow", { home: true });
  }

  // ---------------------------------------------------------------- letters

  async manageLetters(snap, colonists) {
    const letters = snap.letters ?? [];
    for (const l of letters) {
      if (this.seenLetters.has(l.id)) continue;
      this.seenLetters.add(l.id);
      this.journal("letter", { label: l.label, type: l.type, choices: (l.choices ?? []).map((c) => c.label) }, snap);
      const label = (l.label ?? "").toLowerCase();
      const type = l.type ?? "";
      const choices = l.choices ?? [];

      if (choices.length > 0) {
        const idx = this.chooseOption(label, choices);
        if (idx !== null) {
          await api.tryPost("/letter/choose", { id: l.id, choice: idx });
          await this.thought(`Letter "${l.label}": chose "${choices[idx]?.label ?? idx}".`);
          if (/join|wander|refugee|joins/.test(label)) await this.narrate("join", "new colonist", `${l.label}. Colony size is now ${colonists.length + 1}.`, 0, { priority: "high", askChat: true });
          continue;
        }
      }
      if (/raid|manhunter|mad |infestation|mech|siege|drop pod/.test(label) || /Threat/.test(type)) {
        await this.thought(`Alert: ${l.label}.`);
        await this.narrate("alert", "incident", `${l.label}. Colonists: ${colonists.length}, armed: ${colonists.filter((c) => c.weapon).length}.`, 20000, { priority: "high" });
      } else if (/dead|died|death|killed/.test(label)) {
        await this.thought(`Loss: ${l.label}.`);
        await this.narrate("death", "colonist lost", `${l.label}. Colony size is now ${colonists.length}.`, 0, { priority: "high" });
      } else if (/trader|caravan|visitor/.test(label)) {
        await this.thought(`${l.label}. Checking whether they will trade.`);
        await this.manageTrade();
      } else {
        this.log(`Letter: ${l.label}`);
      }
      await api.tryPost("/letter/dismiss", { id: l.id });
    }
    if (this.seenLetters.size > 400) this.seenLetters = new Set([...this.seenLetters].slice(-200));
  }

  /**
   * Pick an option on a choice letter. The bias is deliberate: say yes to anything that brings
   * a person into the colony, decline to choose on anything unrecognised. RimWorld usually puts
   * the consequential option first, and a wrong click is not reversible.
   */
  chooseOption(label, choices) {
    const enabled = choices.filter((c) => !c.disabled);
    if (enabled.length === 0) return null;
    const find = (re) => enabled.find((c) => re.test((c.label ?? "").toLowerCase()));

    // People. This is the whole growth path, so the net is cast wide.
    if (JOIN_LETTER.test(label)) {
      const yes = find(/accept|yes|welcome|allow|rescue|take (them|him|her) in|let (them|him|her) (in|join)|shelter/);
      if (yes) return yes.index;
    }
    // A hostile ultimatum: handing over a colonist is never worth it.
    if (/demand|ultimatum|tribute|extortion/.test(label)) {
      const refuse = find(/refuse|reject|fight|no\b/);
      if (refuse) return refuse.index;
    }
    if (/quest/.test(label)) {
      const later = find(/postpone|later|dismiss|close/);
      if (later) return later.index;
    }
    const safe = find(/close|ok|dismiss|postpone|later|acknowledge/);
    if (safe) return safe.index;
    return null;
  }

  // ---------------------------------------------------------------- growth

  /**
   * Everything that turns one colonist into ten: rescuing downed neutrals so they join,
   * capturing downed hostiles so they can be recruited, keeping enough beds and food for the
   * people already here, and accepting quests that hand over a person.
   */
  async manageGrowth(colonists, snap, resources) {
    const n = colonists.length;

    // 1. Rescue anyone friendly lying downed on the map. An escape pod survivor who is left
    //    where they fell dies there; rescued, they usually join.
    if (this.every("rescue", 10)) await this.rescueDowned(colonists);

    // 2. Capture downed hostiles once there is somewhere to put them.
    if (this.every("capture", 8)) await this.captureDowned(colonists, snap);

    // 3. Accept quests that grant a colonist and cost nothing up front.
    if (this.every("quests", 40)) await this.manageQuests(snap);

    // 4. A bed each, in a row that does not overlap the farms.
    if (this.every("beds", 25)) await this.ensureBeds(colonists, resources);

    // 5. Food and cooking scale with population, not with a fixed field size.
    if (this.every("farm-scale", 60)) await this.manageFarms(n);

    if (n > (this.lastKnownPopulation ?? 1)) {
      const gained = n - (this.lastKnownPopulation ?? 1);
      this.lastKnownPopulation = n;
      this.journal("population-up", { from: n - gained, to: n, names: colonists.map((c) => c.name) }, snap);
      await this.narrate("population", "colony grew", `The colony is now ${n} colonist${n === 1 ? "" : "s"}, up ${gained}. Target is ${POPULATION_TARGET}.`, 0, { priority: "high", askChat: true });
      // New arrivals need settings, work priorities and a bed straight away.
      for (const c of colonists) this.configured.delete(`work-${c.id}`);
      await this.syncWorkPlan(colonists);
      await this.ensureBeds(colonists, resources);
    } else if (n < (this.lastKnownPopulation ?? 1)) {
      this.journal("population-down", { from: this.lastKnownPopulation, to: n, names: colonists.map((c) => c.name) }, snap);
      this.lastKnownPopulation = n;
    }
  }

  async rescueDowned(colonists) {
    const rescuer = colonists.find((c) => !c.downed && !c.drafted && (c.health?.pct ?? 1) > 0.5);
    if (!rescuer) return;
    try {
      const res = await api.get("/pawns?role=all&detail=1");
      const candidates = (res.pawns ?? []).filter((p) => {
        if (p.dead || !p.downed || p.role === "colonist" || p.role === "prisoner") return false;
        if (!p.gender) return false;                       // humanlike only
        if (p.role === "enemy") return false;              // enemies go to captureDowned
        return dist(p, this.base) < 60;
      });
      if (candidates.length === 0) return;
      const target = candidates.sort((a, b) => dist(a, this.base) - dist(b, this.base))[0];
      const bed = await this.nearestBed(target);
      if (!bed) return;
      const r = await api.tryPost("/job", { pawn: rescuer.id, job: "Rescue", targetA: target.id, targetB: bed.id });
      if (r) {
        this.stats.orders++;
        await this.thought(`${rescuer.name} is rescuing ${target.name}, who is downed nearby.`);
        await this.narrate("rescue", "rescuing a stranger", `${target.name} is lying downed near the colony. ${rescuer.name} is carrying them to a bed. Rescued strangers often stay.`, 120000, { priority: "high", askChat: true });
      }
    } catch {}
  }

  async captureDowned(colonists, snap) {
    const hostiles = (snap.hostiles ?? []).filter((h) => h.downed && !h.dead && h.gender);
    if (hostiles.length === 0) return;
    const captor = colonists.find((c) => !c.downed && !c.drafted && (c.health?.pct ?? 1) > 0.5);
    if (!captor) return;
    try {
      const beds = await api.get("/things?cat=Building&player=1&def=Bed");
      const prisonBed = (beds.things ?? []).find((t) => t.forPrisoners);
      if (!prisonBed) return;                       // nowhere to put them yet
      const target = hostiles.sort((a, b) => dist(a, this.base) - dist(b, this.base))[0];
      const r = await api.tryPost("/job", { pawn: captor.id, job: "Capture", targetA: target.id, targetB: prisonBed.id });
      if (r) {
        this.stats.orders++;
        await this.thought(`Capturing downed hostile ${target.name ?? target.kind} for recruitment.`);
        await this.narrate("capture", "taking a prisoner", `${target.name ?? "A downed raider"} is being carried to a prison bed. Tended, fed and talked round, they become the next colonist.`, 90000, { priority: "high" });
      }
    } catch {}
  }

  async manageQuests(snap) {
    const quests = snap.quests ?? [];
    for (const q of quests) {
      if (this.seenQuests.has(q.id)) continue;
      const name = (q.name ?? "").toLowerCase();
      // Only accept quests that hand over a person and do not demand one back.
      if (!/refugee|join|shelter|survivor|wanderer|asylum/.test(name)) continue;
      if (/hand over|deliver|escort|transport|bandits will/.test(name)) continue;
      this.seenQuests.add(q.id);
      const r = await api.tryPost("/quest/accept", { id: q.id });
      if (r) {
        await this.thought(`Accepted quest "${q.name}".`);
        await this.narrate("quest", "quest accepted", `Accepted the quest "${q.name}", which should bring someone new to the colony.`, 0, { priority: "high" });
      }
    }
  }

  /**
   * One bed per colonist plus one prison bed, laid out in rows north of the hut so they cannot
   * land inside the rice or potato fields, which sit south of it.
   */
  async ensureBeds(colonists, resources) {
    const wood = resources.WoodLog ?? 0;
    if (wood < 45) return;
    const b = this.base;
    let built = new Map();
    try {
      const sum = await api.get("/things/summary?cat=Building&player=1");
      built = new Map((sum.groups ?? []).map((g) => [g.def, g.count]));
    } catch {}
    const bedCount = (built.get("Bed") ?? 0) + (built.get("DoubleBed") ?? 0) + (built.get("SleepingSpot") ?? 0);
    const want = colonists.length + 1;                  // one spare, and the spare becomes the prison bed
    if (bedCount >= want) return;

    // Beds belong in bedrooms. manageBase places one in each bedroom the moment the room closes,
    // so the only thing left here is cover for the gap: when someone joins before their room is
    // up, a free sleeping spot in the great hall beats a bedroll on the dirt outside, and it is
    // torn down again once a real bed exists for them.
    const bedrooms = [...this.placed.keys()].filter((k) => /^room-bed\d+$/.test(k)).length;
    const shortfall = want - Math.max(bedCount, 0);
    if (shortfall > 0 && bedrooms * 1 < colonists.length) {
      for (let i = 0; i < Math.min(shortfall, 4); i++) {
        await this.place(`spot-${i}`, "SleepingSpot", b.x - 2 + i, b.z - 2, { exact: true });
      }
      await this.thought(`${colonists.length} colonists and ${bedCount} beds. Sleeping spots in the great hall until the bedrooms close; a spot beats the ground, a bed beats a spot.`);
    }

    // The last bed becomes the prison bed, which is what makes recruiting possible at all.
    if (!this.placed.has("prison-bed-set") && bedCount + 1 >= want) {
      try {
        const beds = await api.get("/things?cat=Building&player=1&def=Bed");
        const list = (beds.things ?? []).filter((t) => !t.forPrisoners);
        const far = list.sort((a, b2) => dist(b2, this.base) - dist(a, this.base))[0];
        if (far) {
          const r = await api.tryPost("/bed/settings", { thing: far.id, forPrisoners: true });
          if (r) {
            this.placed.set("prison-bed-set", {});
            await this.thought("Marked the furthest bed as a prison bed so downed raiders can be captured and recruited.");
          }
        }
      } catch {}
    }
  }

  /** Grow the fields as the colony grows. Roughly 6 growing cells per colonist per crop. */
  /**
   * Crops on ground worth sowing, not on whatever was beside the base.
   *
   * The map's fertility is not uniform and the difference is not small: rich soil grows at 140%,
   * ordinary soil at 100%, gravel at 70%, and sand and stone at nothing at all. The old code put
   * every field at a fixed offset from the base, which on a gravelly landing site meant a third
   * less food per tile forever, and which now would put them under the bedroom wing besides.
   *
   * /fertility scans a block of map and ranks the plantable squares, which is the same thing the
   * game's own fertility overlay shows a human player.
   */
  async manageFarms(population) {
    const b = this.base;
    const wanted = Math.min(12, 5 + population * 2);   // rows per field
    const fields = [
      { key: "rice", plant: "Plant_Rice", label: "Rice", w: 7, h: wanted },
      { key: "potato", plant: "Plant_Potato", label: "Potatoes", w: 7, h: wanted },
      // Healroot is medicine, and a colonist will walk across the map to sow it. It waits until
      // there is food in store, because on day one that walk is time not spent eating.
      ...((this.foodDays ?? 0) > 2.5 ? [{ key: "healroot", plant: "Plant_Healroot", label: "Healroot", w: 4, h: 4 }] : []),
    ];

    for (const f of fields) {
      const zoneKey = `${f.key}-${f.h}`;
      if (this.zones.has(zoneKey)) continue;

      let rect = null;
      try {
        // /fertility takes the CENTRE of the area to scan, not a corner. Passing the corner put
        // the first fields twenty four cells from the base, which is a colonist walking four
        // times further to sow, to weed and to carry every harvest home, forever.
        // A generous limit on purpose. The route ranks by fertility first, so a short list is all
        // ground on the far side of the house: the only blocks that survive the house filter are
        // further down it. Thirty was not enough and every field fell back to a fixed plot.
        const scan = await api.get(`/fertility?x=${b.x}&z=${b.z}&w=56&h=56&block=${Math.min(f.w, f.h)}&min=0.85&limit=90`);
        const taken = this.farmRects ?? (this.farmRects = []);

        // The house is not a farm site. Its footprint runs from the workshop in the west to the
        // cold room in the east, and from the traps south of the warehouse to the last bedroom.
        // Reserve the rooms that exist, plus the one being built next, and nothing else.
        //
        // Reserving the whole planned house on day one was a mistake with a real cost: a house
        // twenty six cells wide and forty four deep swallowed every fertile block within reach,
        // so the first rice field landed twenty five cells from where the founder slept. On day
        // one there is no house, only a colonist who has to walk to the crop twice a day. The
        // fields start beside the colony and move outwards as rooms actually take their ground.
        const plan = this.roomPlan(population);
        const boxes = plan
          .filter((rm) => this.placed.has(`room-${rm.key}`) || rm.first)
          .map((rm) => ({ x0: rm.x0 - 1, x1: rm.x1 + 1, z0: rm.z0 - 1, z1: rm.z1 + 1 }));
        // The staging pile and the traps south of it are not building sites, but they are not
        // farmland either.
        boxes.push({ x0: b.x - 4, x1: b.x + 4, z0: b.z - 8, z1: b.z - 2 });

        const overlapsHouse = (c) => boxes.some((h) =>
          c.x + f.w >= h.x0 && c.x <= h.x1 && c.z + f.h >= h.z0 && c.z <= h.z1);

        // How far a colonist walks from the colony to reach this field.
        const walkFromHouse = (c) => Math.hypot(c.x + f.w / 2 - b.x, c.z + f.h / 2 - b.z);

        const spot = (scan.best ?? [])
          .filter((c) => !overlapsHouse(c))
          .filter((c) => !taken.some((t) => Math.abs(t.x - c.x) < f.w + 1 && Math.abs(t.z - c.z) < f.h + 1))
          // Best soil first, then the shortest walk from the house wall. A hundredth of a point
          // of fertility is not worth ten cells each way on every sowing and every harvest.
          .sort((p1, p2) => (p2.fertility - p1.fertility) || (walkFromHouse(p1) - walkFromHouse(p2)))[0];
        if (spot) {
          rect = { x: spot.x, z: spot.z, w: f.w, h: f.h };
          this.log(`${f.label}: ${spot.fertility} fertility at (${spot.x}, ${spot.z}), ${Math.round(walkFromHouse(spot))} cells from the colony.`);
        }
      } catch {}

      // No fertility reading available (older mod build, or nothing scored well): fall back to a
      // fixed plot west of the house, which is still clear of every planned room.
      if (!rect) {
        const idx = fields.indexOf(f);
        rect = { x: b.x - 12 - idx * 8 - f.w, z: b.z - 2, w: f.w, h: f.h };
      }

      const r = await api.tryPost("/zone", { type: "growing", rect, plant: f.plant, label: f.label });
      if (r) {
        this.zones.add(zoneKey);
        (this.farmRects ?? (this.farmRects = [])).push(rect);
        await this.thought(`${f.label} field sown on the best soil within reach of the house: ${rect.w} by ${rect.h}.`);
      }
    }
  }

  // ---------------------------------------------------------------- presentation

  async manageCamera(colonists, combat) {
    const living = colonists.filter((c) => !c.dead);
    if (living.length === 0) return;
    let target;
    if (combat) {
      target = living.find((c) => c.drafted) ?? living[0];
    } else {
      const active = living.filter((c) => !c.asleep && !c.inBed && !IDLE_JOBS.has(c.job?.def ?? ""));
      const pool = active.length > 0 ? active : living;
      const stale = Date.now() - this.followSince > 60000;
      const current = pool.find((c) => c.id === this.followTarget);
      target = current && !stale ? current : pool[Math.floor(Math.random() * pool.length)];
    }
    if (target && (target.id !== this.followTarget || Date.now() - this.followSince > 60000)) {
      this.followTarget = target.id;
      this.followSince = Date.now();
      await api.tryPost("/camera/follow", { pawn: target.id, enabled: true, deadzone: 2.5, speed: 4.5, zoom: combat ? 26 : 20 });
      await api.tryPost("/select", { pawn: target.id });
    }
  }

  async onNewDay(day, snap, colonists) {
    this.saveState(snap);
    this.journal("day", { day, date: snap.date }, snap);
    this.writeRunSummary(snap);
    const first = this.lastDay === null;
    this.lastDay = day;
    if (first) return;
    const summary = colonists.map((c) => `${c.name} mood ${Math.round((c.needs?.mood ?? 0) * 100)}%`).join(", ");
    await this.thought(`Day ${day}. ${summary}. Wood ${snap.resources?.WoodLog ?? 0}, food nutrition ${snap.foodNutrition ?? 0}.`);
    if (day % 2 === 0) await this.narrate("day", "day summary", `Day ${day}. ${colonists.length} colonist${colonists.length === 1 ? "" : "s"}, ${snap.resources?.WoodLog ?? 0} wood, ${snap.foodNutrition ?? 0} food nutrition, research ${snap.research?.label ?? "not started"}. Moods: ${summary}.`, 0, { askChat: true });
    if (this.saveDaily && day !== this.lastSavedDay) {
      const name = `PersonaCore_Day${day}`;
      const r = await api.tryPost("/game/save", { name });
      if (r) { this.lastSavedDay = day; this.log(`Saved ${name}.`); }
      await sleep(1500);
      await api.tryPost("/dialog/close", { all: true });
    }
  }

  printStatus(snap, day, colonists) {
    const r = snap.research;
    const cols = colonists.map((c) => `${c.name}[m${Math.round((c.needs?.mood ?? 0) * 100)} f${Math.round((c.needs?.food ?? 0) * 100)} r${Math.round((c.needs?.rest ?? 0) * 100)} ${c.job?.report ?? "idle"}]`).join(" ");
    this.log(`T${this.turn} D${day} ${snap.date} | wood ${this.lastCounted?.WoodLog ?? snap.resources?.WoodLog ?? 0} steel ${snap.resources?.Steel ?? 0} food ${snap.foodNutrition ?? 0} | research ${r ? `${r.label} ${Math.round(r.progress * 100)}%` : "none"} | ${cols}`);
  }
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const opt = { speed: 1, stepMs: 700, combatMs: 250, saveDaily: true, quiet: false };
  let turns = Infinity;
  for (const a of args) {
    if (a.startsWith("--speed=")) { opt.speed = parseInt(a.split("=")[1], 10); opt.autoSpeed = false; }
    else if (a === "--auto-speed") opt.autoSpeed = true;
    if (a.startsWith("--step-ms=")) opt.stepMs = parseInt(a.split("=")[1], 10);
    if (a.startsWith("--combat-ms=")) opt.combatMs = parseInt(a.split("=")[1], 10);
    if (a.startsWith("--turns=")) turns = parseInt(a.split("=")[1], 10);
    if (a === "--no-save") opt.saveDaily = false;
    if (a === "--quiet") opt.quiet = true;
  }
  console.log(`Persona Core colony agent -> ${API_BASE} (speed ${opt.speed}, step ${opt.stepMs} ms, combat ${opt.combatMs} ms)`);
  const agent = new ColonyAgent(opt);
  const stop = async () => {
    console.log("Releasing lease and exiting.");
    try {
      const snap = await api.get("/snapshot");
      agent.journal("run-stop", { reason: "signal" }, snap);
      agent.writeRunSummary(snap);
      console.log(`Run summary: ${agent.journalPath?.replace(/\.jsonl$/, ".md")}`);
    } catch {}
    await api.tryPost("/agent/release", { agent: AGENT_ID });
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await agent.runForever(turns);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error("Fatal agent error:", err); process.exit(1); });
}
