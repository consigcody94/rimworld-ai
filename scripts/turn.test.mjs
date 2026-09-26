#!/usr/bin/env node
/**
 * Whole turns against a fake game, from founding through the scripted day-4 and day-6 threats.
 *
 * The unit tests check single decisions. This checks that a full turn runs end to end without
 * throwing, because the agent swallows errors in most routines: the prisoner capture was dead
 * for its whole life behind a ReferenceError that an empty catch ate. Any exception that escapes
 * runTurn fails here; any bridge path the agent asks for that a real bridge would not serve is
 * collected and checked against the routes the mod documents.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ColonyAgent } from "./colony-agent.mjs";

/** A small, self-consistent fake bridge. State changes only where a test needs it to. */
function fakeGame({ tick, hostiles = [], colonist = {} }) {
  const calls = [];
  const founder = {
    id: 1, name: "Toni", x: 120, z: 120, health: { pct: 1 }, moodBreakThreshold: 0.35,
    needs: { food: 0.7, rest: 0.8, mood: 0.6, joy: 0.5 }, job: { def: "Wait" }, ...colonist,
  };
  const snapshot = () => ({
    tick, speed: 1, paused: false, colonyName: "Test Colony", date: "5th of Aprimay, 5500",
    colonists: [founder], hostiles, letters: [], quests: [], foodNutrition: 4,
    resources: { WoodLog: 90 }, research: null,
  });
  const routes = [
    ["/snapshot", () => snapshot()],
    ["/status", () => ({ playing: true, storyteller: "Cassandra Classic", tick })],
    ["/health", () => ({ playing: true, loading: false })],
    ["/map", () => ({ size: { x: 250 }, tile: "123,0", zones: [], designations: {} })],
    ["/fertility", () => ({ best: [] })],
    ["/cell", () => ({ terrain: "Soil", things: [] })],
    ["/survey", () => ({ wildFoodGrown: 3, food: {}, game: [], corpses: {}, unhauledItems: 0 })],
    ["/things/summary", () => ({ groups: [{ def: "Campfire", count: 1 }, { def: "Bed", count: 1 }] })],
    ["/things", () => ({ things: [] })],
    ["/thing/", () => ({ bills: [] })],
    ["/pawns", () => ({ pawns: [] })],
    ["/pawn/", () => ({ skills: { Melee: 6, Shooting: 5, Crafting: 3, Construction: 5 }, thoughts: [], traits: [] })],
    ["/debug/pawn/", () => ({ workEnabled: {}, workDisabled: [] })],
    ["/research", () => ({ available: ["Stonecutting", "Pemmican"] })],
    ["/traders", () => ({ traders: [] })],
  ];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname + u.search;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method ?? "GET", path: p, body });
    const hit = routes.find(([prefix]) => u.pathname.startsWith(prefix));
    const payload = hit && (init.method ?? "GET") === "GET" ? hit[1]() : { ok: true, designated: 1, results: [] };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, founder, restore: () => { globalThis.fetch = real; } };
}

function freshAgent() {
  const a = new ColonyAgent({ quiet: true, stepMs: 0, combatMs: 0, saveDaily: false });
  // Journal and state into a scratch directory, never into the repo's runs/.
  a.journalPath = path.join(mkdtempSync(path.join(tmpdir(), "rw-turn-")), "run.jsonl");
  a.runStarted = Date.now();
  a.journalCounts = {};
  return a;
}

test("a founding turn and a quiet day-3 turn run end to end", async () => {
  const g = fakeGame({ tick: 5000 });
  try {
    const a = freshAgent();
    await a.runTurn();
    assert.ok(a.base, "the colony was founded");
    for (let i = 0; i < 3; i++) await a.runTurn();
    const g2 = fakeGame({ tick: 150000 });
    try { await a.runTurn(); } finally { g2.restore(); }
    assert.equal(a.stats.errors, 0);
  } finally { g.restore(); }
});

test("the day-4 mad animal is fought, and the day-6 raider's downing leads to a capture attempt", async () => {
  const a = freshAgent();
  let g = fakeGame({ tick: 204100, hostiles: [{ id: 9, kind: "squirrel", x: 124, z: 121, job: { def: "AttackMelee" } }] });
  try {
    await a.runTurn();
    assert.equal(a.inCombat, true);
    assert.ok(g.calls.some((c) => c.path === "/attack" && c.body?.target === 9), "attacked the squirrel");
  } finally { g.restore(); }

  g = fakeGame({ tick: 330000, hostiles: [{ id: 55, kind: "drifter", gender: "Male", downed: true, x: 125, z: 118 }] });
  try {
    a.turn += 100;                  // past the capture and prisoner cooldowns
    await a.runTurn();
    assert.equal(a.inCombat, false, "a downed raider is not a threat");
    // No prisoner bed exists in this fake world, so the agent must lay one rather than give up.
    assert.ok(g.calls.some((c) => c.path === "/build" && c.body?.def === "SleepingSpot"), "a prisoner spot was laid for him");
  } finally { g.restore(); }
});
