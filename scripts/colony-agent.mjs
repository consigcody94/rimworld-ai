#!/usr/bin/env node
/**
 * Autonomous RimWorld Colony Agent
 * Controls RimWorld via the AI Bridge mod on localhost:18800.
 * Incorporates heuristics from the RimWorld Optimization Guide spreadsheet (RimOp.xlsx).
 *
 * Usage:
 *   node scripts/colony-agent.mjs [--turns=10] [--step-ms=2500] [--speed=3] [--allow-mode=home|all|off] [--unallow-wild]
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

// ============================================================================
// Research Progression Plan (from RimOp optimization guide)
// ============================================================================

const TECH_TREE_ORDER = [
  "Batteries",
  "SolarPanels",
  "Gunsmithing",
  "BlowbackOperation",
  "GasOperation",
  "Electricity",
  "MicroelectronicsBasics",
  "DrugProduction",
  "PsychiteRefining",
  "MedicineProduction",
];

// ============================================================================
// Colony Agent State and Logic
// ============================================================================

export class ColonyAgent {
  constructor(options = {}) {
    this.speed = options.speed ?? 3;
    this.stepMs = options.stepMs ?? 2500;
    this.saveDaily = options.saveDaily ?? true;
    this.allowMode = options.allowMode ?? "home"; // "home", "all", or "off"
    this.unallowWild = options.unallowWild ?? true;
    this.lastSavedDay = null;
    this.lastLeaseClaim = 0;
    this.turnCount = 0;
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

  async advanceSimulation(durationMs = 2500, targetSpeed = 3) {
    await api.post("/speed", { speed: targetSpeed });
    await new Promise((r) => setTimeout(r, durationMs));
    await api.post("/speed", { speed: 0 });
  }

  async runTurn() {
    this.turnCount++;
    await this.ensureLease();

    // 1. Observe snapshot
    const snap = await api.get("/snapshot");
    const dateStr = snap.date ?? "";
    const colonists = snap.colonists ?? [];
    const alerts = snap.alerts ?? [];
    const hostiles = snap.hostiles ?? [];
    const research = snap.research ?? null;
    const resources = snap.resources ?? {};

    // Extract in-game day
    const dayMatch = dateStr.match(/(\d+)(?:st|nd|rd|th) of/);
    const curDay = dayMatch ? parseInt(dayMatch[1], 10) : null;

    // 2. Emergency check: Hostile threats
    if (hostiles.length > 0) {
      console.log(`[ALERT] ${hostiles.length} hostiles detected! Engaging combat protocol.`);
      await this.handleCombat(colonists, hostiles);
    } else {
      // Ensure colonists are undrafted when no hostiles remain
      for (const c of colonists) {
        if (c.drafted) {
          await api.post("/draft", { pawn: c.id, drafted: false });
        }
      }
    }

    // 3. Needs and health check
    for (const c of colonists) {
      const food = c.needs?.food ?? 1;
      const mood = c.needs?.mood ?? 1;
      const threshold = c.moodBreakThreshold ?? 0.35;

      if (food < 0.15) {
        console.log(`[WARN] Colonist ${c.name} is hungry (food: ${Math.round(food * 100)}%).`);
      }
      if (mood < threshold + 0.05) {
        console.log(`[WARN] Colonist ${c.name} near mental break threshold (mood: ${Math.round(mood * 100)}%, threshold: ${Math.round(threshold * 100)}%).`);
      }
    }

    // 4. Resource check and foraging
    const woodCount = resources.WoodLog ?? 0;
    if (woodCount < 100 && this.turnCount % 5 === 1) {
      await this.designateWoodChopping();
    }

    // 5. Allow Tool management: keep wild drops unallowed, allow home and vital supplies
    if (this.turnCount % 10 === 1 && this.allowMode !== "off") {
      await this.manageSupplies();
    }

    // 6. Dismiss expired or informational letters
    if (snap.letters && snap.letters.length > 3) {
      await api.post("/letter/dismiss", { all: true });
    }

    // 7. Research management
    if (!research || research.progress >= 1) {
      await this.advanceResearch(research?.project);
    }

    // 8. Auto-save at start of each day
    if (this.saveDaily && curDay !== null && curDay !== this.lastSavedDay) {
      const saveName = `NewDawn_Day${curDay}`;
      console.log(`[AUTOSAVE] Day ${curDay} reached. Saving as ${saveName}...`);
      try {
        await api.post("/game/save", { name: saveName });
        this.lastSavedDay = curDay;
        await this.waitForReady();
      } catch (err) {
        console.error(`[AUTOSAVE FAILED] ${err.message}`);
      }
    }

    // 9. Log turn status
    this.printStatus(snap, curDay);

    // 10. Advance simulation smoothly in real time
    const duration = hostiles.length > 0 ? 1000 : this.stepMs;
    const simSpeed = hostiles.length > 0 ? 1 : this.speed;
    await this.advanceSimulation(duration, simSpeed);
  }

  async manageSupplies() {
    try {
      if (this.unallowWild) {
        // Forbid items across the entire map so colonists do not run through hostile territory
        await api.post("/forbid", { all: true, forbidden: true });
      }

      if (this.allowMode === "home") {
        // Selectively allow all items within the Home area
        const res = await api.post("/allow", { home: true });
        // Also allow vital survival goods anywhere on the map
        const vitals = ["MedicineIndustrial", "MealSurvivalPack", "ComponentIndustrial"];
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

  async handleCombat(colonists, hostiles) {
    for (const c of colonists) {
      if (c.skills?.Shooting !== "disabled" && !c.drafted) {
        await api.post("/draft", { pawn: c.id, drafted: true });
        console.log(`[COMBAT] Drafted colonist ${c.name} (id ${c.id}).`);
      }
    }
    await reportThought(`[Combat] Hostiles detected (${hostiles.length}); drafted shooters for defense.`);
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

  async advanceResearch(currentProject) {
    let nextTech = null;
    for (const tech of TECH_TREE_ORDER) {
      if (tech === currentProject) continue;
      nextTech = tech;
      break;
    }
    if (nextTech) {
      try {
        await api.post("/research", { project: nextTech });
        console.log(`[RESEARCH] Set active research project to ${nextTech}.`);
        await reportThought(`[Research] Activated new research project: ${nextTech}.`);
      } catch (e) {
        console.warn(`[RESEARCH WARN] Could not set project ${nextTech}: ${e.message}`);
      }
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

  async run(turns = 10) {
    console.log(`Starting ColonyAgent loop for ${turns} turns (stepMs: ${this.stepMs}, speed: ${this.speed}, allowMode: ${this.allowMode}, unallowWild: ${this.unallowWild})...`);
    await this.checkHealth();
    for (let i = 0; i < turns; i++) {
      await this.runTurn();
    }
    console.log(`Completed ${turns} autonomous turns successfully.`);
  }
}

// CLI entry point
if (process.argv[1]?.endsWith("colony-agent.mjs")) {
  let turns = 10;
  let speed = 3;
  let stepMs = 2500;
  let allowMode = "home";
  let unallowWild = true;

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--turns=")) turns = parseInt(arg.split("=")[1], 10);
    if (arg.startsWith("--speed=")) speed = parseInt(arg.split("=")[1], 10);
    if (arg.startsWith("--step-ms=")) stepMs = parseInt(arg.split("=")[1], 10);
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
