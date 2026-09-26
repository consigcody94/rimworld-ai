#!/usr/bin/env node
/**
 * Regression tests for the colony agent's play flow: phases, combat orders, prisoners, beds and
 * the scripted first week. Like agent.test.mjs, `fetch` is stubbed, every bridge call is
 * recorded, and the assertions are about the orders the agent decided to send.
 *
 * Every test names the journaled run that failed without the behaviour it checks.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ColonyAgent } from "./colony-agent.mjs";

function stubBridge(routes = {}) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    const path = u.pathname + u.search;
    calls.push({ method: init.method ?? "GET", path, body });
    const handler = Object.entries(routes).find(([p]) => path.startsWith(p));
    const payload = handler ? (typeof handler[1] === "function" ? handler[1](body) : handler[1]) : { ok: true };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const pawn = (over = {}) => ({
  id: 1, name: "Minoru", x: 50, z: 50, needs: { food: 0.8, rest: 0.9, mood: 0.6, joy: 0.6 },
  health: { pct: 1 }, moodBreakThreshold: 0.35, job: { def: "Wait" }, ...over,
});

function agentFor(over = {}) {
  const a = new ColonyAgent({ quiet: true });
  a.turn = 500;
  a.base = { x: 50, z: 50 };
  a.mapSize = 250;
  a.storyteller = "Cassandra Classic";
  a.configured.add(1);
  Object.assign(a, over);
  return a;
}

const posts = (calls, path) => calls.filter((c) => c.method === "POST" && c.path === path);

test("the house phase ends once the great hall stands, so later phases can run at all", () => {
  // Every one of fourteen journals shows only food, basics and house: the gate read a "hut" key
  // that nothing set, so research, mining, defenses, trade and recruiting never ran.
  const a = agentFor();
  a.builtDefs = new Set(["Campfire", "Bed", "Table1x2c", "Stool"]);
  a.placed.set("room-hall", { def: "Room" });
  a.hallStands = true;
  const snap = { tick: 100000, foodNutrition: 30 };
  const phase = a.currentPhase([pawn()], snap, { WoodLog: 80 });
  assert.equal(phase, "weapon", `expected the weapon phase for an unarmed colony with a house, got ${phase}: ${a.phaseReason}`);
  a.builtDefs.add("Bow_Short");
  assert.equal(a.currentPhase([pawn({ weapon: "Short bow" })], snap, { WoodLog: 80 }), "grow");
});

test("a hall still being built keeps the house phase, but not forever", () => {
  const a = agentFor();
  a.builtDefs = new Set(["Campfire", "Bed"]);
  a.placed.set("room-hall", { def: "Room" });
  a.pendingBuilds = 12;
  a.hallPlacedTick = 90000;
  assert.equal(a.currentPhase([pawn()], { tick: 100000, foodNutrition: 30 }, { WoodLog: 40 }), "house");
  assert.notEqual(a.currentPhase([pawn()], { tick: 300000, foodNutrition: 30 }, { WoodLog: 40 }), "house",
    "a wall the game keeps refusing must not pin the colony in the house phase");
});

test("a bow out of range walks into range instead of sending a refused attack", async () => {
  // Return_e2lsge: /attack refused as "Out of range" three times while a drifter closed in.
  const { calls, restore } = stubBridge();
  try {
    const a = agentFor();
    const archer = pawn({ weapon: "Short bow (normal)" });
    const drifter = { id: 7, kind: "drifter", gender: "Male", weapon: "Knife", x: 90, z: 50 };
    a.skillCache.set(1, { Shooting: 8 });
    await a.combatTurn([archer], [drifter], { tick: 330000, speed: 1 });
    const moves = posts(calls, "/move");
    assert.equal(moves.length, 1, "one approach order");
    assert.ok(moves[0].body.x > 50 && moves[0].body.x < 90, `approach toward the target, got ${JSON.stringify(moves[0].body)}`);
    assert.equal(posts(calls, "/attack").length, 0, "no attack order while out of range");
    assert.equal(calls.some((c) => c.body?.hostility === "Flee"), false, "nobody is told to flee");
  } finally { restore(); }
});

test("a bow in range shoots", async () => {
  const { calls, restore } = stubBridge();
  try {
    const a = agentFor();
    a.skillCache.set(1, { Shooting: 8 });
    await a.combatTurn([pawn({ weapon: "Short bow (normal)" })], [{ id: 7, kind: "drifter", gender: "Male", x: 62, z: 50 }], { tick: 330000, speed: 1 });
    assert.equal(posts(calls, "/attack").length, 1);
    assert.equal(posts(calls, "/attack")[0].body.target, 7);
  } finally { restore(); }
});

test("an unarmed founder attacks the scripted mad animal instead of running for a corner", async () => {
  // Return_e1w2gy: "Evading, because outmatched 2 to 3" toward (22,45), unreachable; downed.
  const { calls, restore } = stubBridge();
  try {
    const a = agentFor();
    await a.combatTurn([pawn()], [{ id: 9, kind: "vulture", x: 58, z: 55 }], { tick: 204200, speed: 1 });
    assert.equal(posts(calls, "/attack").length, 1, "attack the animal");
    assert.equal(posts(calls, "/move").length, 0, "no evade order");
  } finally { restore(); }
});

test("outmatched by a pack with a finished house to hand: go inside", async () => {
  const { calls, restore } = stubBridge();
  try {
    const a = agentFor();
    a.placed.set("room-hall", { def: "Room" });
    a.hallStands = true;
    const wolves = [0, 1, 2].map((i) => ({ id: 30 + i, kind: "timber wolf", x: 80, z: 50 + i }));
    await a.combatTurn([pawn({ x: 56, z: 50 })], wolves, { tick: 500000, speed: 1 });
    const moves = posts(calls, "/move");
    assert.equal(moves.length, 1);
    assert.deepEqual([moves[0].body.x, moves[0].body.z], [50, 50], "into the hall");
    assert.equal(a.combatPosture.posture, "shelter");
  } finally { restore(); }
});

test("a downed raider is carried to a prisoner sleeping spot", async () => {
  // The old capture code ordered the capture of an undefined `target` and threw into an empty
  // catch: no prisoner was ever taken. And it only looked for Beds, never sleeping spots.
  const { calls, restore } = stubBridge({
    "/things?cat=Building&player=1&def=Bed": { things: [{ id: 101, def: "Bed", x: 49, z: 49 }] },
    "/things?cat=Building&player=1&def=SleepingSpot": { things: [{ id: 202, def: "SleepingSpot", x: 62, z: 40, forPrisoners: true }] },
  });
  try {
    const a = agentFor();
    const raider = { id: 55, kind: "drifter", gender: "Male", downed: true, x: 70, z: 60 };
    await a.captureDowned([pawn()], { tick: 330000, hostiles: [raider] });
    const capture = posts(calls, "/job").find((c) => c.body.job === "Capture");
    assert.ok(capture, "a capture order");
    assert.equal(capture.body.targetA, 55);
    assert.equal(capture.body.targetB, 202, "the prisoner spot, never the founder's bed (101)");
  } finally { restore(); }
});

test("the prisoner spot goes down before the day-6 raid, not on day 1", async () => {
  const { calls, restore } = stubBridge({ "/things": { things: [] }, "/cell": { things: [] } });
  try {
    const a = agentFor();
    await a.ensurePrisonBed({ tick: 100000, hostiles: [] });
    assert.equal(posts(calls, "/build").length, 0, "too early");
    await a.ensurePrisonBed({ tick: 280000, hostiles: [] });
    const build = posts(calls, "/build")[0];
    assert.ok(build, "a sleeping spot for a prisoner");
    assert.equal(build.body.def, "SleepingSpot");
    assert.deepEqual([build.body.x, build.body.z], [62, 40], "where the prison room's bed will stand");
  } finally { restore(); }
});

test("the founder's only bed is never turned into a prison bed", async () => {
  const { calls, restore } = stubBridge({
    "/things?cat=Building&player=1&def=Bed": { things: [{ id: 101, def: "Bed", x: 49, z: 49 }] },
    "/things?cat=Building&player=1&def=SleepingSpot": { things: [] },
  });
  try {
    const a = agentFor();
    await a.ensureBeds([pawn()], { WoodLog: 300 });
    assert.equal(posts(calls, "/bed/settings").length, 0);
    assert.equal(posts(calls, "/build").length, 0, "one colonist, one bed: nothing to add");
  } finally { restore(); }
});

test("sleeping spots are only retired once everyone has a real bed, and a prisoner's never", async () => {
  const { calls, restore } = stubBridge({
    "/things?def=SleepingSpot": { things: [{ id: 1, def: "SleepingSpot", x: 48, z: 48 }, { id: 2, def: "SleepingSpot", x: 62, z: 40, forPrisoners: true }] },
    "/things?cat=Building&player=1&def=Bed": { things: [{ id: 101, def: "Bed", x: 49, z: 49 }] },
  });
  try {
    const a = agentFor();
    a.builtDefs = new Set(["SleepingSpot", "Bed"]);
    await a.manageUpgrades([pawn(), pawn({ id: 2, name: "Kim" })]);
    assert.equal(posts(calls, "/designate").length, 0, "two colonists, one bed: the spot is still someone's bed");
    calls.length = 0;
    a.lastRoutine.delete("upgrades");
    await a.manageUpgrades([pawn()]);
    const d = posts(calls, "/designate")[0];
    assert.deepEqual(d?.body.things, [1], "only the colonist's spot goes, never the prisoner's");
  } finally { restore(); }
});

test("an unarmed colony arms itself ahead of the day-4 threat, in any phase", async () => {
  const { calls, restore } = stubBridge({
    "/things?def=CraftingSpot": { things: [{ id: 77, def: "CraftingSpot", x: 44, z: 51 }] },
    "/thing/77": { bills: [] },
    "/things": { things: [] },
  });
  try {
    const a = agentFor();
    a.skillCache.set(1, { Crafting: 4 });
    await a.prepareForScriptedThreats([pawn()], { tick: 150000, colonists: [pawn()] }, { WoodLog: 60 });
    const bill = posts(calls, "/bill")[0];
    assert.ok(bill, "a weapon bill");
    assert.equal(bill.body.recipe, "Make_Bow_Short");
    assert.equal(a.weaponRush, true, "crafting outranks building until armed");
  } finally { restore(); }
});

test("the stream hears about the scripted threat an hour before it lands", async () => {
  const { calls, restore } = stubBridge();
  try {
    const a = agentFor();
    await a.prepareForScriptedThreats([pawn({ weapon: "Short bow" })], { tick: 202500 }, { WoodLog: 0 });
    const said = calls.filter((c) => c.path === "/api/thought").map((c) => c.body.text).join(" ");
    assert.match(said, /storyteller/);
    assert.ok(calls.some((c) => c.path === "/api/commentary"), "narrated for chat");
    assert.equal(a.desiredSpeed([pawn()], { tick: 203000 }, []), 1, "speed 1 while it is due");
  } finally { restore(); }
});

test("a despised bow gets swapped for a club", async () => {
  // Return_e2lsge carried "Used despised weapon -5" and "Wielding a short bow -5" for nine days.
  const { calls, restore } = stubBridge({
    "/pawn/1": { thoughts: ["Used despised weapon -5", "Wielding a short bow (poor) -5"] },
    "/things?def=CraftingSpot": { things: [{ id: 77, def: "CraftingSpot", x: 44, z: 51 }] },
    "/thing/77": { bills: [] },
    "/things": { things: [] },
  });
  try {
    const a = agentFor();
    a.skillCache.set(1, { Crafting: 4 });
    a.lastCounted = { WoodLog: 90 };
    await a.adaptToIdeology([pawn({ weapon: "Short bow (poor)" })]);
    assert.equal(a.weaponPreference, "melee");
    const bill = posts(calls, "/bill")[0];
    assert.equal(bill?.body.recipe, "Make_MeleeWeapon_Club");
  } finally { restore(); }
});

test("raw corpses are eaten only when a colonist is truly starving", async () => {
  const corpse = { id: 5, def: "Corpse_Raccoon", label: "Raccoon (dead)", corpse: true, nutrition: 2, x: 52, z: 50 };
  const { calls, restore } = stubBridge({ "/things?cat=Item": { things: [corpse] }, "/things?cat=Plant": { things: [] } });
  try {
    const a = agentFor();
    assert.equal(await a.eatSomething(pawn({ needs: { food: 0.2 } })), false, "at 20% the corpse waits for the butcher");
    a.lastRoutine.delete("eat-1");
    assert.equal(await a.eatSomething(pawn({ needs: { food: 0.08 } })), true, "at 8% anything edible");
    assert.equal(posts(calls, "/job")[0].body.targetA, 5);
  } finally { restore(); }
});

test("the daily save's 503 is not an error", async () => {
  const { restore } = stubBridge({ "/health": { playing: true, loading: false } });
  try {
    const a = agentFor({ stepMs: 0 });
    let n = 0;
    a.runTurn = async () => {
      if (n++ === 0) { const e = new Error("Game is busy loading (HTTP 503 GET /snapshot)"); e.status = 503; throw e; }
      return false;
    };
    await a.runForever(1);
    assert.equal(a.stats.errors, 0);
    assert.equal(a.stats.busy, 1);
  } finally { restore(); }
});

test("the hall counts as standing only when its own walls and doors are built", async () => {
  // Every perimeter cell of the 7x7 hall around (50,50): x 47..53, z 47..53.
  const wall = [];
  for (let x = 47; x <= 53; x++) { wall.push([x, 47]); wall.push([x, 53]); }
  for (let z = 48; z <= 52; z++) { wall.push([47, z]); wall.push([53, z]); }
  const built = (skip) => wall.filter(([x, z]) => [x, z].join() !== skip).map(([x, z]) => ({ def: "Wall", cat: "Building", x, z }));
  let walls = built("50,47");
  let pending = [{ def: "Frame_Wall", cat: "Ethereal", x: 50, z: 47 }];
  const { restore } = stubBridge({
    "/things?cat=Ethereal": () => ({ things: pending }),
    "/things?cat=Building&player=1": () => ({ things: walls }),
  });
  try {
    const a = agentFor();
    a.placed.set("room-hall", { def: "Room" });
    assert.equal(await a.checkHallStands(), false, "one wall still a frame");
    walls = built(null);
    pending = [{ def: "Blueprint_Bed", cat: "Ethereal", x: 49, z: 49 }];
    assert.equal(await a.checkHallStands(), true, "a pending bed inside does not make the hall open");
    assert.equal(a.shelter().usable, true);
  } finally { restore(); }
});

// ---------------------------------------------------------------- the two stalls the human saw

/** A forest map as the bridge lists it: hundreds of trees and rocks before any blueprint. */
function forestWorld({ blueprints = [], walls = [] } = {}) {
  const forest = [];
  for (let i = 0; i < 900; i++) forest.push({ def: i % 3 ? "Plant_TreeOak" : "Granite", cat: i % 3 ? "Plant" : "Building", x: 30 + (i % 50), z: 30 + Math.floor(i / 50) });
  return {
    "/things?rect": { things: forest },                                     // the old, unfiltered listing: truncated before the blueprints
    "/things?cat=Ethereal": { things: blueprints },
    "/things?cat=Building&player=1": { things: walls },
    "/things/summary?cat=Building": { groups: [{ def: "Campfire", count: 1 }, { def: "Bed", count: 1 }] },
    "/things": { things: [] },
    "/map": { zones: [] },
    "/cell": { things: [] },
    "/build/bulk": (body) => ({ results: body.items.map(() => ({ ok: true })) }),
  };
}

test("half a house: no second room while the first one's blueprints are still up", async () => {
  // Return_e6zjy1: the great hall, warehouse, kitchen, cold room and workshop were all laid out
  // within thirty seconds on three hundred wood, because the blueprint scan came back empty.
  const hallBlueprints = [];
  for (let x = 47; x <= 53; x++) { hallBlueprints.push({ def: "Blueprint_Wall", x, z: 47 }); hallBlueprints.push({ def: "Blueprint_Wall", x, z: 53 }); }
  const { calls, restore } = stubBridge(forestWorld({ blueprints: hallBlueprints }));
  try {
    const a = agentFor();
    a.builtDefs = new Set(["Campfire", "Bed"]);
    a.placed.set("room-hall", { def: "Room" });
    await a.manageBase([pawn()], { WoodLog: 314, Steel: 0 });
    assert.ok(a.pendingBuilds > 0, `pending blueprints must be seen, got ${a.pendingBuilds}`);
    assert.equal(posts(calls, "/build/bulk").length, 0, "no new room while the hall is unbuilt");
  } finally { restore(); }
});

test("a room whose blueprints did not all land is finished, not forgotten", async () => {
  const world = forestWorld();
  let refuse = new Set(["50,47"]);
  let placed = [];
  world["/build/bulk"] = (body) => ({ results: body.items.map((it) => {
    if (refuse.has(`${it.x},${it.z}`)) return { ok: false, error: "Cannot place Wall at 50,47: Space already occupied." };
    placed.push({ def: `Blueprint_${it.def}`, x: it.x, z: it.z }); return { ok: true };
  }) });
  world["/things?cat=Ethereal"] = () => ({ things: placed });
  const { calls, restore } = stubBridge(world);
  try {
    const a = agentFor();
    a.builtDefs = new Set(["Campfire", "Bed"]);
    await a.manageBase([pawn()], { WoodLog: 300, Steel: 0 });
    assert.equal(a.roomInProgress, "hall");
    assert.equal(a.roomObstacles.get("50,47"), "Obstacle", "a refused cell is a wall now, not a retry forever");
    // Next pass: nothing is missing (the obstacle counts as a wall), everything else is pending.
    a.lastRoutine.delete("room-wip");
    await a.manageBase([pawn()], { WoodLog: 300, Steel: 0 });
    assert.equal(posts(calls, "/build/bulk").length, 1, "no re-ordering of cells already ordered");
    assert.equal(a.roomInProgress, "hall", "still in progress while the walls are blueprints");
    // Everything gets built.
    world["/things?cat=Ethereal"] = () => ({ things: [] });
    world["/things?cat=Building&player=1"] = () => ({ things: placed.map((b) => ({ ...b, def: b.def.replace("Blueprint_", ""), cat: "Building" })) });
    await a.manageBase([pawn()], { WoodLog: 300, Steel: 0 });
    assert.equal(a.hallStands, true, "complete once every wall stands");
    assert.equal(a.roomInProgress, "bed1", "and the founder's bedroom starts in the same pass");
  } finally { restore(); }
});

test("wood is still gathered during a food emergency once the colonist is fed and walls are waiting", async () => {
  // Return_e6zjy1: the food flag went up on day 1 and never came down, and not one tree was
  // designated for the rest of the run while five rooms stood unpaid.
  const { calls, restore } = stubBridge({
    "/things?def=Plant_TreeOak": { things: [{ id: 1, def: "Plant_TreeOak", x: 60, z: 60, growth: 1 }, { id: 2, def: "Plant_TreeOak", x: 62, z: 60, growth: 1 }] },
    "/things": { things: [] },
  });
  try {
    const a = agentFor({ foodEmergency: true, hungriest: 0.5, pendingBuilds: 12, roomInProgress: "hall", roomWoodShortfall: 100 });
    a.builtDefs = new Set(["Campfire", "Bed"]);
    await a.manageWood({ WoodLog: 0 });
    const d = posts(calls, "/designate").find((c) => c.body.type === "chop");
    assert.ok(d, "trees designated");
    calls.length = 0;
    const b = agentFor({ foodEmergency: true, hungriest: 0.2, pendingBuilds: 12, roomInProgress: "hall", roomWoodShortfall: 100 });
    b.builtDefs = new Set(["Campfire", "Bed"]);
    await b.manageWood({ WoodLog: 0 });
    assert.equal(posts(calls, "/designate").length, 0, "a colonist near collapse is kept off the trees");
  } finally { restore(); }
});

test("the food emergency ends when the colonist is fed, not only when the larder is full", async () => {
  const { restore } = stubBridge({ "/things": { things: [] } });
  try {
    const a = agentFor({ foodEmergency: true, workPlanMode: "food" });
    await a.manageFood([pawn({ needs: { food: 0.7, rest: 1, mood: 0.6, joy: 0.6 } })], { foodNutrition: 0.5 }, { WoodLog: 0 });
    assert.equal(a.foodEmergency, false);
  } finally { restore(); }
});

test("only the agent's own tree designations are ever cancelled", async () => {
  const { calls, restore } = stubBridge({
    "/things?def=Plant_TreeOak": { things: [{ id: 1, def: "Plant_TreeOak", x: 60, z: 60, designation: "HarvestPlant" }, { id: 2, def: "Plant_TreeOak", x: 61, z: 60, designation: "HarvestPlant" }] },
    "/things": { things: [] },
  });
  try {
    const a = agentFor();
    a.agentTrees = new Set([2]);          // tree 1 was marked by the human watching the stream
    await a.clearWoodDesignations();
    const cancel = posts(calls, "/designate").find((c) => c.body.type === "cancel");
    assert.deepEqual(cancel?.body.things, [2]);
  } finally { restore(); }
});

test("the founder's bedroom comes right after the hall", () => {
  const a = agentFor();
  const keys = a.roomPlan(1).map((r) => r.key);
  assert.deepEqual(keys.slice(0, 2), ["hall", "bed1"]);
  assert.ok(keys.indexOf("bed2") > keys.indexOf("workshop"), "the spare bedroom waits");
  assert.deepEqual(a.roomPlan(2).map((r) => r.key).slice(0, 3), ["hall", "bed1", "bed2"]);
});

test("an idle colonist with walls waiting gets the colony kicked back into motion", async () => {
  const { calls, restore } = stubBridge({
    "/things?def=Plant_TreeOak": { things: [{ id: 9, def: "Plant_TreeOak", x: 60, z: 60, growth: 1 }] },
    "/things": { things: [] },
    "/pawn/": { skills: { Construction: 5 } },
  });
  try {
    const a = agentFor({ pendingBuilds: 10, roomInProgress: "hall", roomWoodShortfall: 80, foodEmergency: true, hungriest: 0.6 });
    a.builtDefs = new Set(["Campfire", "Bed"]);
    a.lastWoodOrderTurn = a.turn;         // trees were ordered recently, so only idling can trigger the kick
    const idle = pawn({ job: { def: "Wait_Wander" } });
    for (let i = 0; i < 24; i++) await a.detectStall([idle], { tick: 100000 }, { WoodLog: 0 });
    assert.equal(posts(calls, "/designate").length, 0, "not yet");
    await a.detectStall([idle], { tick: 100000 }, { WoodLog: 0 });
    assert.ok(posts(calls, "/designate").some((c) => c.body.type === "chop"), "trees ordered by force");
    assert.ok(posts(calls, "/work/bulk").length > 0, "work plan re-applied");
    assert.equal(a.idleTurns, 0);
  } finally { restore(); }
});

test("a paused agent issues no orders and releases its lease, then resumes", async () => {
  const { mkdirSync, writeFileSync, unlinkSync } = await import("node:fs");
  const path = (await import("node:path")).default;
  const stateDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", ".agent-state");
  const flag = path.join(stateDir, "pause");
  const { calls, restore } = stubBridge({ "/snapshot": { tick: 1000, colonists: [pawn()], hostiles: [] } });
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(flag, "test\n");
    const a = agentFor({ stepMs: 0 });
    const t = a.runTurn();
    await t;
    assert.equal(a.paused, true);
    assert.ok(posts(calls, "/agent/release").length >= 1, "lease released for the human");
    assert.equal(calls.filter((c) => c.path === "/snapshot").length, 0, "no orders, no reads while paused");
  } finally { try { unlinkSync(flag); } catch {} restore(); }
}, { timeout: 20000 });

test("a forced wood order rotates trees that were marked and never cut", async () => {
  const marked = [];
  for (let i = 1; i <= 8; i++) marked.push({ id: i, def: "Plant_TreeOak", x: 120 + i, z: 120, growth: 1, designation: "HarvestPlant" });
  const near = { id: 99, def: "Plant_TreeOak", x: 54, z: 50, growth: 1 };
  const { calls, restore } = stubBridge({
    "/things?def=Plant_TreeOak": { things: [...marked, near] },
    "/things": { things: [] },
  });
  try {
    const a = agentFor({ pendingBuilds: 10, roomInProgress: "hall", roomWoodShortfall: 100 });
    a.builtDefs = new Set(["Campfire", "Bed"]);
    a.agentTrees = new Set(marked.map((t) => t.id));
    await a.manageWood({ WoodLog: 0 });
    assert.equal(posts(calls, "/designate").length, 0, "seven or more already marked: the ordinary pass waits");
    await a.manageWood({ WoodLog: 0 }, { force: true, near: { x: 50, z: 50 } });
    const orders = posts(calls, "/designate").map((c) => c.body);
    assert.equal(orders[0]?.type, "cancel");
    assert.deepEqual(orders[0].things, marked.map((t) => t.id), "only the agent's own marks are cancelled");
    assert.equal(orders[1]?.type, "chop");
    assert.equal(orders[1].things[0], 99, "the nearest tree to the colonist comes first");
  } finally { restore(); }
});
