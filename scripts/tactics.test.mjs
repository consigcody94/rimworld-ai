#!/usr/bin/env node
/**
 * Tests for the pure decision helpers in tactics.mjs. No game, no bridge, no network.
 *
 * Each case is a situation a journaled run actually met, and the assertion is the decision that
 * would have kept the colonist standing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  weaponInfo, isRangedWeapon, decideCombat, approachPoint, nextIntroEvent, scriptedThreatWindow,
  tickToDayHour, wantsFoodPhase, weaponPreferenceFromThoughts, threatPower, colonistPower, GAME_DATA,
} from "./tactics.mjs";

const founder = (over = {}) => ({ id: 1, name: "Yumi", x: 100, z: 100, health: { pct: 1 }, needs: { food: 0.6 }, ...over });

test("game data was generated from the installed game", () => {
  assert.ok(Object.keys(GAME_DATA.animals ?? {}).length > 50, "reference/game-data.json has no animals; run scripts/extract-game-data.py");
  assert.equal(GAME_DATA.animals.vulture.combatPower, 40);
  assert.equal(GAME_DATA.animals.vulture.flies, true);
});

test("weapons are recognised by the game's own table, with stuff and quality in the label", () => {
  assert.equal(weaponInfo("Short bow (normal)").ranged, true);
  assert.equal(weaponInfo("Short bow (normal)").range, 22.9);
  assert.equal(weaponInfo("Wooden club (poor)").ranged, false);
  assert.equal(weaponInfo("Plasteel longsword (good)").label, "longsword");
  assert.equal(isRangedWeapon("Revolver (excellent)"), true);
  assert.equal(isRangedWeapon(null), false);
});

test("a naked founder fights the scripted day-4 vulture instead of running from it", () => {
  // Return_e1w2gy: "Evading, because outmatched 2 to 3", a move order toward a map corner the game
  // called unreachable, and the founder downed from behind two minutes later.
  const d = decideCombat({
    colonists: [founder()],
    threats: [{ id: 9, kind: "vulture", x: 118, z: 104 }],
    skills: new Map([[1, { Melee: 2 }]]),
  });
  assert.equal(d.posture, "fight", d.reason);
});

test("contact always means fight: turning away hands out free hits", () => {
  const d = decideCombat({
    colonists: [founder()],
    threats: ["timber wolf", "timber wolf", "timber wolf"].map((kind, i) => ({ id: 10 + i, kind, x: 101, z: 100 + i })),
    shelter: { x: 102, z: 100, usable: true },
  });
  assert.equal(d.posture, "fight");
});

test("a wolf pack against one unarmed colonist: behind the door if it can be reached first", () => {
  const wolves = [0, 1, 2].map((i) => ({ id: 20 + i, kind: "timber wolf", x: 140, z: 100 + i }));
  const inside = decideCombat({ colonists: [founder()], threats: wolves, shelter: { x: 104, z: 100, usable: true } });
  assert.equal(inside.posture, "shelter", inside.reason);
  // A blueprint is not a wall, and a door behind the wolves is not a refuge.
  assert.equal(decideCombat({ colonists: [founder()], threats: wolves, shelter: { x: 104, z: 100, usable: false } }).posture, "fight");
  assert.equal(decideCombat({ colonists: [founder()], threats: wolves, shelter: { x: 150, z: 100, usable: true } }).posture, "fight");
});

test("nobody standing is helpless, not a posture", () => {
  const d = decideCombat({ colonists: [founder({ downed: true })], threats: [{ id: 3, kind: "drifter", gender: "Male", x: 90, z: 90 }] });
  assert.equal(d.posture, "helpless");
});

test("odds use the game's combat power, not a flat three per animal", () => {
  assert.equal(threatPower({ kind: "grizzly bear" }), 200);
  assert.equal(threatPower({ kind: "sparrow", health: { pct: 0.5 } }), 10);
  const bowman = colonistPower(founder({ weapon: "Short bow (normal)" }), { Shooting: 8 });
  const naked = colonistPower(founder(), { Melee: 6 });
  assert.ok(bowman > naked, "a bow is worth more than fists");
  assert.ok(Math.abs(naked - 30) < 3, `an unarmed Melee-6 colonist should sit near the game's colonist kind (30), got ${naked}`);
  assert.equal(colonistPower(founder({ mentalState: "sad wandering" })), 0, "a pawn in a mental break takes no orders");
});

test("a bow walks into range before it is asked to fire", () => {
  // Return_e2lsge: "POST /attack failed: Cannot attack: Out of range", three times, while a
  // drifter closed on the founder.
  const step = approachPoint({ x: 100, z: 100 }, { x: 140, z: 100 }, 22.9);
  assert.deepEqual(step, { x: 123, z: 100 });
  assert.equal(approachPoint({ x: 100, z: 100 }, { x: 110, z: 100 }, 22.9), null, "already in range");
  const edge = approachPoint({ x: 1, z: 1 }, { x: 60, z: 1 }, 22.9, 250);
  assert.ok(edge.x >= 2 && edge.z >= 2, "stays on the map");
});

test("the storyteller's scripted first week is known in advance", () => {
  assert.equal(nextIntroEvent(190000, "Cassandra Classic").tick, 204000);
  assert.equal(nextIntroEvent(210000, "Phoebe Chillax").kind, "misc");
  assert.equal(nextIntroEvent(190000, "Randy Random"), null, "Randy has no scripted intro");
  assert.equal(nextIntroEvent(400000, "Cassandra Classic"), null, "the script ends after day 6");
  assert.equal(scriptedThreatWindow(203000, "Cassandra Classic")?.kind, "small-threat");
  assert.equal(scriptedThreatWindow(330000, null)?.kind, "intro-raid", "unknown storyteller is treated as Cassandra");
  assert.equal(scriptedThreatWindow(150000, "Cassandra Classic"), null, "visitors are not a threat");
  assert.equal(tickToDayHour(204000).text, "day 4, 9h");
});

test("the food phase has hysteresis, so it stops flipping every minute", () => {
  const args = { hungriest: 0.33, supply: 0.4, earlyBaseNeeded: true };
  assert.equal(wantsFoodPhase({ ...args, inFoodPhase: false }), false, "not hungry enough to enter");
  assert.equal(wantsFoodPhase({ ...args, inFoodPhase: true }), true, "not fed enough to leave");
  assert.equal(wantsFoodPhase({ hungriest: 0.2, supply: 5, earlyBaseNeeded: true, inFoodPhase: false }), true);
  assert.equal(wantsFoodPhase({ hungriest: 0.7, supply: 3, earlyBaseNeeded: false, inFoodPhase: true }), false);
});

test("a despised weapon switches the colony to the other kind", () => {
  assert.equal(weaponPreferenceFromThoughts(["Used despised weapon -5", "Wielding a short bow -5"], "Short bow (poor)"), "melee");
  assert.equal(weaponPreferenceFromThoughts(["Used despised weapon -5"], "Wooden club"), "ranged");
  assert.equal(weaponPreferenceFromThoughts(["Ate without table -3"], "Short bow"), null);
});
