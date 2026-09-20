/**
 * Keeps the run alive.
 *
 * Three things have each stopped a run dead while looking fine from the outside: the game left
 * paused, the colony agent exited or was never started, and the broadcast quietly dropping to
 * idle. None of them announce themselves, and an agent handed the colony sat for ten minutes
 * beside a paused game without noticing.
 *
 * So this watches the three facts that matter, reads them from the game and the studio rather
 * than from anything an agent reports, and repairs each one on its own.
 *
 *   node scripts/supervisor.mjs
 */
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE = process.env.RIMWORLD_API ?? "http://127.0.0.1:18800";
const STUDIO = process.env.STREAM_STUDIO ?? "http://127.0.0.1:18888";
const AGENT_ID = process.env.RIMWORLD_AGENT_ID ?? "persona-core";
const EVERY_MS = Number(process.env.SUPERVISOR_INTERVAL ?? 20000);

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

async function bridge(p, method = "GET", body = null) {
  const r = await fetch(BRIDGE + p, {
    method,
    headers: { "Content-Type": "application/json", "X-Agent-Id": AGENT_ID },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  return r.json();
}

async function studio(p, method = "GET", body = null) {
  const r = await fetch(STUDIO + p, {
    method,
    headers: { "Content-Type": "application/json", Host: "localhost:18888" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  return r.json();
}

function agentRunning() {
  try {
    return execSync("pgrep -f 'colony-agent.mjs' || true").toString().trim().length > 0;
  } catch { return false; }
}

function startAgent() {
  const out = fs.openSync(path.join(ROOT, ".agent-state", "agent.log"), "a");
  const child = spawn("node", ["scripts/colony-agent.mjs"], {
    cwd: ROOT, detached: true, stdio: ["ignore", out, out],
  });
  child.unref();
  return child.pid;
}

let lastDay = null;
let gameGoneSince = null;
let lastRelaunch = 0;
let stuckTicks = 0;
let lastTick = null;

async function check() {
  let st;
  try { st = await bridge("/status"); }
  catch {
    // The bridge lives inside RimWorld, so an unreachable bridge means the game itself is gone
    // or still starting. This watched everything except the one process everything depends on:
    // RimWorld quit, the capture went to window-lost, and the run was over with nothing in any
    // log saying so.
    const alive = execSync("pgrep -f 'MacOS/RimWorld' || true").toString().trim().length > 0;
    if (alive) { log("RimWorld is running but the bridge is not answering yet; waiting."); return; }
    const since = Date.now() - (gameGoneSince ?? Date.now());
    if (gameGoneSince === null) { gameGoneSince = Date.now(); log("RimWorld is not running."); return; }
    if (since < 30000) return;                     // it may be mid-quit or mid-launch
    if (Date.now() - lastRelaunch < 180000) return; // never relaunch in a loop
    lastRelaunch = Date.now();
    gameGoneSince = null;
    log("RimWorld has been gone for 30s; relaunching it. A new colony must be started once it reaches the menu.");
    try { execSync("open -a RimWorld"); } catch (e) { log(`could not relaunch RimWorld: ${e.message}`); }
    return;
  }
  gameGoneSince = null;

  if (!st.playing) { log(`no colony loaded (programState ${st.programState}).`); return; }

  // 1. Paused. A paused game looks identical to a slow one until you read the flag.
  if (st.paused || st.speed === 0) {
    await bridge("/speed", "POST", { speed: 1 }).catch(() => {});
    log("game was paused; resumed at speed 1.");
  }

  // 2. The tick actually advancing. Speed can read 1 while the game sits behind a modal dialog.
  if (lastTick !== null && st.tick === lastTick) {
    stuckTicks++;
    if (stuckTicks === 3) {
      await bridge("/dialog/close", "POST", { all: true }).catch(() => {});
      await bridge("/speed", "POST", { speed: 1 }).catch(() => {});
      log(`tick has not moved in ${stuckTicks} checks; closed dialogs and resumed.`);
    }
  } else { stuckTicks = 0; }
  lastTick = st.tick;

  // 3. Somebody has to be playing.
  if (!agentRunning()) log(`colony agent was not running; started it as pid ${startAgent()}.`);

  // 4. The broadcast.
  try {
    const s = await studio("/api/stream/status");
    if (!s.running) {
      await studio("/api/stream/start", "POST", {});
      log("broadcast had stopped; started it again.");
    }
  } catch { /* studio down is not fatal to the colony */ }

  const col = await bridge("/colony").catch(() => ({}));
  if (col.day && col.day !== lastDay) {
    lastDay = col.day;
    log(`day ${col.day}, ${col.colonistCount ?? "?"} colonist(s), tick ${st.tick}.`);
  }
}

log(`Supervisor watching ${BRIDGE} every ${EVERY_MS / 1000}s.`);
await check();
setInterval(() => { check().catch((e) => log(`check failed: ${e.message}`)); }, EVERY_MS);
