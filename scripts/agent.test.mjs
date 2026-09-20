#!/usr/bin/env node
/**
 * Regression tests for the colony agent's needs loop.
 *
 * These run with no game and no bridge: `fetch` is stubbed, every bridge call is recorded, and
 * the assertions are about the orders the agent decided to send. Run with `node --test scripts/`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ColonyAgent } from "./colony-agent.mjs";

/** Replace global fetch with a recorder. Returns { calls, restore }. */
function stubBridge(routes = {}) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method ?? "GET", path: u.pathname + u.search, body });
    const handler = Object.entries(routes).find(([p]) => (u.pathname + u.search).startsWith(p));
    const payload = handler ? handler[1] : { ok: true };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const pawn = (over = {}) => ({
  id: 1, name: "Trev", needs: { food: 1, rest: 1, mood: 1, joy: 1 },
  health: { pct: 1 }, moodBreakThreshold: 0.35, job: { def: "Wait" }, ...over,
});

function agentFor(over = {}) {
  const a = new ColonyAgent({ quiet: true });
  a.turn = 500;                 // past every() cooldowns
  a.base = { x: 50, z: 50 };
  a.configured.add(1);          // skip first-contact pawn setup
  Object.assign(a, over);
  return a;
}

const scheduleSets = (calls) =>
  calls.filter((c) => c.path === "/pawn/schedule").map((c) => c.body.preset);

test("a hungry pawn is pulled out of the joy timetable", async () => {
  // Regression: Rule 4 put the pawn on a recreation schedule for a mood dip, then Rule 1's
  // early return made the exit branch unreachable. The pawn swam and slept at 0% food until it
  // died. Hunger must break joy mode before any early return in the needs loop.
  //
  // This test used to assert the pawn was moved onto a "work" timetable. That was wrong, and it
  // cost a later run: a permanent Work schedule carries a high mental break risk, and a colonist
  // forced onto one while starving broke down at 3% mood and then ignored every order, because a
  // pawn in a mental break takes none. The correct destination is "anything", where the pawn
  // works and still manages its own needs. What matters here is that joy mode ends.
  const { calls, restore } = stubBridge();
  try {
    const a = agentFor({ foodEmergency: true });
    a.joyMode.set(1, 400);
    await a.manageNeeds([pawn({ needs: { food: 0.05, rest: 0.9, mood: 0.25, joy: 0.8 }, job: { def: "GoSwimming" } })],
      { foodNutrition: 0 }, {});
    assert.equal(a.joyMode.has(1), false, "joy mode should be cleared for a starving pawn");
    const presets = scheduleSets(calls);
    assert.ok(presets.includes("anything"), `expected the default anything timetable, got ${presets}`);
    assert.ok(!presets.includes("work"), "a forced Work timetable is a mental break risk and must not be used");
  } finally { restore(); }
});

test("a well-fed pawn keeps its joy timetable", async () => {
  const { calls, restore } = stubBridge();
  try {
    const a = agentFor();
    a.joyMode.set(1, 499);
    await a.manageNeeds([pawn({ needs: { food: 0.9, rest: 0.9, mood: 0.3, joy: 0.2 } })], { foodNutrition: 20 }, {});
    assert.equal(a.joyMode.has(1), true, "a fed pawn in a mood dip should stay on recreation");
    assert.equal(scheduleSets(calls).includes("work"), false);
  } finally { restore(); }
});

test("a rested pawn asleep while starving gets interrupted", async () => {
  const { calls, restore } = stubBridge();
  try {
    const a = agentFor();
    await a.manageNeeds([pawn({ needs: { food: 0.02, rest: 0.85, mood: 0.4, joy: 0.5 }, asleep: true })],
      { foodNutrition: 0 }, {});
    assert.ok(calls.some((c) => c.path === "/job/cancel"), "expected the sleep job to be cancelled");
  } finally { restore(); }
});

test("a genuinely exhausted pawn is left asleep", async () => {
  const { calls, restore } = stubBridge();
  try {
    const a = agentFor();
    await a.manageNeeds([pawn({ needs: { food: 0.02, rest: 0.1, mood: 0.4, joy: 0.5 }, asleep: true })],
      { foodNutrition: 0 }, {});
    assert.equal(calls.some((c) => c.path === "/job/cancel"), false, "exhaustion outranks the interrupt");
  } finally { restore(); }
});

test("a hungry pawn is sent to eat reachable food", async () => {
  const { calls, restore } = stubBridge({
    "/things?cat=Item": { things: [
      { id: 77, def: "RawBerries", label: "Berries", x: 52, z: 51, nutrition: 0.05, humanEdible: true },
      { id: 78, def: "Kibble", label: "Kibble", x: 51, z: 50, nutrition: 0.05, humanEdible: false },
    ] },
  });
  try {
    const a = agentFor();
    await a.manageNeeds([pawn({ needs: { food: 0.2, rest: 0.9, mood: 0.8, joy: 0.8 } })], { foodNutrition: 6 }, {});
    const eat = calls.find((c) => c.path === "/job" && c.body?.job === "Ingest");
    assert.ok(eat, "expected an Ingest order");
    assert.equal(eat.body.targetA, 77, "should eat the berries, not the animal kibble");
  } finally { restore(); }
});

test("a starving pawn is allowed to eat forbidden food", async () => {
  // Crash debris, drop pods, corpses and anything outside the home area all arrive forbidden.
  // A pawn standing next to a survival meal must not die of the forbidden flag.
  const { calls, restore } = stubBridge({
    "/things?cat=Item": { things: [
      { id: 90, def: "MealSurvivalPack", label: "Survival meal", x: 51, z: 50, nutrition: 0.9, humanEdible: true, forbidden: true },
    ] },
  });
  try {
    const a = agentFor();
    await a.manageNeeds([pawn({ needs: { food: 0.08, rest: 0.9, mood: 0.8, joy: 0.8 } })], { foodNutrition: 0 }, {});
    const allow = calls.find((c) => c.path === "/allow");
    assert.ok(allow, "expected the meal to be unforbidden");
    assert.deepEqual(allow.body.things, [90]);
    const eat = calls.find((c) => c.path === "/job" && c.body?.job === "Ingest");
    assert.equal(eat?.body.targetA, 90, "expected an Ingest order on the unforbidden meal");
  } finally { restore(); }
});

test("unforbidding is a last resort, not the first choice", async () => {
  const { calls, restore } = stubBridge({
    "/things?cat=Item": { things: [
      { id: 90, def: "MealSurvivalPack", label: "Survival meal", x: 50, z: 50, nutrition: 0.9, humanEdible: true, forbidden: true },
      { id: 91, def: "RawBerries", label: "Berries", x: 58, z: 58, nutrition: 0.05, humanEdible: true },
    ] },
  });
  try {
    const a = agentFor();
    await a.manageNeeds([pawn({ needs: { food: 0.2, rest: 0.9, mood: 0.8, joy: 0.8 } })], { foodNutrition: 6 }, {});
    assert.equal(calls.some((c) => c.path === "/allow"), false, "an allowed food exists; nothing should be unforbidden");
    assert.equal(calls.find((c) => c.path === "/job")?.body.targetA, 91);
  } finally { restore(); }
});
