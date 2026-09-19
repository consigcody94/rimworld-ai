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

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".agent-state");

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
    this.skillCache = new Map();
    this.stats = { turns: 0, combatTurns: 0, orders: 0, errors: 0 };
  }

  // ---------------------------------------------------------------- logging

  log(msg) { if (!this.quiet) console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }

  async thought(text) {
    this.log(`THOUGHT ${text}`);
    await studio("/api/thought", { text });
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
    const colonists = (snap.colonists ?? []).filter((c) => !c.dead);
    const hostiles = snap.hostiles ?? [];
    const resources = snap.resources ?? {};
    const day = Math.floor((snap.tick ?? 0) / 60000) + 1;

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
      return true;
    }
    if (this.inCombat) await this.endCombat(colonists);

    if (snap.paused || snap.speed !== this.speed) await api.tryPost("/speed", { speed: this.speed });

    // 1. Colonist needs and health always come first.
    await this.manageNeeds(colonists, snap, resources);

    // 2. Letters, quests, dialogs.
    await this.manageLetters(snap, colonists);

    // 2b. Arm the colony. An unarmed colony is the single biggest cause of a lost run.
    if (colonists.some((c) => !c.weapon && !c.downed)) {
      if (this.every("weapons", 8)) await this.manageWeapons(colonists, resources);
    } else if (this.weaponRush) {
      this.weaponRush = false;
      await this.syncWorkPlan(colonists);
      this.log("Colony is armed; normal work priorities restored.");
    }

    // 3. Food security.
    if (this.every("food", (snap.foodNutrition ?? 0) < 4 ? 3 : 8)) await this.manageFood(colonists, snap, resources);

    // 4. Materials.
    if (this.every("wood", 10)) await this.manageWood(resources);
    if (this.every("steel", 40)) await this.manageSteel(resources, colonists, day);

    // 5. Shelter, furniture, workbenches.
    if (this.every("build", 8)) await this.manageBase(colonists, resources);

    // 6. Production bills.
    if (this.every("bills", 20)) await this.manageBills(resources);

    // 7. Research.
    if (this.every("research", 20)) await this.manageResearch(snap.research);

    // 8. Trade.
    if (this.every("trade", 20)) await this.manageTrade();

    // 9. Work priorities for new arrivals, supply hygiene, and prisoner recruitment.
    if (this.every("work", 30)) await this.manageWork(colonists);
    if (this.every("prisoners", 15)) await this.managePrisoners(colonists, snap);
    if (this.every("supplies", 40)) await this.manageSupplies(resources);

    // Check colony expansion milestone
    if (colonists.length >= 10 && this.every("milestone-10", 300)) {
      await this.thought(`MILESTONE ACHIEVED: Colony has ${colonists.length} living colonists!`);
      await this.narrate("milestone-10", "milestone reached", `The colony has reached ${colonists.length} living colonists on day ${Math.floor((snap.tick ?? 0) / 60000) + 1}.`, 0, { priority: "high", askChat: true });
    }

    // 10. Daily save and day commentary.
    if (day !== this.lastDay) await this.onNewDay(day, snap, colonists);

    // 11. Camera and status.
    await this.manageCamera(colonists, false);
    if (this.every("status", 5)) this.printStatus(snap, day, colonists);
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
    await this.place("sleepingspot", "SleepingSpot", b.x + 1, b.z - 1);
    await this.place("craftingspot", "CraftingSpot", b.x + 6, b.z + 2);
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
  decidePosture(colonists, threats) {
    const able = colonists.filter((c) => !c.downed && (c.health?.pct ?? 1) > 0.25);
    const armed = able.filter((c) => c.weapon);
    const inContact = threats.some((t) => able.some((c) => dist(c, t) <= 2.5));
    if (inContact) return { evade: false, reason: "already in melee contact, disengaging would give free hits" };

    const rangedThreats = threats.filter((t) => this.isRanged(t));
    if (rangedThreats.length > 0 && armed.length === 0) {
      return { evade: true, reason: `${rangedThreats.length} ranged hostile(s) and nothing to shoot back with` };
    }
    if (threats.some((t) => this.isBigAnimal(t)) && armed.length === 0) {
      return { evade: true, reason: "large predator and no weapon" };
    }
    if (threats.length >= able.length * 2 && armed.length === 0) {
      return { evade: true, reason: `outnumbered ${threats.length} to ${able.length} with no weapons` };
    }
    return { evade: false, reason: armed.length > 0 ? "we are armed" : "melee only, we can take it" };
  }

  async combatTurn(colonists, threats, snap) {
    this.stats.combatTurns++;
    const able = colonists.filter((c) => !c.downed && (c.health?.pct ?? 1) > 0.15);
    const armed = able.filter((c) => c.weapon);
    const posture = this.decidePosture(colonists, threats);
    // Posture is sticky for a fight: flip-flopping between fleeing and fighting is the worst option.
    if (!this.inCombat) {
      this.combatPosture = posture;
      this.inCombat = true;
      const names = [...new Set(threats.map((t) => t.kind ?? t.name))].join(", ");
      this.log(`COMBAT ${threats.length} threat(s): ${names} (${posture.evade ? "EVADE" : "FIGHT"}: ${posture.reason})`);
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
        // Re-issue every turn while evading: a stale move order means standing still and being hit.
        const p = this.awayFrom(c, nearest, 30);
        await api.tryPost("/pawn/settings", { pawn: c.id, hostility: "Flee" });
        await api.tryPost("/move", { pawn: c.id, x: p.x, z: p.z, draft: true });
        this.stats.orders++;
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
        await api.tryPost("/pawn/settings", { pawn: c.id, selfTend: true, medicalCare: "Best", hostility: "Attack" });
        await api.tryPost("/pawn/schedule", { pawn: c.id, preset: "optimal" });
        this.configured.add(c.id);
      }

      // Rule 1: a hungry pawn eats before anything else. Never send a starving pawn to bed.
      if (food < 0.3) {
        if ((snap.foodNutrition ?? 0) < 2) await this.forage(c);
        if (food < 0.15 && this.every(`starving-${c.id}`, 40)) {
          await this.thought(`${c.name} is starving (${Math.round(food * 100)}%). Food is the only priority.`);
          await this.narrate(`starving-${c.id}`, "starvation risk", `${c.name} is at ${Math.round(food * 100)} percent food with only ${snap.foodNutrition ?? 0} nutrition stockpiled. Every other job is being dropped for food.`, 180000, { priority: "high", askChat: true });
          await this.huntSmallGame(colonists, resources, true);
        }
        continue;
      }

      // Rule 2: serious bleeding or a real injury gets one bed-rest order, not one per turn.
      const seriouslyHurt = (h.bleedRate ?? 0) > 0.15 || (h.needsTending && (h.pct ?? 1) < 0.6);
      if (seriouslyHurt && !c.inBed && !c.drafted && !this.inCombat && this.every(`bedrest-${c.id}`, 60)) {
        const bed = await this.nearestBed(c);
        if (bed) { await api.tryPost("/job", { pawn: c.id, job: "LayDown", targetA: bed.id }); this.stats.orders++; }
        await this.thought(`${c.name} is hurt (${Math.round((h.pct ?? 1) * 100)}% health, bleed ${h.bleedRate ?? 0}); one round of bed rest and self tending.`);
        await this.narrate(`hurt-${c.id}`, "colonist injured", `${c.name} is at ${Math.round((h.pct ?? 1) * 100)} percent health, bleed rate ${h.bleedRate ?? 0}. Ordering bed rest and self tending.`, 240000);
      }

      // Rule 3: exhaustion outside the sleep window, once.
      if (rest < 0.1 && !c.asleep && !c.inBed && !c.drafted && this.every(`exhausted-${c.id}`, 60)) {
        const bed = await this.nearestBed(c);
        if (bed) { await api.tryPost("/job", { pawn: c.id, job: "LayDown", targetA: bed.id }); this.stats.orders++; }
      }

      // Rule 4: mood. Only when a break is imminent and joy is actually low, and only for a short window.
      if (!this.joyMode.has(c.id) && mood < threshold + 0.02 && joy < 0.45 && !this.inCombat) {
        this.joyMode.set(c.id, this.turn);
        await api.tryPost("/pawn/schedule", { pawn: c.id, preset: "joy" });
        await this.thought(`${c.name} mood ${Math.round(mood * 100)}% at break threshold ${Math.round(threshold * 100)}%. Short recreation window.`);
        await this.narrate(`mood-${c.id}`, "mood crisis", `${c.name} mood ${Math.round(mood * 100)} percent against a break threshold of ${Math.round(threshold * 100)} percent, joy ${Math.round(joy * 100)} percent. Switching them to a recreation schedule.`, 240000, { askChat: true });
      } else if (this.joyMode.has(c.id) && (mood > threshold + 0.08 || this.turn - this.joyMode.get(c.id) > 45)) {
        this.joyMode.delete(c.id);
        await api.tryPost("/pawn/schedule", { pawn: c.id, preset: "optimal" });
      }
    }
  }

  async nearestBed(c) {
    try {
      const beds = await api.get("/things?cat=Building&player=1&def=Bed");
      const spots = await api.get("/things?cat=Building&player=1&def=SleepingSpot");
      const all = [...(beds.things ?? []), ...(spots.things ?? [])].filter((t) => /^(Bed|SleepingSpot|Bedroll)/.test(t.def ?? ""));
      all.sort((a, b) => dist(a, c) - dist(b, c));
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
      await this.forage(colonists[0]);
      await this.huntSmallGame(colonists, resources, starving);
    }

    // Starvation overrides the normal work plan: food work outranks wood and building until
    // there is a buffer again. Restored as soon as the colony has a few days of food.
    if (starving && !this.foodEmergency) {
      this.foodEmergency = true;
      await this.syncWorkPlan(colonists);
      await this.thought("Food emergency. Hunting, growing and cooking outrank every other job until we have a buffer.");
    } else if (this.foodEmergency && days > 2.5) {
      this.foodEmergency = false;
      await this.syncWorkPlan(colonists);
      await this.thought("Food buffer restored. Back to the normal work plan.");
    }
    // Campfire meals once a campfire exists and there is something to cook.
    if ((raw > 0 || meat > 0) && this.every("food-bill", 25)) {
      const camp = await api.get("/things?def=Campfire&player=1").catch(() => ({}));
      for (const cf of camp.things ?? []) {
        await api.tryPost("/bill", { thing: cf.id, recipe: "CookMealSimple", mode: "target", count: 8 });
      }
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
    if (!this.every("forage", 15)) return;
    if ((await this.pendingDesignations("HarvestPlant")) > 4) return;
    // Let the game decide what is harvestable. Rings are centred on the BASE and capped, so a
    // hungry pawn never walks to the far side of the map chasing berries.
    const c = this.base ?? near;
    for (const r of this.foodEmergency ? [12, 20, 28, 40, 55] : [12, 20, 28]) {
      const res = await api.tryPost("/designate", { type: "harvest", rect: { x: c.x - r, z: c.z - r, w: r * 2, h: r * 2 } });
      if (res && (res.designated ?? 0) > 0) {
        this.stats.orders++;
        await this.thought(`Foraging: ${res.designated} plants designated for harvest within ${r} cells of the base.`);
        return;
      }
    }
  }

  async huntSmallGame(colonists, resources, starving = false) {
    const hunter = colonists.find((c) => c.weapon && !c.downed) ?? (starving ? colonists.find((c) => !c.downed) : null);
    if (!hunter) return;
    const meat = Object.entries(resources).filter(([k]) => k.startsWith("Meat_")).reduce((a, [, v]) => a + v, 0);
    if (meat > 40 && !starving) return;
    if (!this.every("hunt", starving ? 12 : 30)) return;
    // Unarmed colonists only hunt animals they can beat with their fists.
    const allowed = hunter.weapon ? SMALL_GAME : TINY_GAME;
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
  /** Returns "placed" on a fresh placement, "already" if done earlier, false if it could not be placed. */
  async place(key, def, x, z, opts = {}) {
    if (this.placed.has(key)) return "already";
    const attempts = this.failedPlacements.get(key) ?? 0;
    if (attempts > 6) return false;
    const offsets = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [0, 2], [-2, 0], [0, -2]];
    for (const [dx, dz] of offsets.slice(0, opts.exact ? 1 : offsets.length)) {
      try {
        await api.post("/build", { def, x: x + dx, z: z + dz, rot: opts.rot ?? 0, stuff: opts.stuff });
        this.placed.set(key, { def, x: x + dx, z: z + dz });
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

    // Campfire first: warmth, light, cooking. 20 wood.
    if (wood >= 20 && !built.has("Campfire")) {
      if ((await this.place("campfire", "Campfire", b.x - 1, b.z - 1)) === "placed") {
        await this.thought("Campfire blueprint down: warmth, light and simple meals.");
      }
    }

    // Founder's hut: 7x7 wooden walls, door on the south side. ~85 wood.
    if (wood >= 80 && !this.placed.has("hut")) {
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
      if (r) {
        this.placed.set("hut", { def: "Wall", x: b.x, z: b.z });
        this.stats.orders++;
        await this.thought("Founder's hut walls and door placed. 7x7, wood, door facing south.");
        await this.narrate("hut", "shelter started", `Seven by seven wooden hut blueprinted at the base with a south door, using part of the ${wood} wood stockpiled.`, 0, { priority: "high" });
      }
    }

    // Bed, table, chair: the three biggest early mood fixes.
    if (wood >= 45 && !built.has("Bed")) await this.place("bed", "Bed", b.x - 1, b.z + 1, { stuff: "WoodLog", rot: 0 });
    if (wood >= 30 && !built.has("Table1x2c") && !built.has("Table2x2c")) {
      if ((await this.place("table", "Table1x2c", b.x + 1, b.z + 1, { stuff: "WoodLog", rot: 0 })) === "placed") {
        await this.thought("Dining table placed. No more eating on the floor.");
      }
    }
    if (wood >= 25 && !built.has("Stool") && !built.has("DiningChair")) await this.place("stool", "Stool", b.x + 1, b.z, { stuff: "WoodLog" });

    // Recreation.
    if (wood >= 30 && !built.has("HorseshoesPin")) {
      if ((await this.place("horseshoes", "HorseshoesPin", b.x - 6, b.z, { stuff: "WoodLog" })) === "placed") {
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
      if (r) {
        this.placed.set("prison_hut", { def: "Wall", x: px, z: pz });
        await this.place("prison_bed", "Bed", px, pz, { stuff: "WoodLog", rot: 0 });
        await this.thought("Prisoner hut and bed placed for recruitment.");
      }
    }

    // Research bench when the materials exist.
    if (wood >= 100 && steel >= 25 && !built.has("SimpleResearchBench")) {
      if ((await this.place("research", "SimpleResearchBench", b.x + 6, b.z - 2, { stuff: "WoodLog", rot: 0 })) === "placed") {
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
  static WEAPON_RECIPES = [
    { recipe: "Make_Bow_Short", key: "bill-bow", wood: 30, label: "short bow", note: "range beats everything early" },
    { recipe: "Make_MeleeWeapon_Club", key: "bill-club", wood: 40, label: "club", note: "melee backup, and a second weapon for the next colonist" },
  ];

  async manageBills(resources) {
    try {
      const spots = await api.get("/things?def=CraftingSpot&player=1");
      const spot = (spots.things ?? [])[0];
      if (!spot) return;
      const info = await api.get(`/thing/${spot.id}`).catch(() => ({}));
      const bills = JSON.stringify(info.bills ?? []).toLowerCase();
      let wood = resources.WoodLog ?? 0;

      for (const w of ColonyAgent.WEAPON_RECIPES) {
        if (this.placed.has(w.key) || bills.includes(w.label)) continue;
        if (wood < w.wood) continue;
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
    if ((resources.WoodLog ?? 0) >= 30) {
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
    const small = colonists.length < 3;
    const base = {
      Firefighter: 1, Patient: 1, Doctor: 1, PatientBedRest: 1, BasicWorker: 1,
      PlantCutting: 1,
      Growing: lvl("Plants") >= 3 ? 1 : 2,
      Cooking: 2,
      Construction: lvl("Construction") >= 3 ? 2 : 3,
      Crafting: 2,
      Hunting: lvl("Shooting") >= 3 ? 2 : 3,
      Hauling: small ? 3 : 2,
      Mining: small ? 4 : 3,
      Research: lvl("Intellectual") >= 4 ? 3 : 4,
      Tailoring: 3, Smithing: 3,
      Warden: lvl("Social") >= 2 ? 2 : 3,
      Cleaning: colonists.length >= 4 ? 4 : 0,
      Art: 0,
      Handling: colonists.length >= 3 ? 3 : 0,
      Childcare: colonists.length >= 3 ? 3 : 0,
    };

    if (this.foodEmergency) {
      // Nothing matters except calories. Everything that does not produce food is pushed down.
      return { ...base, Hunting: 1, Growing: 1, Cooking: 1, PlantCutting: 2, Hauling: 2,
               Construction: 4, Crafting: 4, Mining: 4, Research: 4, Tailoring: 4, Smithing: 4 };
    }
    if (this.weaponRush) {
      // Make a weapon, but keep gathering: a colony that stops eating to craft still dies.
      return { ...base, Crafting: 1, PlantCutting: 1, Construction: 3, Mining: 4, Research: 4 };
    }
    return base;
  }

  async applyWorkPlan(colonists, reason) {
    for (const p of colonists) {
      let skills = this.skillCache?.get(p.id);
      if (!skills) {
        try { const d = await api.get(`/pawn/${p.id}`); skills = d.skills ?? {}; } catch { skills = {}; }
        (this.skillCache ??= new Map()).set(p.id, skills);
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

  chooseOption(label, choices) {
    const enabled = choices.filter((c) => !c.disabled);
    if (enabled.length === 0) return null;
    const find = (re) => enabled.find((c) => re.test((c.label ?? "").toLowerCase()));
    if (/join|wander|refugee|joins|asks to join|ally|gift/.test(label)) {
      const yes = find(/accept|yes|welcome|allow|ok/);
      if (yes) return yes.index;
    }
    if (/quest/.test(label)) {
      const later = find(/postpone|later|dismiss|close/);
      if (later) return later.index;
    }
    const safe = find(/close|ok|dismiss|postpone|later|acknowledge/);
    if (safe) return safe.index;
    return enabled[0].index;
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
