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
 * CLI: node scripts/colony-agent.mjs [--speed=3] [--step-ms=700] [--combat-ms=250] [--turns=N] [--no-save] [--quiet]
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
const TECH_ORDER = [
  "ComplexFurniture", "Pemmican", "Stonecutting", "PassiveCooler", "Brewing", "TreeSowing",
  "Smithing", "ComplexClothing", "Electricity", "Batteries", "SolarPanels", "MicroelectronicsBasics",
  "Gunsmithing", "Machining", "Hydroponics", "MedicineProduction", "PackagedSurvivalMeal",
  "Fabrication", "AdvancedFabrication", "Bionics", "Cryptosleep", "ShipBasics",
];

/** Animals a lone bow hunter can take without real risk. Matched against the pawn kind label. */
const SMALL_GAME = ["squirrel", "hare", "rat", "chinchilla", "turkey", "chicken", "duck", "guinea pig", "raccoon", "capybara", "muffalo calf", "tortoise", "snake", "cobra", "iguana", "monkey", "cat"];
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
    this.speed = options.speed ?? 3;
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
    const resources = snap.resources ?? {};
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

    if (snap.paused || snap.speed !== this.speed) await api.tryPost("/speed", { speed: this.speed });

    // 1. Colonist needs, threats and letters are always on. Everything else is gated by the
    //    current phase.
    await this.manageNeeds(colonists, snap, resources);
    await this.manageLetters(snap, colonists);

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

    switch (phase) {
      case "food":
        // Nothing but calories. Cutting trees and harvesting berries are the same work type, so
        // leaving chop designations standing means the colonist fells a poplar while starving.
        await this.allowFood();
        if (this.every("clear-chop", 6)) await this.clearWoodDesignations();
        if (this.every("food", 3)) await this.manageFood(colonists, snap, resources);
        // The bow is PART of solving hunger, not a project that waits until hunger is solved.
        // RimWorld will not let a pawn take a hunt job without a ranged weapon, so a colony with
        // no bow cannot eat meat at all. Leaving the bow to its own phase deadlocked the agent:
        // it stayed in the food phase forever because food was low, while the one thing that
        // would have produced food sat behind a phase it could never reach.
        if (colonists.every((c) => !c.weapon) && (resources.WoodLog ?? 0) >= 30) {
          if (this.every("weapons", 6)) await this.manageWeapons(colonists, resources);
          if (this.every("bills", 8)) await this.manageBills(resources);
        } else if ((resources.WoodLog ?? 0) < 30 && this.every("wood-for-bow", 12)) {
          await this.manageWood(resources);
        }
        break;

      case "basics":
        // Campfire and a bed. Cheap, fast, and they stop the mood spiral before it starts.
        if (this.every("wood", 8)) await this.manageWood(resources);
        if (this.every("build", 5)) await this.manageBase(colonists, resources);
        if (this.every("food", 10)) await this.manageFood(colonists, snap, resources);
        break;

      case "comfort":
        if (this.every("build", 5)) await this.manageBase(colonists, resources);
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
        if (this.every("build", 5)) await this.manageBase(colonists, resources);
        if (this.every("food", 10)) await this.manageFood(colonists, snap, resources);
        break;

      case "farm":
        if (this.every("farm", 10)) await this.scaleFarms(colonists.length);
        if (this.every("food", 8)) await this.manageFood(colonists, snap, resources);
        if (this.every("build", 15)) await this.manageBase(colonists, resources);
        break;

      case "grow":
      default:
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
    if (this.every("work", 30)) await this.manageWork(colonists);
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
    if (hungriest < 0.45 || daysOfFood < 1.5) {
      this.phaseReason = `Food first: the hungriest colonist is at ${Math.round(hungriest * 100)} percent with ${daysOfFood.toFixed(1)} days stored.`;
      return "food";
    }
    if (!built.has("Campfire") || !this.hasAnyBed(built)) {
      this.phaseReason = !built.has("Campfire")
        ? "A campfire next: warmth, light and cooked meals for twenty wood."
        : "A bed next: sleeping on the ground is a mood penalty paid every night, and it costs forty five wood.";
      return "basics";
    }
    // A bow comes before the furniture, because on a naked start the bow IS the food supply.
    // Berry bushes near a base are worth about a day of food between them; hunting is what
    // actually feeds a colony, and hunting without a weapon is how founders get killed.
    if (unarmed === colonists.length && wood >= 30) {
      this.phaseReason = `Nothing here can hunt or fight. A short bow is thirty wood and it is the difference between foraging scraps and eating meat.`;
      return "weapon";
    }
    if (!hasTable || !hasChair) {
      this.phaseReason = "A table and a stool. Eating off the floor is a penalty paid at every meal, for about fifty wood.";
      return "comfort";
    }
    if (!this.placed.has("hut")) {
      this.phaseReason = `Walls and a door now that the cheap things are done, with ${wood} wood on hand.`;
      return "house";
    }
    if (daysOfFood < 6) {
      this.phaseReason = `Fields next: ${daysOfFood.toFixed(1)} days of food is not a buffer.`;
      return "farm";
    }
    this.phaseReason = `Survival is handled. Growing the colony toward ${POPULATION_TARGET}.`;
    return "grow";
  }

  hasAnyBed(built) {
    for (const def of built) if (/^(Bed|DoubleBed|RoyalBed|SleepingSpot|Bedroll)/.test(def)) return true;
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

    // Fresh colony: anchor on the founder, but never within 30 cells of a map edge.
    const founder = colonists[0];
    const margin = 30, max = (this.mapSize ?? 250) - margin;
    this.base = {
      x: Math.round(Math.min(max, Math.max(margin, founder.x))),
      z: Math.round(Math.min(max, Math.max(margin, founder.z))),
    };
    const b = this.base;
    this.log(`Founding colony at (${b.x}, ${b.z}) with ${colonists.map((c) => c.name).join(", ")}.`);
    await this.thought(`Founded ${snap.colonyName ?? "the colony"} at (${b.x}, ${b.z}). Founder: ${founder.name}.`);
    await this.narrate("founding", "colony founded", `${founder.name} has landed with nothing at all. Naked Brutality start, no weapon, no food, no shelter. Base anchored at ${b.x}, ${b.z} in a ${snap.weather ?? "clear"} ${snap.temperatureC ?? "?"} degree temperate forest.`, 0, { priority: "high", askChat: true });

    // Clear the build footprint so blueprints can land.
    await api.tryPost("/designate", { type: "chop", rect: { x: b.x - 5, z: b.z - 5, w: 11, h: 11 } });
    // Home area around the base so items on the ground count and get hauled.
    const home = await api.tryPost("/area/home", { rect: { x: b.x - 16, z: b.z - 16, w: 33, h: 33 }, add: true });
    this.log(`Home area: ${home ? JSON.stringify(home).slice(0, 120) : "failed"}`);
    await api.tryPost("/allow", { home: true });
    if (!this.zones.has("stockpile")) {
      const z = await api.tryPost("/zone", { type: "stockpile", rect: { x: b.x + 5, z: b.z - 5, w: 6, h: 5 }, priority: "Preferred", label: "Main stockpile" });
      if (z) this.zones.add("stockpile");
    }
    if (!this.zones.has("dumping")) {
      const z = await api.tryPost("/zone", { type: "dumping", rect: { x: b.x + 12, z: b.z - 5, w: 4, h: 4 }, label: "Chunks" });
      if (z) this.zones.add("dumping");
    }
    // Five of the most important early buildings cost nothing at all and take no work. There is
    // never a resource excuse for skipping them, so they go down on the first turn.
    await this.place("sleepingspot", "SleepingSpot", b.x + 1, b.z - 1);
    await this.place("craftingspot", "CraftingSpot", b.x + 6, b.z + 2);
    // Arming the colony is the single highest-value thing in the first two days. Two founders
    // have now been lost to a drifter while the colony had hundreds of wood and no weapon.
    this.weaponRush = true;
    // A butcher spot is free and is the only way a hunted animal becomes food.
    await this.place("butcherspot", "ButcherSpot", b.x + 6, b.z - 2);
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

    if (days < 3 || starving) {
      // Armed? Hunt. That is where the calories are. Foraging is the fallback, not the plan.
      const armed = colonists.some((c) => c.weapon && !c.downed);
      if (armed) await this.huntSmallGame(colonists, resources, starving);
      await this.forage(colonists[0]);
      if (!armed) await this.huntSmallGame(colonists, resources, starving);
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
    if ((raw > 0 || meat > 0 || starving) && this.every("food-bill", 15)) {
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
    if (!this.every("forage", 12)) return;
    // Deliberately not gated on the HarvestPlant count: trees share that designation, so a board
    // full of oaks used to look like a board full of food and suppressed foraging entirely.
    const origin = this.base ?? near;
    try {
      // Find the food plants by definition across the whole map and take the nearest ones. A
      // rectangle around the base only catches what happens to be inside it: on one map that was
      // a single bush while a hundred stood a short walk away, and the founder starved.
      const defs = ["Plant_Berry", "Plant_Agave", "Plant_Bush"];
      const results = await Promise.all(defs.map((d) =>
        api.get(`/things?def=${d}&detail=1&limit=400`).catch(() => ({}))));
      const bushes = results
        .flatMap((r) => r.things ?? [])
        .filter((t) => (t.nutrition ?? 0) > 0 && t.harvestable !== false && t.x != null)
        .map((t) => ({ ...t, d: dist(t, origin) }))
        .sort((a, b) => a.d - b.d);
      if (bushes.length === 0) {
        this.log("No forageable food plants found anywhere on the map.");
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

  async manageWood(resources) {
    // Never put trees on the board while people are starving: they compete with berries for the
    // same work type and the same designation, and trees usually win on count.
    if (this.foodEmergency) return;
    const wood = resources.WoodLog ?? 0;
    if (wood >= 250) return;
    const pending = await this.pendingDesignations("CutPlant") + await this.pendingDesignations("HarvestPlant");
    if (pending > 8) return;
    const b = this.base;
    for (const r of [12, 20, 30, 40]) {
      const res = await api.tryPost("/designate", { type: "chop", rect: { x: b.x - r, z: b.z - r, w: r * 2, h: r * 2 } });
      if (res && (res.designated ?? 0) > 0) {
        this.stats.orders++;
        this.log(`Designated ${res.designated} wood-yielding plants within ${r} cells (wood ${wood}).`);
        if (wood < 40) await this.thought(`Chopping wood within ${r} cells. We need ${Math.max(0, 80 - wood)} more for the hut.`);
        return;
      }
    }
    this.log(`No choppable plants found within 40 cells (wood ${wood}).`);
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
  async place(key, def, x, z, opts = {}) {
    if (this.placed.has(key) && !opts.force) return "already";
    if (opts.force) {
      // `force` means the caller checked the world and the finished building is missing. That is
      // still true while its blueprint is standing, so without this cooldown the agent re-places
      // and re-announces the same table every single cycle until construction completes.
      const placedAt = this.placedAt.get(key) ?? -Infinity;
      if (this.turn - placedAt < 120) return "already";
      this.placed.delete(key);
      this.failedPlacements.delete(key);
    }
    const attempts = this.failedPlacements.get(key) ?? 0;
    if (attempts > 6) return false;
    const offsets = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [0, 2], [-2, 0], [0, -2]];
    for (const [dx, dz] of offsets.slice(0, opts.exact ? 1 : offsets.length)) {
      try {
        await api.post("/build", { def, x: x + dx, z: z + dz, rot: opts.rot ?? 0, stuff: opts.stuff });
        this.placed.set(key, { def, x: x + dx, z: z + dz });
        this.placedAt.set(key, this.turn);
        this.stats.orders++;
        this.log(`Placed ${def} at (${x + dx}, ${z + dz}).`);
        return "placed";
      } catch {}
    }
    this.failedPlacements.set(key, attempts + 1);
    return false;
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

    // A butcher spot costs nothing and unlocks the whole meat supply chain.
    if (!built.has("ButcherSpot") && !built.has("TableButcher")) {
      await this.place("butcherspot", "ButcherSpot", b.x + 6, b.z - 2, { force: true });
    }

    // Campfire first: warmth, light, cooking. 20 wood.
    if (wood >= 20 && !built.has("Campfire")) {
      if ((await this.place("campfire", "Campfire", b.x - 1, b.z - 1, { force: true })) === "placed") {
        await this.thought("Campfire blueprint down: warmth, light and simple meals.");
      }
    }

    // Bed, table, chair: the three biggest early mood fixes.
    if (wood >= 45 && !built.has("Bed")) await this.place("bed", "Bed", b.x - 1, b.z + 1, { stuff: "WoodLog", rot: 0, force: true });
    if (wood >= 30 && !built.has("Table1x2c") && !built.has("Table2x2c")) {
      if ((await this.place("table", "Table1x2c", b.x + 1, b.z + 1, { stuff: "WoodLog", rot: 0, force: true })) === "placed") {
        await this.thought("Dining table placed. No more eating on the floor.");
      }
    }
    if (wood >= 25 && !built.has("Stool") && !built.has("DiningChair")) await this.place("stool", "Stool", b.x + 1, b.z, { stuff: "WoodLog", force: true });

    // Founder's hut: 7x7 wooden walls, door on the south side. ~85 wood.
    // Walls last of the early build: only once the campfire, bed and table exist, so 85 wood
    // and several hours of construction cannot crowd out the things that cost a fifth of that
    // and matter more.
    const cheapDone = built.has("Campfire") && this.hasAnyBed(built) && (built.has("Table1x2c") || built.has("Table2x2c"));
    if (wood >= 80 && cheapDone && !this.placed.has("hut")) {
      const items = [];
      for (let x = b.x - 3; x <= b.x + 3; x++) {
        items.push({ def: "Wall", stuff: "WoodLog", x, z: b.z + 3 });
        if (x !== b.x) items.push({ def: "Wall", stuff: "WoodLog", x, z: b.z - 3 });
      }
      for (let z = b.z - 2; z <= b.z + 2; z++) {
        items.push({ def: "Wall", stuff: "WoodLog", x: b.x - 3, z });
        items.push({ def: "Wall", stuff: "WoodLog", x: b.x + 3, z });
      }
      items.push({ def: "Door", stuff: "WoodLog", x: b.x, z: b.z - 3 });
      const r = await api.tryPost("/build/bulk", { items });
      // /build/bulk reports per-item outcomes inside `results` and returns ok even when every
      // blueprint was rejected. Recording the hut as built on a total failure permanently gates
      // the growing zones, traps and research bench behind a structure that does not exist.
      const landed = (r?.results ?? []).filter((x) => x && x.ok !== false).length;
      if (r && landed >= Math.ceil(items.length * 0.6)) {
        this.placed.set("hut", { def: "Wall", x: b.x, z: b.z });
        this.stats.orders++;
        await this.thought(`Founder's hut: ${landed} of ${items.length} wall and door blueprints placed.`);
        await this.narrate("hut", "shelter started", `Seven by seven wooden hut blueprinted at the base with a south door, ${landed} of ${items.length} cells accepted, using part of the ${wood} wood stockpiled.`, 0, { priority: "high" });
      } else if (r) {
        this.log(`Hut placement rejected: only ${landed} of ${items.length} blueprints landed. Will retry.`);
      }
    }

    // Recreation.
    if (wood >= 30 && !built.has("HorseshoesPin")) {
      if ((await this.place("horseshoes", "HorseshoesPin", b.x - 6, b.z, { stuff: "WoodLog", force: true })) === "placed") {
        await this.thought("Horseshoe pin placed for recreation.");
      }
    }

    // Growing zones once the hut is underway.
    if (this.placed.has("hut") || wood >= 40) {
      if (!this.zones.has("rice")) {
        const z = await api.tryPost("/zone", { type: "growing", rect: { x: b.x - 8, z: b.z + 5, w: 8, h: 6 }, plant: "Plant_Rice", label: "Rice" });
        if (z) { this.zones.add("rice"); await this.thought("Rice field zoned. Fast food buffer."); }
      }
      if (!this.zones.has("potato")) {
        const z = await api.tryPost("/zone", { type: "growing", rect: { x: b.x + 1, z: b.z + 5, w: 8, h: 6 }, plant: "Plant_Potato", label: "Potatoes" });
        if (z) this.zones.add("potato");
      }
      if (!this.zones.has("healroot")) {
        const z = await api.tryPost("/zone", { type: "growing", rect: { x: b.x - 8, z: b.z - 7, w: 4, h: 4 }, plant: "Plant_Healroot", label: "Healroot" });
        if (z) this.zones.add("healroot");
      }
    }

    // One bed per colonist.
    const extra = colonists.length - 1;
    for (let i = 1; i <= extra; i++) {
      if (wood < 45) break;
      await this.place(`bed-${i}`, "Bed", b.x + 5 + (i % 4) * 2, b.z + 8 + Math.floor(i / 4) * 3, { stuff: "WoodLog", rot: 0 });
    }

    // Perimeter wooden spike traps: cheap defense, but only once the hut and bed exist.
    if (wood >= 150 && this.placed.has("hut") && built.has("Bed")) {
      const trapCoords = [
        [b.x, b.z - 6], [b.x + 4, b.z - 5], [b.x - 4, b.z - 5], [b.x + 6, b.z - 3]
      ];
      for (let i = 0; i < trapCoords.length; i++) {
        const [tx, tz] = trapCoords[i];
        await this.place(`trap-${i}`, "TrapSpike", tx, tz, { stuff: "WoodLog" });
      }
    }

    // Prisoner recruitment hut: 5x5 wooden walls at (b.x + 10, b.z) with a bed set for prisoners
    if (wood >= 220 && colonists.length >= 2 && this.placed.has("hut") && !this.placed.has("prison_hut")) {
      const px = b.x + 10, pz = b.z;
      const prisonItems = [];
      for (let x = px - 2; x <= px + 2; x++) {
        prisonItems.push({ def: "Wall", stuff: "WoodLog", x, z: pz + 2 });
        if (x !== px) prisonItems.push({ def: "Wall", stuff: "WoodLog", x, z: pz - 2 });
      }
      for (let z = pz - 1; z <= pz + 1; z++) {
        prisonItems.push({ def: "Wall", stuff: "WoodLog", x: px - 2, z });
        prisonItems.push({ def: "Wall", stuff: "WoodLog", x: px + 2, z });
      }
      prisonItems.push({ def: "Door", stuff: "WoodLog", x: px, z: pz - 2 });
      const r = await api.tryPost("/build/bulk", { items: prisonItems });
      const landedPrison = (r?.results ?? []).filter((x) => x && x.ok !== false).length;
      if (r && landedPrison >= Math.ceil(prisonItems.length * 0.6)) {
        this.placed.set("prison_hut", { def: "Wall", x: px, z: pz });
        await this.place("prison_bed", "Bed", px, pz, { stuff: "WoodLog", rot: 0 });
        await this.thought("Prisoner hut and bed placed for recruitment.");
      }
    }

    // Research bench when the materials exist.
    if (wood >= 100 && steel >= 25 && !built.has("SimpleResearchBench")) {
      if ((await this.place("research", "SimpleResearchBench", b.x + 8, b.z - 2, { stuff: "WoodLog", rot: 0, force: true })) === "placed") {
        await this.thought("Research bench placed. The climb out of the stone age starts here.");
        await this.narrate("bench", "research bench started", `Simple research bench blueprinted. Wood ${wood}, steel ${steel}. The climb out of the neolithic starts now.`, 0, { priority: "high", askChat: true });
      }
    }
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

  async manageBills(resources) {
    const colonistSkills = [...this.skillCache.values()];
    try {
      const spots = await api.get("/things?def=CraftingSpot&player=1");
      const spot = (spots.things ?? [])[0];
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
      const butchers = await api.get("/things?def=ButcherSpot&player=1");
      const tables = await api.get("/things?def=TableButcher&player=1").catch(() => ({}));
      const bench = (tables.things ?? [])[0] ?? (butchers.things ?? [])[0];
      if (bench && !this.placed.has("bill-butcher")) {
        const r = await api.tryPost("/bill", { thing: bench.id, recipe: "ButcherCorpseFlesh", mode: "forever" });
        if (r) { this.placed.set("bill-butcher", {}); await this.thought("Standing butcher bill set. Every kill now becomes meat and leather."); }
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
      Construction: 2,
      Growing: 2,
      PlantCutting: 3,          // below Growing: sowing and harvesting beat felling trees
      Hunting: 3,
      Crafting: 3,
      Mining: 4,
      Hauling: 3,               // never 1: it would eat the whole day
      Research: 4,
      Tailoring: 4, Smithing: 4, Warden: solo ? 0 : 2,
      Art: 0, Cleaning: colonists.length >= 4 ? 4 : 0,
      Handling: colonists.length >= 3 ? 4 : 0,
      Childcare: colonists.length >= 3 ? 3 : 0,
    };
    if (lvl("Intellectual") >= 5) base.Research = 3;

    if (this.foodEmergency) {
      // Harvesting a berry bush is PlantCutting. It has to outrank every other plant job, and
      // hauling has to drop, or a starving colonist stockpiles wood instead of eating.
      return { ...base, PlantCutting: 1, Growing: 1, Cooking: 1, Hunting: 2, Hauling: 4,
               Construction: 4, Crafting: 4, Mining: 4, Research: 4, Tailoring: 4, Smithing: 4 };
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
      const res = await api.get(`/things?cat=Plant&detail=1&rect=${b.x - 60},${b.z - 60},121,121&limit=500`);
      // Trees, and anything else woody that is not itself food.
      const trees = (res.things ?? []).filter((t) => t.tree && !((t.nutrition ?? 0) > 0));
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
    if (this.every("farm-scale", 60)) await this.scaleFarms(n);

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

    for (let i = bedCount; i < want && i < 14; i++) {
      // Rows of beds two cells apart, north of the hut. The farms are all at z >= b.z + 5.
      const col = i % 5;
      const row = Math.floor(i / 5);
      const x = b.x - 4 + col * 2;
      const z = b.z - 6 - row * 3;
      await this.place(`bed-${i}`, "Bed", x, z, { stuff: "WoodLog", rot: 0, force: true });
    }
    await this.thought(`Beds: ${bedCount} for ${colonists.length} colonists; placing more north of the hut.`);

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
  async scaleFarms(population) {
    const b = this.base;
    const wanted = Math.min(14, 6 + population * 2);
    for (const [key, plant, xOff] of [["rice", "Plant_Rice", -8], ["potato", "Plant_Potato", 1]]) {
      const zoneKey = `${key}-${wanted}`;
      if (this.zones.has(zoneKey)) continue;
      const r = await api.tryPost("/zone", {
        type: "growing",
        rect: { x: b.x + xOff, z: b.z + 5, w: 8, h: wanted },
        plant,
        label: key === "rice" ? "Rice" : "Potatoes",
      });
      if (r) {
        this.zones.add(zoneKey);
        this.log(`Farm ${key} sized for ${population} colonists (${8 * wanted} cells).`);
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
    this.log(`T${this.turn} D${day} ${snap.date} | wood ${snap.resources?.WoodLog ?? 0} steel ${snap.resources?.Steel ?? 0} food ${snap.foodNutrition ?? 0} | research ${r ? `${r.label} ${Math.round(r.progress * 100)}%` : "none"} | ${cols}`);
  }
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const opt = { speed: 3, stepMs: 700, combatMs: 250, saveDaily: true, quiet: false };
  let turns = Infinity;
  for (const a of args) {
    if (a.startsWith("--speed=")) opt.speed = parseInt(a.split("=")[1], 10);
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
