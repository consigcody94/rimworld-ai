#!/usr/bin/env node
/**
 * rimworld-mcp-server: MCP (stdio) adapter for the RimWorld AI Bridge mod.
 * Every tool maps to one HTTP route of the mod; see the mod's GET /help for the source of truth.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, ZodRawShape } from "zod";
import { api, present, BridgeError, API_URL } from "./client.js";
import { PLAY_GUIDE } from "./guide.js";

const server = new McpServer({ name: "rimworld-mcp-server", version: "0.1.0" });

type Ann = { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
const READ: Ann = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ACT: Ann = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DANGER: Ann = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

function errorResult(e: unknown) {
  const msg = e instanceof BridgeError ? e.message : (e as Error)?.message ?? String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

/** Register a tool that forwards its arguments to one bridge route. */
function tool(
  name: string,
  title: string,
  description: string,
  shape: ZodRawShape,
  route: { method: "GET" | "POST"; path: string | ((args: any) => string); pick?: (args: any) => Record<string, unknown> },
  annotations: Ann,
  timeoutMs?: number
) {
  server.registerTool(
    name,
    { title, description, inputSchema: shape, annotations },
    async (args: any) => {
      try {
        const path = typeof route.path === "function" ? route.path(args) : route.path;
        const params = route.pick ? route.pick(args) : args;
        const data = await api(route.method, path, params, timeoutMs);
        const { text, structured } = present(data);
        return { content: [{ type: "text" as const, text }], structuredContent: structured };
      } catch (e) {
        return errorResult(e);
      }
    }
  );
}

const pawnArg = z.string().describe("Pawn id (number from rimworld_pawns) or the pawn's short name, e.g. '1234' or 'Maria'");
const cellsShape = {
  cells: z.array(z.tuple([z.number().int(), z.number().int()])).optional().describe("Explicit cells as [[x,z],...]"),
  rect: z.object({ x: z.number().int(), z: z.number().int(), w: z.number().int().min(1), h: z.number().int().min(1) }).optional().describe("Rectangle: bottom-left x,z plus width/height"),
};

// ------------------------------------------------------------------ observe

tool("rimworld_status", "Game status", "Program state (main menu vs playing), game version, tick, speed, paused, date, maps, storyteller. Works even on the main menu. Call first.", {}, { method: "GET", path: "/status" }, READ);

tool("rimworld_health", "Server health", "Quick bridge health check (uptime, requests served, loading state). Runs off-thread.", {}, { method: "GET", path: "/health" }, READ);

tool("rimworld_snapshot", "Atomic colony snapshot", "Full atomic colony snapshot: status, colonists (health, mood, job), hostiles, alerts, resources, research, letters, and recent events. Preferred one-call observation for turn-based agent loops.", { map: z.number().int().optional().describe("Map id (default: player home)") }, { method: "GET", path: "/snapshot" }, READ);

tool("rimworld_colony", "Colony overview", "One-call situational overview: map summary (weather, date, hostiles, wealth, food), stockpiled resources, active alerts, colonist one-liners (health, mood, food, what they are doing), hostiles, research, open letters, quests, speed. Start every decision cycle here.", { map: z.number().int().optional().describe("Map id (default: player home)") }, { method: "GET", path: "/colony" }, READ);

tool("rimworld_map", "Map details", "Detailed map summary: zones (with ids and bounds), areas, resources, designation counts, camera position, conditions.", { map: z.number().int().optional() }, { method: "GET", path: "/map" }, READ);

tool("rimworld_maps", "List maps", "All maps currently loaded (home map, encounter maps).", {}, { method: "GET", path: "/maps" }, READ);

tool("rimworld_pawns", "List pawns", "List pawns with id, name, role, position, health, needs, current job, weapon. role: colony (default: colonists+prisoners+slaves+animals+mechs) | colonist | prisoner | slave | colony_animal | enemy | wild_animal | visitor | all. detail=true adds skills, work priorities, traits, apparel, thoughts.", {
  role: z.enum(["colony", "colonist", "prisoner", "slave", "colony_animal", "colony_mech", "enemy", "hostile_animal", "wild_animal", "visitor", "neutral", "all"]).optional(),
  detail: z.boolean().optional(),
  map: z.number().int().optional(),
}, { method: "GET", path: "/pawns" }, READ);

tool("rimworld_pawn", "Pawn detail", "Everything about one pawn: skills (level, * minor passion, ** major), work priorities, traits, apparel, mood thoughts, capacities, settings, inspect text.", { pawn: pawnArg, map: z.number().int().optional() }, { method: "GET", path: (a) => `/pawn/${encodeURIComponent(a.pawn)}`, pick: (a) => ({ map: a.map }) }, READ);

tool("rimworld_things", "List things", "Items, buildings and plants on the map with ids and positions. Filter by cat (Item|Building|Plant|Filth), def substring (e.g. 'Steel', 'Bed', 'Table'), label substring, rect 'x,z,w,h', forbidden, player-owned. Paginated (limit/offset). Use rimworld_things_summary first to see what exists.", {
  cat: z.enum(["Item", "Building", "Plant", "Filth"]).optional(),
  def: z.string().optional(),
  label: z.string().optional(),
  rect: z.string().optional().describe("x,z,w,h"),
  forbidden: z.boolean().optional(),
  player: z.boolean().optional().describe("Only player-faction things"),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
  detail: z.boolean().optional(),
  map: z.number().int().optional(),
}, { method: "GET", path: "/things" }, READ);

tool("rimworld_things_summary", "Count things by def", "Counts of things grouped by defName (what the colony has). cat and player filters as in rimworld_things.", { cat: z.enum(["Item", "Building", "Plant"]).optional(), player: z.boolean().optional(), limit: z.number().int().optional(), map: z.number().int().optional() }, { method: "GET", path: "/things/summary" }, READ);

tool("rimworld_thing", "Thing detail", "Detail for one thing by id (building bills, power, quality, inspect text). Works for pawns too.", { thing: z.string(), map: z.number().int().optional() }, { method: "GET", path: (a) => `/thing/${encodeURIComponent(a.thing)}`, pick: (a) => ({ map: a.map }) }, READ);

tool("rimworld_resources", "Stockpiled resources", "Counted resources (what the top bar shows): only items in stockpiles/home area count.", { map: z.number().int().optional() }, { method: "GET", path: "/resources" }, READ);

tool("rimworld_alerts", "Active alerts", "The game's active alerts (starvation, no doctor, raid, etc.) with explanations and culprits.", {}, { method: "GET", path: "/alerts" }, READ);

tool("rimworld_events", "Event feed", "Letters, on-screen messages, social log and battle log since a sequence number. Remember 'latest' and pass it as 'since' next time. Poll after every rimworld_wait.", { since: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional() }, { method: "GET", path: "/events" }, READ);

tool("rimworld_letters", "Open letters", "Letters (envelopes) currently on screen including full text and, for choice letters, the selectable options with their index.", {}, { method: "GET", path: "/letters" }, READ);

tool("rimworld_quests", "Quests", "Quests with state and description. all=true includes historical.", { all: z.boolean().optional() }, { method: "GET", path: "/quests" }, READ);

tool("rimworld_research", "Research status", "Current research project and projects that can be started now (with cost and tech level).", { all: z.boolean().optional().describe("Also list finished projects") }, { method: "GET", path: "/research" }, READ);

tool("rimworld_grid", "ASCII map", "ASCII rendering of a map region for spatial reasoning (colonists C, enemies E, walls #, ore O, doors D, buildings B, trees T, crops c, items i, growing zone \", stockpile :, water ~). Default 60x40 around the camera; pass x,z for the bottom-left corner and w,h for size (max 200); scale=2..8 downsamples for overview.", {
  x: z.number().int().optional(), z: z.number().int().optional(), w: z.number().int().min(1).max(200).optional(), h: z.number().int().min(1).max(200).optional(), scale: z.number().int().min(1).max(8).optional(), map: z.number().int().optional(),
}, { method: "GET", path: "/grid" }, READ);

tool("rimworld_cell", "Inspect a cell", "Terrain, things, zone, home area, roof, fog, temperature at one cell.", { x: z.number().int(), z: z.number().int(), map: z.number().int().optional() }, { method: "GET", path: "/cell" }, READ);

tool("rimworld_defs", "Search definitions", "Search game definitions by name/label. type: thing|building|item|plant|recipe|research|work|incident|terrain|storyteller|scenario|difficulty|biome|pawnkind. buildable=true restricts to player-buildable things (shows cost, size, research state).", {
  type: z.enum(["thing", "building", "item", "plant", "recipe", "research", "work", "incident", "terrain", "storyteller", "scenario", "difficulty", "biome", "pawnkind"]).optional(),
  q: z.string().optional(), limit: z.number().int().min(1).max(300).optional(), buildable: z.boolean().optional(),
}, { method: "GET", path: "/defs" }, READ);

tool("rimworld_help", "Bridge routes", "Lists every HTTP route the mod exposes (for rimworld_raw).", {}, { method: "GET", path: "/help" }, READ);

server.registerTool(
  "rimworld_screenshot",
  {
    title: "Screenshot",
    description: "Capture the game window as a PNG image (downscaled to width px, default 1024). Use rimworld_camera first to frame the area. Returns an image.",
    inputSchema: { width: z.number().int().min(200).max(3840).optional() },
    annotations: READ,
  },
  async ({ width }) => {
    try {
      const r = await api<{ image: string; mimeType: string }>("GET", "/screenshot", { width: width ?? 1024 }, 30_000);
      return { content: [{ type: "image" as const, data: r.image, mimeType: r.mimeType || "image/png" }] };
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ------------------------------------------------------------------ time

tool("rimworld_speed", "Set speed / pause", "Set game speed: 0=pause, 1=normal, 2=fast, 3=superfast, 4=ultrafast. Omit speed to toggle pause.", { speed: z.number().int().min(0).max(4).optional() }, { method: "POST", path: "/speed" }, ACT);

tool("rimworld_wait", "Advance time", "Run the game for N ticks (default 600 = 10 in-game seconds... 2500 ticks = 1 hour, 60000 = 1 day) at the given speed, then pause. Returns when done (max 60 s real time). This is the turn-based loop: act, wait, read events, repeat.", { ticks: z.number().int().min(1).max(60000).optional(), speed: z.number().int().min(1).max(4).optional() }, { method: "POST", path: "/wait" }, ACT, 120_000);

// ------------------------------------------------------------------ pawn orders

tool("rimworld_draft", "Draft / undraft", "Draft a colonist for manual control (combat) or undraft to resume work.", { pawn: pawnArg, drafted: z.boolean().default(true) }, { method: "POST", path: "/draft" }, ACT);

tool("rimworld_move", "Move pawn", "Order a pawn to walk to a cell. draft=true drafts first (required for holding a combat position).", { pawn: pawnArg, x: z.number().int(), z: z.number().int(), draft: z.boolean().optional() }, { method: "POST", path: "/move" }, ACT);

tool("rimworld_attack", "Attack target", "Order a pawn to attack a thing/pawn by id (ranged if armed with a gun, else melee). Drafts the pawn unless draft=false.", { pawn: pawnArg, target: z.string().describe("Target thing/pawn id"), draft: z.boolean().optional() }, { method: "POST", path: "/attack" }, ACT);

tool("rimworld_job", "Generic job order", "Issue any JobDef as a player-forced order: e.g. job='Rescue' targetA=downedPawnId targetB=bedId; job='Ingest' targetA=foodItemId; job='TendPatient' targetA=patientId; job='HaulToCell' targetA=itemId targetB=[x,z]; job='Sow'; job='FinishFrame' targetA=frameId; job='Arrest' targetA=pawnId targetB=bedId. Targets are thing ids or [x,z]. queue=true appends instead of interrupting.", {
  pawn: pawnArg, job: z.string().describe("JobDef defName"), targetA: z.union([z.string(), z.tuple([z.number(), z.number()])]).optional(), targetB: z.union([z.string(), z.tuple([z.number(), z.number()])]).optional(), targetC: z.union([z.string(), z.tuple([z.number(), z.number()])]).optional(), count: z.number().int().optional(), queue: z.boolean().optional(),
}, { method: "POST", path: "/job" }, ACT);

tool("rimworld_cancel_job", "Cancel job", "Interrupt a pawn's current job and clear its queue.", { pawn: pawnArg }, { method: "POST", path: "/job/cancel" }, ACT);

tool("rimworld_equip", "Equip / wear", "Make a pawn pick up and equip a weapon or wear apparel lying on the map.", { pawn: pawnArg, thing: z.string() }, { method: "POST", path: "/equip" }, ACT);

tool("rimworld_set_work", "Set work priority", "Set one work priority (0 = disabled, 1 = highest ... 4 = lowest). Work types: Firefighter, Patient, Doctor, PatientBedRest, BasicWorker, Warden, Handling, Cooking, Hunting, Construction, Growing, Mining, PlantCutting, Smithing, Tailoring, Art, Crafting, Hauling, Cleaning, Research (plus DLC ones; rimworld_defs type=work).", { pawn: pawnArg, work: z.string(), priority: z.number().int().min(0).max(4) }, { method: "POST", path: "/work" }, ACT);

tool("rimworld_set_work_bulk", "Set many priorities", "Set several work priorities on one pawn at once: priorities={Doctor:1, Cooking:2, Hauling:3}.", { pawn: pawnArg, priorities: z.record(z.number().int().min(0).max(4)) }, { method: "POST", path: "/work/bulk" }, ACT);

tool("rimworld_pawn_settings", "Pawn settings", "Hostility response (Flee|Attack|Ignore), medical care (NoCare|NoMeds|HerbalOrWorse|NormalOrWorse|Best), allowed area (label or 'none'), selfTend.", { pawn: pawnArg, hostility: z.enum(["Flee", "Attack", "Ignore"]).optional(), medicalCare: z.enum(["NoCare", "NoMeds", "HerbalOrWorse", "NormalOrWorse", "Best"]).optional(), area: z.string().optional(), selfTend: z.boolean().optional() }, { method: "POST", path: "/pawn/settings" }, ACT);

// ------------------------------------------------------------------ colony management

tool("rimworld_designate", "Designate work", "Mark cells/things for colonists to work on: mine (cells of rock/ore), chop (trees, by cells or ids), harvest, cut, hunt/tame/slaughter (animal ids), haul, deconstruct/uninstall (building ids), strip, open, claim, smooth, removeFloor, cancel (remove designations). Give cells, a rect, or thing ids.", {
  type: z.enum(["mine", "cancel", "harvest", "cut", "chop", "hunt", "tame", "haul", "deconstruct", "uninstall", "slaughter", "strip", "open", "claim", "smooth", "removeFloor", "release"]),
  ...cellsShape,
  things: z.array(z.union([z.string(), z.number()])).optional().describe("Thing ids"),
}, { method: "POST", path: "/designate" }, ACT);

tool("rimworld_build", "Place blueprint", "Place a construction blueprint at x,z (bottom-left/center per the game's rules). def = ThingDef or TerrainDef defName (e.g. Wall, Door, Bed, TableShort? use rimworld_defs type=building buildable=true q=table). stuff = material defName for stuff-made things (WoodLog, BlocksGranite, Steel, Plasteel). rot 0-3 = north/east/south/west. Colonists with Construction enabled build it when materials are available.", {
  def: z.string(), x: z.number().int(), z: z.number().int(), rot: z.number().int().min(0).max(3).optional(), stuff: z.string().optional(),
}, { method: "POST", path: "/build" }, ACT);

tool("rimworld_build_bulk", "Place many blueprints", "Place several blueprints in one call: items=[{def,x,z,rot,stuff},...]. Returns per-item results (failures do not abort the rest).", {
  items: z.array(z.object({ def: z.string(), x: z.number().int(), z: z.number().int(), rot: z.number().int().min(0).max(3).optional(), stuff: z.string().optional() })).min(1).max(400),
}, { method: "POST", path: "/build/bulk" }, ACT);

tool("rimworld_zone_create", "Create zone", "Create a stockpile, dumping, or growing zone over cells/rect. growing: set plant (e.g. Plant_Rice, Plant_Potato, Plant_Corn, Plant_Healroot, Plant_Cotton). stockpile: priority Low|Normal|Preferred|Important|Critical.", {
  type: z.enum(["stockpile", "dumping", "growing"]), ...cellsShape, plant: z.string().optional(), priority: z.enum(["Low", "Normal", "Preferred", "Important", "Critical"]).optional(), label: z.string().optional(),
}, { method: "POST", path: "/zone" }, ACT);

tool("rimworld_zone_update", "Update / delete zone", "Change a zone by id (from rimworld_map): plant, allowSow, priority, label, addCells, removeCells, or delete=true.", {
  id: z.number().int(), plant: z.string().optional(), allowSow: z.boolean().optional(), priority: z.enum(["Low", "Normal", "Preferred", "Important", "Critical"]).optional(), label: z.string().optional(),
  addCells: z.array(z.tuple([z.number().int(), z.number().int()])).optional(), removeCells: z.array(z.tuple([z.number().int(), z.number().int()])).optional(), delete: z.boolean().optional(),
}, { method: "POST", path: "/zone/update" }, ACT);

tool("rimworld_home_area", "Edit home area", "Add (add=true) or remove cells/rect from the Home area (colonists clean, firefight and count resources there).", { ...cellsShape, add: z.boolean().default(true) }, { method: "POST", path: "/area/home" }, ACT);

tool("rimworld_forbid", "Forbid / allow items", "Set forbidden state on items by id, or all=true for every item on the map (e.g. allow everything after a raid).", { things: z.array(z.union([z.string(), z.number()])).optional(), all: z.boolean().optional(), forbidden: z.boolean().default(false) }, { method: "POST", path: "/forbid" }, ACT);

tool("rimworld_bill_add", "Add production bill", "Add a bill to a workbench (thing id): recipe defName (e.g. CookMealSimple, Make_MeleeWeapon_Club, Make_Apparel_Parka; rimworld_defs type=recipe q=meal), mode forever|count|target, count.", { thing: z.string(), recipe: z.string(), mode: z.enum(["forever", "count", "target"]).optional(), count: z.number().int().optional(), suspended: z.boolean().optional() }, { method: "POST", path: "/bill" }, ACT);

tool("rimworld_bill_remove", "Remove bill", "Remove a bill by index from a workbench, or all=true.", { thing: z.string(), index: z.number().int().optional(), all: z.boolean().optional() }, { method: "POST", path: "/bill/remove" }, ACT);

tool("rimworld_set_research", "Set research", "Start researching a project (defName from rimworld_research available list).", { project: z.string() }, { method: "POST", path: "/research" }, ACT);

tool("rimworld_letter_choose", "Answer a letter", "Pick an option on a choice letter (accept/reject a quest, raid ransom, etc.) by letter id and choice index or label.", { id: z.number().int(), choice: z.union([z.number().int(), z.string()]) }, { method: "POST", path: "/letter/choose" }, ACT);

tool("rimworld_letter_dismiss", "Dismiss letter", "Remove a letter from the stack by id, or all=true.", { id: z.number().int().optional(), all: z.boolean().optional() }, { method: "POST", path: "/letter/dismiss" }, ACT);

tool("rimworld_quest_accept", "Accept quest", "Accept a quest by id (from rimworld_quests).", { id: z.number().int() }, { method: "POST", path: "/quest/accept" }, ACT);

tool("rimworld_dialog_close", "Close dialog", "Close the topmost dialog/popup that is force-pausing the game (all=true closes all).", { all: z.boolean().optional() }, { method: "POST", path: "/dialog/close" }, ACT);

tool("rimworld_camera", "Move camera", "Move the in-game camera to a cell and/or set zoom (8 close .. 80 far). Use before rimworld_screenshot; the human watching sees the same view.", { x: z.number().int().optional(), z: z.number().int().optional(), zoom: z.number().optional(), map: z.number().int().optional() }, { method: "POST", path: "/camera" }, ACT);

tool("rimworld_select", "Select in UI", "Select things or a pawn in the game UI so a human spectator sees what the AI is acting on.", { things: z.array(z.union([z.string(), z.number()])).optional(), pawn: z.string().optional() }, { method: "POST", path: "/select" }, ACT);

tool("rimworld_notify", "Message the player", "Show a short in-game message to the human (top-left) and log it to the event feed. Use to narrate decisions.", { text: z.string().max(300), type: z.enum(["neutral", "positive", "negative", "threat"]).optional() }, { method: "POST", path: "/notify" }, ACT);

// ------------------------------------------------------------------ game lifecycle

tool("rimworld_game_saves", "List saves", "List save files (newest first).", {}, { method: "GET", path: "/game/saves" }, READ);
tool("rimworld_game_save", "Save game", "Save the current game under a name (overwrites).", { name: z.string().default("AI Bridge") }, { method: "POST", path: "/game/save" }, ACT);
tool("rimworld_game_load", "Load save", "Load a save by name. Then poll rimworld_status until playing=true and loading=false (10-60 s).", { name: z.string() }, { method: "POST", path: "/game/load" }, DANGER);
tool("rimworld_game_new", "New game", "Start a new colony from the main menu without the setup UI (random world and starting pawns). scenario Crashlanded|LostTribe|RichExplorer|..., storyteller Cassandra|Phoebe|Randy, difficulty Peaceful|Easy|Medium|Rough|Hard|Extreme... (rimworld_defs type=difficulty). Takes 1-3 minutes; poll rimworld_status until playing=true.", {
  scenario: z.string().optional(), storyteller: z.string().optional(), difficulty: z.string().optional(), mapSize: z.number().int().min(75).max(400).optional(), seed: z.string().optional(), planetCoverage: z.number().min(0.05).max(1).optional(), colonyName: z.string().optional(),
}, { method: "POST", path: "/game/new" }, DANGER);
tool("rimworld_game_menu", "Quit to menu", "Leave the current game and return to the main menu (does not save).", {}, { method: "POST", path: "/game/menu" }, DANGER);
tool("rimworld_game_storyteller", "Change storyteller", "Change storyteller and/or difficulty mid-game.", { storyteller: z.string().optional(), difficulty: z.string().optional() }, { method: "POST", path: "/game/storyteller" }, ACT);

// ------------------------------------------------------------------ dev

tool("rimworld_dev", "Dev toggles", "Toggle developer mode / god mode (instant building). Requires 'allow dev actions' in the mod settings.", { devMode: z.boolean().optional(), godMode: z.boolean().optional() }, { method: "POST", path: "/dev" }, DANGER);
tool("rimworld_dev_incident", "Fire incident", "Force an incident now (RaidEnemy, TraderCaravanArrival, WandererJoin, ...; rimworld_defs type=incident). points sets raid size.", { def: z.string(), points: z.number().optional() }, { method: "POST", path: "/dev/incident" }, DANGER);
tool("rimworld_dev_spawn", "Spawn thing", "Spawn items/things at a cell (cheat).", { def: z.string(), x: z.number().int(), z: z.number().int(), count: z.number().int().optional(), stuff: z.string().optional() }, { method: "POST", path: "/dev/spawn" }, DANGER);

// ------------------------------------------------------------------ agent coordination

tool("rimworld_agent_claim", "Claim agent control", "Acquire exclusive agent control lease on the colony to prevent conflicting orders from other agents.", { agent: z.string().describe("Agent identifier"), leaseSec: z.number().int().min(5).max(300).optional().describe("Lease duration in seconds (default 30)") }, { method: "POST", path: "/agent/claim" }, ACT);

tool("rimworld_agent_release", "Release agent control", "Release exclusive agent control lease.", { agent: z.string().describe("Agent identifier") }, { method: "POST", path: "/agent/release" }, ACT);

tool("rimworld_agent_owner", "Agent lease owner", "Check current agent lease holder and remaining lease duration.", {}, { method: "GET", path: "/agent/owner" }, READ);

// ------------------------------------------------------------------ escape hatch

tool("rimworld_raw", "Raw bridge call", "Call any bridge route directly (see rimworld_help): method, path (e.g. '/things?cat=Item'), body object for POST.", { method: z.enum(["GET", "POST"]).default("GET"), path: z.string().regex(/^\//), body: z.record(z.unknown()).optional() }, { method: "GET", path: (a) => a.path, pick: (a) => a.body ?? {} }, ACT);
// rimworld_raw uses GET by default; POST variant:
server.registerTool("rimworld_raw_post", { title: "Raw POST", description: "POST to any bridge route with a JSON body.", inputSchema: { path: z.string().regex(/^\//), body: z.record(z.unknown()).optional() }, annotations: ACT }, async ({ path, body }) => {
  try { const { text, structured } = present(await api("POST", path, body ?? {})); return { content: [{ type: "text" as const, text }], structuredContent: structured }; } catch (e) { return errorResult(e); }
});

// ------------------------------------------------------------------ guidance

server.registerResource("play-guide", "rimworld://guide", { title: "How to play RimWorld through this bridge", description: "Strategy and tool-usage guide for AI agents", mimeType: "text/markdown" }, async () => ({ contents: [{ uri: "rimworld://guide", mimeType: "text/markdown", text: PLAY_GUIDE }] }));

server.registerPrompt("play_colony", { title: "Play the colony", description: "Kick off an autonomous play session: observe, decide, act, wait, repeat.", argsSchema: { goal: z.string().optional().describe("What to optimise for, e.g. 'survive the first year' or 'build a hospital'") } }, ({ goal }) => ({
  messages: [{ role: "user", content: { type: "text", text: `You are playing RimWorld through the rimworld_* tools.\n\n${PLAY_GUIDE}\n\nGoal: ${goal ?? "keep every colonist alive, fed, sheltered and happy; grow the colony sustainably"}.\nStart with rimworld_status, then rimworld_colony. If no game is running, rimworld_game_new. Narrate each decision briefly with rimworld_notify so the human can follow.` } }],
}));

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`rimworld-mcp-server ready (bridge: ${API_URL})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
