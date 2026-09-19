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
const SMALL_GAME = ["squirrel", "hare", "rat", "chinchilla", "turkey", "chicken", "duck", "guinea pig", "raccoon", "capybara", "muffalo calf"];
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
    this.joyMode = new Set();      // pawn ids temporarily on the joy schedule
    this.seenLetters = new Set();
    this.inCombat = false;
    this.lastAttackOrder = new Map(); // pawn id -> turn
    this.lastDay = null;
    this.lastSavedDay = null;
    this.lastVoiceAt = new Map();  // topic -> ms
    this.lastRoutine = new Map();  // routine -> turn
    this.followTarget = null;
    this.followSince = 0;
    this.stats = { turns: 0, combatTurns: 0, orders: 0, errors: 0 };
  }

  // ---------------------------------------------------------------- logging

  log(msg) { if (!this.quiet) console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }

  async thought(text) {
    this.log(`THOUGHT ${text}`);
    await studio("/api/thought", { text });
  }

  /** Voice line with a per-topic cooldown so the commentary never spams. */
  async say(topic, text, cooldownMs = 90000, priority = "normal") {
    const last = this.lastVoiceAt.get(topic) ?? 0;
    if (Date.now() - last < cooldownMs) return;
    this.lastVoiceAt.set(topic, Date.now());
    await studio("/api/voice/speak", { text, priority, force: priority === "high" });
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

    // 3. Food security.
    if (this.every("food", 6)) await this.manageFood(colonists, snap, resources);

    // 4. Materials.
    if (this.every("wood", 10)) await this.manageWood(resources);
    if (this.every("steel", 40)) await this.manageSteel(resources);

    // 5. Shelter, furniture, workbenches.
    if (this.every("build", 8)) await this.manageBase(colonists, resources);

    // 6. Production bills.
    if (this.every("bills", 25)) await this.manageBills(resources);

    // 7. Research.
    if (this.every("research", 20)) await this.manageResearch(snap.research);

    // 8. Trade.
    if (this.every("trade", 20)) await this.manageTrade();

    // 9. Work priorities for new arrivals, supply hygiene.
    if (this.every("work", 30)) await this.manageWork(colonists);
    if (this.every("supplies", 40)) await this.manageSupplies(resources);

    // 10. Daily save and day commentary.
    if (day !== this.lastDay) await this.onNewDay(day, snap, colonists);

    // 11. Camera and status.
    await this.manageCamera(colonists, false);
    if (this.every("status", 5)) this.printStatus(snap, day, colonists);
    return false;
  }

  // ---------------------------------------------------------------- founding

  async foundColony(snap, colonists) {
    const founder = colonists[0];
    this.base = { x: founder.x, z: founder.z };
    this.log(`Founding colony at (${this.base.x}, ${this.base.z}) with ${colonists.map((c) => c.name).join(", ")}.`);
    await this.thought(`Founded ${snap.colonyName ?? "the colony"} at (${this.base.x}, ${this.base.z}). Founder: ${founder.name}.`);
    await this.say("founding", `Colony anchored. ${founder.name} starts with nothing but two hands and this map. First job: berries, wood, a roof.`, 0, "high");

    const b = this.base;
    // Clear the build footprint of trees first so blueprints can land.
    await api.tryPost("/designate", { type: "chop", rect: { x: b.x - 4, z: b.z - 4, w: 9, h: 9 } });
    // Home area around the base so items on the ground count and get hauled.
    await api.tryPost("/area/home", { rect: { x: b.x - 14, z: b.z - 14, w: 29, h: 29 }, add: true });
    await api.tryPost("/allow", { home: true });
    // Stockpile and dumping zones east of the hut.
    if (!this.zones.has("stockpile")) {
      const z = await api.tryPost("/zone", { type: "stockpile", rect: { x: b.x + 5, z: b.z - 5, w: 6, h: 5 }, priority: "Preferred", label: "Main stockpile" });
      if (z) this.zones.add("stockpile");
    }
    if (!this.zones.has("dumping")) {
      const z = await api.tryPost("/zone", { type: "dumping", rect: { x: b.x + 12, z: b.z - 5, w: 4, h: 4 }, label: "Chunks" });
      if (z) this.zones.add("dumping");
    }
    // Free structures the founder can use immediately.
    await this.place("sleepingspot", "SleepingSpot", b.x + 1, b.z - 1);
    await this.place("craftingspot", "CraftingSpot", b.x + 6, b.z + 2);
    await this.manageWork(colonists);
    await this.manageFood(colonists, snap, snap.resources ?? {});
    await this.manageWood(snap.resources ?? {});
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

  async combatTurn(colonists, threats, snap) {
    this.stats.combatTurns++;
    if (!this.inCombat) {
      this.inCombat = true;
      const names = [...new Set(threats.map((t) => t.kind ?? t.name))].join(", ");
      this.log(`COMBAT ${threats.length} threat(s): ${names}`);
      await this.thought(`Threat: ${names}. Drafting and engaging.`);
      await this.say("combat", `Hostile ${names} on the map. Drafting up, we fight from cover.`, 30000, "high");
    }
    if (snap.speed !== 1 || snap.paused) await api.tryPost("/speed", { speed: 1 });

    const able = colonists.filter((c) => !c.downed && (c.health?.pct ?? 1) > 0.25);
    for (const c of able) {
      const target = threats.slice().sort((a, b2) => dist(a, c) - dist(b2, c))[0];
      if (!target) continue;
      const attacking = (c.job?.def ?? "").toLowerCase().includes("attack");
      const last = this.lastAttackOrder.get(c.id) ?? -99;
      if (!attacking || this.turn - last > 12) {
        await api.tryPost("/attack", { pawn: c.id, target: target.id, draft: true });
        this.lastAttackOrder.set(c.id, this.turn);
        this.stats.orders++;
      }
    }
    // Badly hurt colonists with others still fighting pull back to the hut.
    for (const c of colonists) {
      if (c.downed || (c.health?.pct ?? 1) > 0.25 || able.length <= 1) continue;
      await api.tryPost("/move", { pawn: c.id, x: this.base.x, z: this.base.z, draft: true });
    }
    await this.manageCamera(colonists, true);
  }

  async endCombat(colonists) {
    this.inCombat = false;
    for (const c of colonists) {
      if (c.drafted) await api.tryPost("/draft", { pawn: c.id, drafted: false });
      await api.tryPost("/pawn/settings", { pawn: c.id, hostility: "Attack", selfTend: true });
    }
    await api.tryPost("/speed", { speed: this.speed });
    await this.thought("Threat cleared. Back to work; wounds get tended first.");
    await this.say("combat-end", "Threat cleared. Patching up, then back to the build.", 30000);
  }

  // ---------------------------------------------------------------- needs

  async manageNeeds(colonists, snap, resources) {
    for (const c of colonists) {
      const n = c.needs ?? {};
      const food = n.food ?? 1, rest = n.rest ?? 1, mood = n.mood ?? 1, joy = n.joy ?? 1;
      const threshold = c.moodBreakThreshold ?? 0.35;
      const h = c.health ?? {};

      if (!this.configured.has(c.id)) {
        await api.tryPost("/pawn/settings", { pawn: c.id, selfTend: true, medicalCare: "Best", hostility: "Attack" });
        await api.tryPost("/pawn/schedule", { pawn: c.id, preset: "optimal" });
        this.configured.add(c.id);
      }

      // Bleeding or untended wounds: get into a bed so self tend happens now.
      if ((h.bleedRate ?? 0) > 0.15 || (h.needsTending && !c.inBed && (h.pct ?? 1) < 0.85)) {
        if (!c.inBed && !c.drafted) {
          const bed = await this.nearestBed(c);
          if (bed) { await api.tryPost("/job", { pawn: c.id, job: "LayDown", targetA: bed.id }); this.stats.orders++; }
          await this.thought(`${c.name} is hurt (${Math.round((h.pct ?? 1) * 100)}% health); resting and self tending.`);
          await this.say(`hurt-${c.id}`, `${c.name} is hurt. Bed rest and self tending before anything else.`, 120000);
        }
      }

      // Exhaustion outside the sleep window.
      if (rest < 0.12 && !c.asleep && !c.inBed && !c.drafted) {
        const bed = await this.nearestBed(c);
        if (bed) { await api.tryPost("/job", { pawn: c.id, job: "LayDown", targetA: bed.id }); this.stats.orders++; }
      }

      // Mood management: give joy time before a break, restore the work schedule once recovered.
      if (mood < threshold + 0.06 && !this.joyMode.has(c.id)) {
        this.joyMode.add(c.id);
        await api.tryPost("/pawn/schedule", { pawn: c.id, preset: "joy" });
        await this.thought(`${c.name} mood ${Math.round(mood * 100)}% near break threshold ${Math.round(threshold * 100)}%. Recreation time.`);
        await this.say(`mood-${c.id}`, `${c.name} is close to breaking. Giving them the day off before we lose them.`, 180000);
      } else if (this.joyMode.has(c.id) && mood > threshold + 0.2 && joy > 0.5) {
        this.joyMode.delete(c.id);
        await api.tryPost("/pawn/schedule", { pawn: c.id, preset: "optimal" });
      }

      // Hunger with nothing stocked: forage right now.
      if (food < 0.3 && (snap.foodNutrition ?? 0) < 2) {
        await this.forage(c, 6);
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
    const perColonistDays = colonists.length > 0 ? nutrition / (colonists.length * 1.6) : 99;
    if (perColonistDays < 2.5) {
      await this.forage(colonists[0], 10);
      await this.huntSmallGame(colonists, resources);
    }
    // Campfire meals once a campfire exists and there is raw food.
    if (this.every("food-bill", 30)) {
      const camp = await api.get("/things?def=Campfire&player=1").catch(() => ({}));
      for (const cf of camp.things ?? []) {
        await api.tryPost("/bill", { thing: cf.id, recipe: "CookMealSimple", mode: "target", count: 6 });
      }
    }
  }

  async forage(near, count) {
    if (!this.every("forage", 12)) return;
    try {
      const res = await api.get("/things?def=Plant_Berry&limit=200");
      const bushes = (res.things ?? []).filter((b) => b.harvestable !== false && (b.growth ?? 1) > 0.7);
      bushes.sort((a, b) => dist(a, near) - dist(b, near));
      const ids = bushes.slice(0, count).map((b) => b.id);
      if (ids.length > 0) {
        await api.tryPost("/designate", { type: "harvest", things: ids });
        this.stats.orders++;
        await this.thought(`Harvesting ${ids.length} berry bushes near ${near.name}.`);
      }
    } catch {}
  }

  async huntSmallGame(colonists, resources) {
    const hunter = colonists.find((c) => c.weapon && !c.downed);
    if (!hunter) return;
    if ((resources.Meat_Hare ?? 0) + (resources.Meat_Squirrel ?? 0) > 30) return;
    try {
      const res = await api.get("/pawns?role=wild_animal");
      const prey = (res.pawns ?? []).filter((a) => {
        const kind = (a.kind ?? "").toLowerCase();
        return SMALL_GAME.some((s) => kind.includes(s)) && !DANGEROUS_GAME.some((d) => kind.includes(d)) && dist(a, hunter) < 45;
      });
      prey.sort((a, b) => dist(a, hunter) - dist(b, hunter));
      const ids = prey.slice(0, 2).map((p) => p.id);
      if (ids.length > 0) {
        await api.tryPost("/designate", { type: "hunt", things: ids });
        this.stats.orders++;
        await this.thought(`${hunter.name} hunting ${prey.slice(0, 2).map((p) => p.kind).join(" and ")} with the ${hunter.weapon}.`);
        await this.say("hunt", `Bow is ready. ${hunter.name} goes hunting small game for meat and leather.`, 240000);
      }
    } catch {}
  }

  // ---------------------------------------------------------------- materials

  async manageWood(resources) {
    const wood = resources.WoodLog ?? 0;
    if (wood >= 200) return;
    try {
      const b = this.base;
      const res = await api.get(`/things?cat=Plant&rect=${b.x - 30},${b.z - 30},61,61&limit=300`);
      const trees = (res.things ?? []).filter((t) => t.tree && (t.growth ?? 1) > 0.6);
      trees.sort((a, b2) => dist(a, b) - dist(b2, b));
      const ids = trees.slice(0, wood < 60 ? 10 : 6).map((t) => t.id);
      if (ids.length > 0) {
        await api.tryPost("/designate", { type: "chop", things: ids });
        this.stats.orders++;
        this.log(`Designated ${ids.length} trees (wood ${wood}).`);
      }
    } catch {}
  }

  async manageSteel(resources) {
    if ((resources.Steel ?? 0) >= 60) return;
    try {
      const b = this.base;
      const res = await api.get(`/things?def=MineableSteel&rect=${b.x - 45},${b.z - 45},91,91&limit=100`);
      const ore = (res.things ?? []).sort((a, b2) => dist(a, b) - dist(b2, b)).slice(0, 4).map((t) => t.id);
      if (ore.length > 0) {
        await api.tryPost("/designate", { type: "mine", things: ore });
        this.stats.orders++;
        await this.thought(`Mining ${ore.length} compacted steel deposits for the research bench.`);
      }
      const loose = await api.get(`/things?def=Steel&rect=${b.x - 45},${b.z - 45},91,91&limit=50`);
      const ids = (loose.things ?? []).map((t) => t.id);
      if (ids.length > 0) await api.tryPost("/allow", { things: ids });
    } catch {}
  }

  // ---------------------------------------------------------------- base

  /** Place a blueprint once. Retries nearby cells if the spot is blocked. */
  async place(key, def, x, z, opts = {}) {
    if (this.placed.has(key)) return true;
    const attempts = this.failedPlacements.get(key) ?? 0;
    if (attempts > 6) return false;
    const offsets = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [0, 2], [-2, 0], [0, -2]];
    for (const [dx, dz] of offsets.slice(0, opts.exact ? 1 : offsets.length)) {
      try {
        await api.post("/build", { def, x: x + dx, z: z + dz, rot: opts.rot ?? 0, stuff: opts.stuff });
        this.placed.set(key, { def, x: x + dx, z: z + dz });
        this.stats.orders++;
        this.log(`Placed ${def} at (${x + dx}, ${z + dz}).`);
        return true;
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
      if (await this.place("campfire", "Campfire", b.x - 1, b.z - 1)) {
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
        await this.say("hut", "Walls are going up. A roof over the founder's head before the first cold night.", 0, "high");
      }
    }

    // Bed, table, chair: the three biggest early mood fixes.
    if (wood >= 45 && !built.has("Bed")) await this.place("bed", "Bed", b.x - 1, b.z + 1, { stuff: "WoodLog", rot: 0 });
    if (wood >= 30 && !built.has("Table1x2c") && !built.has("Table2x2c")) {
      if (await this.place("table", "Table1x2c", b.x + 1, b.z + 1, { stuff: "WoodLog", rot: 0 })) {
        await this.thought("Dining table placed. No more eating on the floor.");
      }
    }
    if (wood >= 25 && !built.has("Stool") && !built.has("DiningChair")) await this.place("stool", "Stool", b.x + 1, b.z, { stuff: "WoodLog" });

    // Recreation.
    if (wood >= 30 && !built.has("HorseshoesPin")) {
      if (await this.place("horseshoes", "HorseshoesPin", b.x - 6, b.z, { stuff: "WoodLog" })) {
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

    // Research bench when the materials exist.
    if (wood >= 100 && steel >= 25 && !built.has("SimpleResearchBench")) {
      if (await this.place("research", "SimpleResearchBench", b.x + 6, b.z - 2, { stuff: "WoodLog", rot: 0 })) {
        await this.thought("Research bench placed. The climb out of the stone age starts here.");
        await this.say("bench", "Research bench going down. Time to start climbing the tech tree the honest way.", 0, "high");
      }
    }
  }

  async manageBills(resources) {
    try {
      const spots = await api.get("/things?def=CraftingSpot&player=1");
      const spot = (spots.things ?? [])[0];
      if (!spot) return;
      const info = await api.get(`/thing/${spot.id}`).catch(() => ({}));
      const existing = JSON.stringify(info.bills ?? info);
      if ((resources.WoodLog ?? 0) >= 40 && !existing.includes("Bow_Short") && !this.placed.has("bill-bow")) {
        const r = await api.tryPost("/bill", { thing: spot.id, recipe: "Make_Bow_Short", mode: "count", count: 1 });
        if (r) { this.placed.set("bill-bow", {}); await this.thought("Crafting a short bow: hunting and defence."); }
      }
      const leather = Object.entries(resources).filter(([k]) => k.startsWith("Leather_")).reduce((a, [, v]) => a + v, 0);
      if (leather >= 60 && !existing.includes("TribalA") && !this.placed.has("bill-tribalwear")) {
        const r = await api.tryPost("/bill", { thing: spot.id, recipe: "Make_Apparel_TribalA", mode: "count", count: 1 });
        if (r) { this.placed.set("bill-tribalwear", {}); await this.thought("Tribalwear on the crafting spot. Clothes at last."); }
      }
    } catch {}
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
        await this.say("research", `New research target: ${next.replace(/([a-z])([A-Z])/g, "$1 $2")}.`, 120000);
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
        await this.say("trade", `Trade done with ${t.name}. Surplus out, components and medicine in.`, 60000);
      }
    } catch {}
  }

  async manageWork(colonists) {
    for (const p of colonists) {
      if (this.configured.has(`work-${p.id}`)) continue;
      let skills = {};
      try { const d = await api.get(`/pawn/${p.id}`); skills = d.skills ?? {}; } catch {}
      const lvl = (k) => { const v = skills[k]; return typeof v === "number" ? v : parseInt(String(v ?? "0"), 10) || 0; };
      const priorities = {
        Firefighter: 1, Patient: 1, Doctor: 1, PatientBedRest: 1, BasicWorker: 1,
        Growing: lvl("Plants") >= 3 ? 1 : 2,
        PlantCutting: 1,
        Construction: lvl("Construction") >= 3 ? 1 : 2,
        Hunting: lvl("Shooting") >= 3 ? 2 : 3,
        Cooking: 2,
        Hauling: 2,
        Crafting: 2,
        Mining: 3,
        Research: lvl("Intellectual") >= 4 ? 2 : 3,
        Tailoring: 3,
        Smithing: 3,
        Cleaning: colonists.length >= 4 ? 4 : 0,
        Art: 0, Handling: 0, Warden: 0, Childcare: colonists.length >= 3 ? 3 : 0,
      };
      await api.tryPost("/work/bulk", { pawn: p.id, priorities });
      this.configured.add(`work-${p.id}`);
      this.log(`Work priorities set for ${p.name}.`);
    }
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
          if (/join|wander|refugee|joins/.test(label)) await this.say("join", `${l.label}. Welcome to the colony. A second pair of hands changes everything.`, 0, "high");
          continue;
        }
      }
      if (/raid|manhunter|mad |infestation|mech|siege|drop pod/.test(label) || /Threat/.test(type)) {
        await this.thought(`Alert: ${l.label}.`);
        await this.say("alert", `${l.label}. Everyone stay sharp.`, 20000, "high");
      } else if (/dead|died|death|killed/.test(label)) {
        await this.thought(`Loss: ${l.label}.`);
        await this.say("death", `${l.label}. We carry on.`, 0, "high");
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
    const first = this.lastDay === null;
    this.lastDay = day;
    if (first) return;
    const summary = colonists.map((c) => `${c.name} mood ${Math.round((c.needs?.mood ?? 0) * 100)}%`).join(", ");
    await this.thought(`Day ${day}. ${summary}. Wood ${snap.resources?.WoodLog ?? 0}, food nutrition ${snap.foodNutrition ?? 0}.`);
    if (day % 3 === 0) await this.say("day", `Day ${day} in the books. ${colonists.length} colonist${colonists.length === 1 ? "" : "s"}, ${snap.resources?.WoodLog ?? 0} wood, research ${snap.research?.label ?? "not started"}.`, 0);
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
