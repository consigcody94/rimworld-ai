#!/usr/bin/env node
/**
 * Tests for the supervisor's repair loop, with the game, the studio and the process table faked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Supervisor } from "./supervisor.mjs";

function world({ status, colony = { colonists: [{ id: 1 }] }, saves = [], stream = { running: true }, game = true, agent = true } = {}) {
  const calls = [];
  const w = {
    status, colony, saves, stream, game, agent, calls, clock: 1_000_000,
    shell: {
      gameRunning: () => w.game,
      agentRunning: () => w.agent,
      launchGame: () => calls.push(["launch"]),
      startAgent: () => { calls.push(["startAgent"]); return 4242; },
      stopAgent: () => calls.push(["stopAgent"]),
      killAgent: () => calls.push(["killAgent"]),
      heartbeatAt: () => w.heartbeat ?? null,
    },
  };
  w.bridge = async (p, method = "GET", body = null) => {
    calls.push(["bridge", method, p, body]);
    if (p === "/status") { if (!w.status) throw new Error("ECONNREFUSED"); return w.status; }
    if (p === "/colony") return w.colony;
    if (p === "/game/saves") return { saves: w.saves };
    return { ok: true };
  };
  w.studio = async (p, method = "GET", body = null) => {
    calls.push(["studio", method, p, body]);
    if (p === "/api/stream/status") return w.stream;
    return { ok: true };
  };
  w.sup = new Supervisor({ bridge: w.bridge, studio: w.studio, shell: w.shell, now: () => w.clock, log: () => {} });
  return w;
}

const posted = (w, p) => w.calls.filter((c) => c[0] === "bridge" && c[1] === "POST" && c[2] === p);

test("a game sitting at the title screen gets its newest save loaded, after a grace period", async () => {
  const w = world({ status: { programState: "Entry", playing: false }, saves: [{ name: "Autosave-4" }, { name: "PersonaCore_Day3" }] });
  await w.sup.check();
  assert.equal(posted(w, "/game/load").length, 0, "a human may be at the menu on purpose");
  w.clock += 95_000;
  await w.sup.check();
  const load = posted(w, "/game/load");
  assert.equal(load.length, 1);
  assert.equal(load[0][3].name, "Autosave-4", "the newest save");
  assert.equal(w.sup.recovery, "loading");
});

test("a live colony: unpaused, played and broadcast", async () => {
  const w = world({ status: { programState: "Playing", playing: true, paused: true, speed: 0, tick: 5000 }, agent: false, stream: { running: false } });
  await w.sup.check();
  assert.equal(posted(w, "/speed")[0][3].speed, 1);
  assert.ok(w.calls.some((c) => c[0] === "startAgent"));
  assert.ok(w.calls.some((c) => c[0] === "studio" && c[2] === "/api/stream/start"));
});

test("no broadcast is started while nothing is loaded", async () => {
  const w = world({ status: { programState: "Entry", playing: false }, stream: { running: false } });
  await w.sup.check();
  assert.equal(w.calls.some((c) => c[0] === "studio" && c[2] === "/api/stream/start"), false);
});

test("a vanished game is relaunched once, not in a loop", async () => {
  const w = world({ status: null, game: false });
  await w.sup.check();                  // first sighting
  w.clock += 31_000;
  await w.sup.check();                  // relaunch
  w.clock += 31_000;
  await w.sup.check();                  // first sighting again
  w.clock += 31_000;
  await w.sup.check();                  // inside the 180s window: no second relaunch
  assert.equal(w.calls.filter((c) => c[0] === "launch").length, 1);
});

test("a wiped colony is retired and a fresh one started", async () => {
  const w = world({ status: { programState: "Playing", playing: true, tick: 400000 }, colony: { colonists: [] } });
  for (let i = 0; i < 3; i++) await w.sup.check();
  assert.ok(w.calls.some((c) => c[0] === "stopAgent"));
  assert.equal(posted(w, "/game/menu").length, 1);
  w.status = { programState: "Entry", playing: false };
  await w.sup.check();
  const fresh = posted(w, "/game/new")[0];
  assert.equal(fresh?.[3].scenario, "NakedBrutality");
  assert.equal(w.sup.recovery, "loading");
});

test("asked for a new colony, the supervisor starts exactly one, then goes back to loading saves", async () => {
  const w = world({ status: { programState: "Entry", playing: false }, saves: [{ name: "Autosave-1" }] });
  w.sup.onTitle = "new";
  await w.sup.check();
  assert.equal(posted(w, "/game/new").length, 1);
  assert.equal(w.sup.onTitle, "load");
  // Suppose the new game never got going and the title screen came back: the grace period
  // starts over, and then the newest save is loaded rather than a second fresh colony.
  w.sup.recovery = null;
  await w.sup.check();
  w.clock += 95_000;
  await w.sup.check();
  assert.equal(posted(w, "/game/new").length, 1, "no second fresh colony");
  assert.equal(posted(w, "/game/load").length, 1);
});

test("a hung agent is killed once its heartbeat goes stale, and restarted on the next check", async () => {
  const w = world({ status: { programState: "Playing", playing: true, tick: 9000 } });
  w.heartbeat = w.clock - 30_000;
  await w.sup.check();
  assert.equal(w.calls.filter((c) => c[0] === "killAgent").length, 0, "thirty seconds is a slow turn, not a hang");
  w.heartbeat = w.clock - 200_000;
  await w.sup.check();
  assert.equal(w.calls.filter((c) => c[0] === "killAgent").length, 1);
  w.agent = false;
  await w.sup.check();
  assert.ok(w.calls.some((c) => c[0] === "startAgent"), "restarted");
});

test("a paused game does not get its agent killed for a stale heartbeat", async () => {
  const w = world({ status: { programState: "Playing", playing: true, paused: true, speed: 0, tick: 9000 } });
  w.heartbeat = w.clock - 500_000;
  await w.sup.check();
  assert.equal(w.calls.filter((c) => c[0] === "killAgent").length, 0);
});
