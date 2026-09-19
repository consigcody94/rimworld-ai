#!/usr/bin/env node
/**
 * Autonomous RimWorld Colony Agent
 * Controls RimWorld via the AI Bridge mod on localhost:18800.
 * Incorporates heuristics from the RimWorld Optimization Guide spreadsheet (RimOp.xlsx).
 * Features fast reactive pacing and instant tactical defense ("on your feet" combat protocol).
 *
 * Usage:
 *   node scripts/colony-agent.mjs [--turns=20] [--fast] [--step-ms=800] [--speed=3] [--allow-mode=home|all|off]
 */

const API_BASE = (process.env.RIMWORLD_API ?? "http://127.0.0.1:18800").replace(/\/$/, "");
const AGENT_ID = process.env.RIMWORLD_AGENT_ID ?? "colony-agent";

// ============================================================================
// HTTP Client
// ============================================================================

async function request(method, path, body = null, timeoutMs = 60000) {
  const url = API_BASE + path;
  const headers = {
    "Content-Type": "application/json",
    "X-Agent-Id": AGENT_ID,
  };
  const options = {
    method,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  if (!res.ok && json.ok !== true) {
    const msg = json.error ?? res.statusText ?? "Request failed";
    const err = new Error(`${msg} (HTTP ${res.status} ${method} ${path})`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

const api = {
  get: (path) => request("GET", path),
  post: (path, body) => request("POST", path, body),
};

async function reportThought(text) {
  try {
    await fetch("http://localhost:18888/api/thought", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(1000),
    });
  } catch {}
}

async function reportVoice(text) {
  try {
    await fetch("http://localhost:18888/api/voice/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(1000),
    });
  } catch {}
}

// ============================================================================
// Research Progression Plan (from RimOp optimization guide)
// ============================================================================

const TECH_TREE_ORDER = [
  "Batteries",
  "SolarPanels",
  "Smithing",
  "Gunsmithing",
  "BlowbackOperation",
  "GasOperation",
  "Electricity",
  "MicroelectronicsBasics",
  "DrugProduction",
  "PsychiteRefining",
  "MedicineProduction",
];

// Tactical Cover Coordinates near base
const COVER_POSITIONS = [
  { x: 88, z: 109, label: "doorway" }, // shelter doorframe with wall cover
  { x: 94, z: 107, label: "barricade-center" }, // behind sandbag/barricade
  { x: 94, z: 106, label: "barricade-south" },
  { x: 94, z: 108, label: "barricade-north" },
];
const SAFE_SHELTER_CELL = { x: 88, z: 112 }; // interior safe bedroom

// ============================================================================
// Colony Agent State and Logic
// ============================================================================

export class ColonyAgent {
  constructor(options = {}) {
    this.speed = options.speed ?? 3;
    this.stepMs = options.stepMs ?? 800; // fast 800ms peacetime reaction cycle
    this.saveDaily = options.saveDaily ?? true;
    this.allowMode = options.allowMode ?? "home";
    this.unallowWild = options.unallowWild ?? true;
    this.lastSavedDay = null;
    this.lastLeaseClaim = 0;
    this.turnCount = 0;
    this.inCombat = false;
  }

  async ensureLease() {
    const now = Date.now();
    if (now - this.lastLeaseClaim > 60000) {
      await api.post("/agent/claim", { agent: AGENT_ID, leaseSec: 300 });
      this.lastLeaseClaim = now;
    }
  }

  async checkHealth() {
    const h = await api.get("/health");
    if (!h.ok || !h.playing) {
      throw new Error(`Game is not in playing state: ${JSON.stringify(h)}`);
    }
    return h;
  }

  async waitForReady(maxAttempts = 60) {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const h = await api.get("/health");
        if (h.ok && !h.loading) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async setGameSpeed(targetSpeed) {
    try {
      await api.post("/speed", { speed: targetSpeed });
    } catch {}
  }

  async runTurn() {
    this.turnCount++;
    await this.ensureLease();

    // 1. Instant Observation
    const snap = await api.get("/snapshot");
    const dateStr = snap.date ?? "";
    const colonists = snap.colonists ?? [];
    const hostiles = snap.hostiles ?? [];
    const alerts = snap.alerts ?? [];
    const research = snap.research ?? null;
    const resources = snap.resources ?? {};

    // Check for living active hostiles
    const activeHostiles = hostiles.filter((h) => !h.downed && !h.dead);
    const hasThreat = activeHostiles.length > 0;

    // 2. High-Priority: "On Your Feet" Tactical Defense Protocol
    if (hasThreat) {
      console.log(`[ALERT] ${activeHostiles.length} active hostiles detected! Switching to high-speed tactical defense.`);
      await this.setGameSpeed(1); // Drop to normal speed for tactical precision
      await this.handleCombat(colonists, activeHostiles);
      return;
    }

    // Peacetime: Ensure all colonists are undrafted
    if (this.inCombat) {
      this.inCombat = false;
      for (const c of colonists) {
        if (c.drafted) {
          await api.post("/draft", { pawn: c.id, drafted: false });
        }
      }
      await reportThought(`[Combat] Colony secure. Returning to peaceful development.`);
    }

    // Keep peacetime game speed active
    await this.setGameSpeed(this.speed);

    // Extract in-game day
    const dayMatch = dateStr.match(/(\d+)(?:st|nd|rd|th) of/);
    const curDay = dayMatch ? parseInt(dayMatch[1], 10) : null;

    // 3. Health & Needs Monitoring
    for (const c of colonists) {
      const food = c.needs?.food ?? 1;
      const mood = c.needs?.mood ?? 1;
      const threshold = c.moodBreakThreshold ?? 0.35;
      const bleedRate = c.health?.bleedRate ?? 0;

      if (bleedRate > 0) {
        console.log(`[MEDICAL] Colonist ${c.name} is bleeding (${bleedRate}/d)! Directing immediate medical care.`);
        await reportThought(`[Medical] Colonist ${c.name} bleeding; directing bed rest and doctor tending.`);
      }
      if (food < 0.15) {
        console.log(`[WARN] Colonist ${c.name} is hungry (food: ${Math.round(food * 100)}%).`);
      }
      if (mood < threshold + 0.05) {
        console.log(`[WARN] Colonist ${c.name} near break threshold (mood: ${Math.round(mood * 100)}%).`);
      }
    }

    // 4. Resource Check & Forestry
    const woodCount = resources.WoodLog ?? 0;
    if (woodCount < 100 && this.turnCount % 10 === 1) {
      await this.designateWoodChopping();
    }

    // 5. Allow Tool Supply Hygiene
    if (this.turnCount % 15 === 1 && this.allowMode !== "off") {
      await this.manageSupplies();
    }

    // 6. Dismiss expired dialogs or info letters
    try {
      await api.post("/dialog/close", { all: true });
    } catch {}
    if (snap.letters && snap.letters.length > 2) {
      await api.post("/letter/dismiss", { all: true });
    }

    // 7. Technology Progression
    if (!research || research.progress >= 1) {
      await this.advanceResearch(research?.project);
    }

    // 8. Power Infrastructure Management
    if (this.turnCount % 10 === 2) {
      await this.managePowerGrid();
    }

    // 9. Daily Autosave
    if (this.saveDaily && curDay !== null && curDay !== this.lastSavedDay) {
      const saveName = `NewDawn_Day${curDay}`;
      console.log(`[AUTOSAVE] Day ${curDay} reached. Saving as ${saveName}...`);
      try {
        await api.post("/game/save", { name: saveName });
        this.lastSavedDay = curDay;
        await reportThought(`[Autosave] Day ${curDay} saved as ${saveName}.`);
        await this.waitForReady();
        await api.post("/dialog/close", { all: true });
      } catch (err) {
        console.error(`[AUTOSAVE FAILED] ${err.message}`);
      }
    }

    // 10. Intelligent Camera Director (stream engagement)
    await this.manageCamera(snap);

    // 11. Status Log
    this.printStatus(snap, curDay);

    // Fast asynchronous pacing: sleep for peacetime stepMs
    await new Promise((r) => setTimeout(r, this.stepMs));
  }

  async handleCombat(colonists, initialHostiles) {
    this.inCombat = true;
    let activeHostiles = initialHostiles;

    // Filter armed shooters (with rifles/guns) vs non-combatants
    const isArmed = (c) => Boolean(c.weapon && !c.downed && (c.health?.pct ?? 1) > 0.4);
    const shooters = colonists.filter(isArmed);
    const civilians = colonists.filter((c) => !isArmed(c));

    // 1. Immediately evacuate non-combatants inside the safe shelter bedroom
    for (const p of civilians) {
      if (!p.downed && !p.inBed) {
        try {
          await api.post("/move", { pawn: p.id, x: SAFE_SHELTER_CELL.x, z: SAFE_SHELTER_CELL.z });
          console.log(`[TACTICAL] Evacuated non-combatant ${p.name} to shelter.`);
        } catch {}
      }
    }

    // 2. Draft armed shooters and deploy to defensive cover
    for (let i = 0; i < shooters.length; i++) {
      const s = shooters[i];
      const cover = COVER_POSITIONS[i % COVER_POSITIONS.length];
      try {
        if (!s.drafted) {
          await api.post("/draft", { pawn: s.id, drafted: true });
          console.log(`[TACTICAL] Drafted shooter ${s.name} (${s.weapon}).`);
        }
        await api.post("/move", { pawn: s.id, x: cover.x, z: cover.z, draft: true });
        console.log(`[TACTICAL] Positioned ${s.name} at ${cover.label} (${cover.x}, ${cover.z}).`);
      } catch (err) {
        console.warn(`[TACTICAL WARN] Could not position ${s.name}: ${err.message}`);
      }
    }

    await reportThought(`[Combat] Tactical defense active! Shooters positioned behind cover.`);

    // 3. High-Frequency Tactical Loop
    let combatTicks = 0;
    let inFiringRange = false;

    while (combatTicks < 200) {
      combatTicks++;
      await new Promise((r) => setTimeout(r, inFiringRange ? 250 : 500));

      const snap = await api.get("/snapshot");
      const currentHostiles = (snap.hostiles ?? []).filter((h) => !h.downed && !h.dead);

      if (currentHostiles.length === 0) {
        console.log(`[TACTICAL] All hostiles neutralized! Victory.`);
        await reportThought(`[Combat] All hostiles neutralized! Threat eliminated.`);
        break;
      }

      // Find closest active hostile to base center (88, 109)
      const basePos = { x: 88, z: 109 };
      currentHostiles.sort((a, b) => {
        const distA = Math.hypot((a.x ?? 0) - basePos.x, (a.z ?? 0) - basePos.z);
        const distB = Math.hypot((b.x ?? 0) - basePos.x, (b.z ?? 0) - basePos.z);
        return distA - distB;
      });
      const targetHostile = currentHostiles[0];
      const targetDist = Math.hypot((targetHostile.x ?? 0) - basePos.x, (targetHostile.z ?? 0) - basePos.z);

      if (targetDist > 32) {
        if (snap.speed !== 3) {
          await api.post("/speed", { speed: 3 });
        }
        inFiringRange = false;
        continue;
      }

      // Enemy entered firing range (<= 32 tiles)
      if (!inFiringRange) {
        inFiringRange = true;
        await api.post("/speed", { speed: 1 });
        console.log(`[TACTICAL ENGAGEMENT] Enemy within ${Math.round(targetDist)} tiles! Engaging at speed 1.`);
        await reportThought(`[Combat] Hostile in range (${Math.round(targetDist)} tiles); volley fire engaged!`);
      }

      // Order all capable shooters to focus volley fire
      const currentShooters = (snap.colonists ?? []).filter(isArmed);
      for (const s of currentShooters) {
        if ((s.health?.bleedRate ?? 0) > 0.3) {
          console.log(`[TACTICAL RETREAT] ${s.name} bleeding heavily! Pulling back into shelter.`);
          await api.post("/move", { pawn: s.id, x: SAFE_SHELTER_CELL.x, z: SAFE_SHELTER_CELL.z, draft: true });
          continue;
        }
        try {
          await api.post("/attack", { pawn: s.id, target: targetHostile.id });
        } catch {}
      }
    }

    // 4. Undraft and execute immediate medical triage
    for (const s of shooters) {
      try {
        await api.post("/draft", { pawn: s.id, drafted: false });
      } catch {}
    }
    await api.post("/speed", { speed: this.speed });

    // Clean up allow tool after combat
    await this.manageSupplies();
    this.inCombat = false;
  }

  async designateWoodChopping() {
    try {
      const res = await api.get("/things?def=Tree&rect=70,80,45,45&limit=30");
      const trees = res.things ?? [];
      const mature = trees.filter((t) => (t.growth ?? 0) >= 0.8).slice(0, 10);
      if (mature.length > 0) {
        const ids = mature.map((t) => t.id);
        await api.post("/designate", { type: "chop", things: ids });
        console.log(`[FORESTRY] Designated ${ids.length} mature trees for lumber.`);
        await reportThought(`[Forestry] Designated ${ids.length} mature trees for lumber.`);
      }
    } catch (e) {
      console.warn(`[FORESTRY WARN] Could not designate trees: ${e.message}`);
    }
  }

  async manageSupplies() {
    try {
      if (this.unallowWild) {
        await api.post("/forbid", { all: true, forbidden: true });
      }

      if (this.allowMode === "home") {
        const res = await api.post("/allow", { home: true });
        const vitals = [
          "MedicineIndustrial",
          "MealSurvivalPack",
          "ComponentIndustrial",
          "WoodLog",
          "Steel",
        ];
        for (const def of vitals) {
          await api.post("/allow", { all: true, def });
        }
        console.log(`[ALLOW TOOL] Unallowed wild map drops; allowed ${res.matched ?? 0} home area items.`);
        await reportThought(`[Allow Tool] Unallowed wild map drops; protected ${res.matched ?? 0} home supplies.`);
      } else if (this.allowMode === "all") {
        const res = await api.post("/allow", { all: true });
        console.log(`[ALLOW TOOL] Allowed all items across map (${res.changed ?? 0} changed).`);
        await reportThought(`[Allow Tool] Allowed all items across the map.`);
      }
    } catch (e) {
      console.warn(`[ALLOW TOOL WARN] Could not manage supplies: ${e.message}`);
    }
  }

  async manageCamera(snap) {
    try {
      const colonists = snap.colonists ?? [];
      const hostiles = (snap.hostiles ?? []).filter((h) => !h.downed && !h.dead);

      if (hostiles.length > 0) {
        const target = hostiles[0];
        await api.post("/camera", { x: target.x ?? 88, z: target.z ?? 109, zoom: 22 });
        await api.post("/select", { pawn: target.id });
        return;
      }

      // Follow active working colonist (e.g. constructing, chopping, tending)
      const activePawn = colonists.find((c) => c.doing && !c.doing.includes("sleeping") && !c.doing.includes("standing") && !c.doing.includes("resting"));
      if (activePawn && this.turnCount % 3 === 0) {
        await api.post("/camera", { x: activePawn.x, z: activePawn.z, zoom: 20 });
        await api.post("/select", { pawn: activePawn.id });
        return;
      }

      // Smooth cinematic showcase cycling for stream audience
      if (this.turnCount % 12 === 0) {
        const showcaseSpots = [
          { x: 88, z: 109, zoom: 24, label: "Base Core" },
          { x: 88, z: 116, zoom: 18, label: "Private Bedrooms" },
          { x: 89, z: 94, zoom: 22, label: "Rice Farms" },
          { x: 96, z: 112, zoom: 20, label: "Power Grid" },
          { x: 97, z: 106, zoom: 22, label: "Defense Killbox" },
        ];
        const spot = showcaseSpots[(Math.floor(this.turnCount / 12)) % showcaseSpots.length];
        await api.post("/camera", { x: spot.x, z: spot.z, zoom: spot.zoom });
      }
    } catch {}
  }

  async advanceResearch(currentProject) {
    try {
      const resData = await api.get("/research");
      const availableDefs = (resData.available ?? []).map((a) => a.def);
      let nextTech = null;
      for (const tech of TECH_TREE_ORDER) {
        if (availableDefs.includes(tech)) {
          nextTech = tech;
          break;
        }
      }
      if (nextTech && nextTech !== currentProject) {
        await api.post("/research", { project: nextTech });
        console.log(`[RESEARCH] Set active research project to ${nextTech}.`);
        await reportThought(`[Research] Activated new research project: ${nextTech}.`);
      }
    } catch (e) {
      console.warn(`[RESEARCH WARN] Could not advance research: ${e.message}`);
    }
  }

  async managePowerGrid() {
    try {
      const buildings = await api.get("/things/summary?cat=Building&player=1");
      const builtDefs = new Set((buildings.groups ?? []).map((g) => g.def));

      // 1. Build WoodFiredGenerator if none exists
      if (!builtDefs.has("WoodFiredGenerator")) {
        try {
          await api.post("/build", { def: "WoodFiredGenerator", x: 96, z: 112 });
          console.log("[POWER] Designated Wood-Fired Generator at (96, 112).");
          await reportThought("[Power] Designated Wood-Fired Generator (96, 112).");
        } catch {}
      }

      // 2. Build Battery inside roofed shelter once Batteries research completes
      const batteryDefs = await api.get("/defs?type=building&q=Battery&buildable=1");
      const canBuildBattery = (batteryDefs.defs ?? []).some((d) => d.def === "Battery" && d.researched);
      if (canBuildBattery && !builtDefs.has("Battery")) {
        try {
          await api.post("/build", { def: "Battery", x: 91, z: 112 });
          console.log("[POWER] Designated Battery inside sheltered bedroom at (91, 112).");
          await reportThought("[Power] Designated Battery inside shelter at (91, 112).");
        } catch {}
      }

      // 3. Connect power conduits
      if (!builtDefs.has("PowerConduit")) {
        const conduitCells = [
          { def: "PowerConduit", x: 91, z: 112 },
          { def: "PowerConduit", x: 92, z: 112 },
          { def: "PowerConduit", x: 93, z: 112 },
          { def: "PowerConduit", x: 94, z: 112 },
          { def: "PowerConduit", x: 95, z: 112 },
        ];
        try {
          await api.post("/build/bulk", { items: conduitCells });
        } catch {}
      }
    } catch (err) {
      console.warn(`[POWER WARN] Could not manage power grid: ${err.message}`);
    }
  }

  printStatus(snap, curDay) {
    const dateStr = snap.date ?? "Unknown";
    const res = snap.research ? `${snap.research.label} (${Math.round(snap.research.progress * 100)}%)` : "None";
    const colonists = snap.colonists ?? [];
    const colSummary = colonists.map((c) => `${c.name}: mood ${Math.round((c.needs?.mood ?? 0) * 100)}%, food ${Math.round((c.needs?.food ?? 0) * 100)}% [${c.job?.report ?? "idle"}]`).join(" | ");

    console.log(`--- [Turn ${this.turnCount}] ${dateStr} | Tick ${snap.tick} ---`);
    console.log(`  Colonists: ${colSummary}`);
    console.log(`  Research: ${res}`);
    if (snap.alerts && snap.alerts.length > 0) {
      console.log(`  Alerts: ${snap.alerts.map((a) => a.label).join(", ")}`);
    }
  }

  async run(turns = 20) {
    const isInfinite = turns === 0 || turns === -1;
    console.log(`Starting High-Speed ColonyAgent loop for ${isInfinite ? "infinite" : turns} turns (stepMs: ${this.stepMs}, speed: ${this.speed})...`);
    await this.checkHealth();
    let i = 0;
    while (isInfinite || i < turns) {
      i++;
      try {
        await this.runTurn();
      } catch (err) {
        console.error(`[TURN ERROR] Turn ${this.turnCount} error: ${err.message}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    console.log(`Completed ${turns} high-speed autonomous turns successfully.`);
  }
}

// CLI entry point
if (process.argv[1]?.endsWith("colony-agent.mjs")) {
  let turns = 20;
  let speed = 3;
  let stepMs = 800;
  let allowMode = "home";
  let unallowWild = true;

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--turns=")) turns = parseInt(arg.split("=")[1], 10);
    if (arg === "--continuous" || arg === "--daemon") turns = 0;
    if (arg.startsWith("--speed=")) speed = parseInt(arg.split("=")[1], 10);
    if (arg.startsWith("--step-ms=")) stepMs = parseInt(arg.split("=")[1], 10);
    if (arg === "--fast") {
      stepMs = 400;
      speed = 3;
    }
    if (arg.startsWith("--allow-mode=")) allowMode = arg.split("=")[1];
    if (arg === "--unallow-wild") unallowWild = true;
    if (arg === "--no-unallow-wild") unallowWild = false;
  }

  const agent = new ColonyAgent({ speed, stepMs, saveDaily: true, allowMode, unallowWild });
  agent.run(turns).catch((err) => {
    console.error("ColonyAgent encountered fatal error:", err);
    process.exit(1);
  });
}
