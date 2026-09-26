#!/usr/bin/env node
/**
 * One command for each thing a person (or an agent) does to this stack.
 *
 *   npm run preflight          is everything ready to go live? Starts nothing.
 *   npm run status             what is running right now, and is anything broadcasting?
 *   npm run up [-- --new]      start the studio and the supervisor (which then runs the game,
 *                              the colony agent and the broadcast). --new starts a fresh colony
 *                              instead of loading the newest save.
 *   npm run down [-- --quit-game]
 *                              end the broadcast cleanly, then stop everything this stack started.
 *   npm run report             what the run has achieved and what it is stuck on: the latest run
 *                              summary, recent stalls, the last lines of each log, all redacted.
 *   npm run pause | resume     stop the colony agent issuing orders (the game and the stream keep
 *                              running) so a person or another AI can play by hand, and hand back.
 *
 * Why this exists: bringing the stack up used to be a line of `&`-joined node commands pasted
 * from a chat log, and taking it down was a round of `ps | grep`. The broadcast once outlived the
 * game by an hour because nothing checked, and the Twitch stream key is on screen in any `ps` of
 * the old ffmpeg. Every line this prints is redacted.
 */
import { spawn, spawnSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = process.env.RIMWORLD_APP ?? "/Applications/RimWorld.app";
const BRIDGE = process.env.RIMWORLD_API ?? "http://127.0.0.1:18800";
const STUDIO = process.env.STREAM_STUDIO ?? "http://127.0.0.1:18888";
const MODS_CONFIG = path.join(process.env.HOME ?? "", "Library/Application Support/RimWorld/Config/ModsConfig.xml");
const LOGS = path.join(ROOT, "logs");
const BRIDGE_MOD_ID = "consigcody94.rimworldaibridge";
const OFFICIAL = /^ludeon\.rimworld/;

/** Anything that looks like a secret, removed from every line this script prints. */
export function redact(text) {
  return String(text)
    .replace(/(rtmps?:\/\/[^\s"']*\/app\/)[^\s"']+/gi, "$1<redacted>")
    .replace(/live_[A-Za-z0-9_]+/g, "live_<redacted>")
    .replace(/oauth:[A-Za-z0-9]+/gi, "oauth:<redacted>");
}

/** The studio's .env parser, kept identical: KEY=value per line, no quoting rules. */
export function parseEnv(text) {
  const env = {};
  for (const line of String(text).split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}

const readEnv = () => {
  try { return parseEnv(fs.readFileSync(path.join(ROOT, ".env"), "utf8")); } catch { return {}; }
};

const sha = (file) => {
  try { return createHash("sha1").update(fs.readFileSync(file)).digest("hex"); } catch { return null; }
};
const mtime = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return null; } };

/** pids whose full command line matches, excluding this process. */
function pids(pattern) {
  try {
    const out = execSync(`pgrep -f ${JSON.stringify(pattern)} || true`).toString().trim();
    return out ? out.split(/\s+/).map(Number).filter((p) => p && p !== process.pid) : [];
  } catch { return []; }
}

/** The processes that make up this stack, found by what they are rather than by what we remember. */
export const PROCESSES = {
  game: "MacOS/RimWorld",
  studio: "stream-app/server.mjs",
  supervisor: "scripts/supervisor.mjs",
  agent: "scripts/colony-agent.mjs",
  capture: "stream-app/bin/capture-window",
  relay: "stream-app/bin/rtmps-relay",
  // Our encoder is the only ffmpeg reading BGRA frames on stdin and PCM on fd 3.
  encoder: "ffmpeg .*-pixel_format bgra.*pipe:3",
};

async function getJson(base, p, timeoutMs = 3000) {
  try {
    const r = await fetch(base + p, { signal: AbortSignal.timeout(timeoutMs), headers: { "X-Agent-Id": "stack" } });
    return await r.json();
  } catch { return null; }
}

// ============================================================================
// preflight
// ============================================================================

/**
 * Every check that can be made without starting anything. Returns [{ level, name, detail, fix }],
 * level being "ok", "warn" or "fail". Only "fail" blocks `up`.
 */
export async function preflight({ online = true } = {}) {
  const out = [];
  const add = (level, name, detail = "", fix = "") => out.push({ level, name, detail, fix });

  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 18 ? "ok" : "fail", "Node", process.versions.node, "Node 18 or newer is required");

  const ffmpeg = spawnSync("ffmpeg", ["-hide_banner", "-version"], { encoding: "utf8" });
  add(ffmpeg.status === 0 ? "ok" : "fail", "ffmpeg", (ffmpeg.stdout ?? "").split("\n")[0].replace("ffmpeg version ", ""), "brew install ffmpeg");

  // Stream binaries: present, and built from the sources on disk.
  for (const [bin, src] of [["stream-app/bin/capture-window", "stream-app/capture-window.swift"], ["stream-app/bin/rtmps-relay", "stream-app/native/relay.c"]]) {
    const b = mtime(path.join(ROOT, bin)), s = mtime(path.join(ROOT, src));
    if (b == null) add("fail", path.basename(bin), "not built", "npm run build:stream");
    else if (s != null && s > b) add("fail", path.basename(bin), "older than its source", "npm run build:stream");
    else add("ok", path.basename(bin), "built");
  }

  // The mod: installed, current, and switched on.
  const repoDll = path.join(ROOT, "mod/1.6/Assemblies/RimWorldAIBridge.dll");
  const gameDll = path.join(APP, "Mods/RimWorldAIBridge/1.6/Assemblies/RimWorldAIBridge.dll");
  if (!fs.existsSync(APP)) add("fail", "RimWorld", `not found at ${APP}`, "set RIMWORLD_APP");
  else if (!fs.existsSync(gameDll)) add("warn", "Bridge mod", "not installed in the game", "npm run install:mod (up does this when the game is closed)");
  else if (sha(gameDll) !== sha(repoDll)) add("warn", "Bridge mod", "installed build differs from the repo build", "npm run install:mod (up does this when the game is closed)");
  else add("ok", "Bridge mod", "installed build matches the repo");
  const srcNewest = Math.max(0, ...walk(path.join(ROOT, "mod/Source")).filter((f) => f.endsWith(".cs")).map((f) => mtime(f) ?? 0));
  if ((mtime(repoDll) ?? 0) < srcNewest) add("warn", "Bridge DLL", "older than the C# sources", "npm run install:mod");

  let mods = [];
  try { mods = [...fs.readFileSync(MODS_CONFIG, "utf8").matchAll(/<li>([^<]+)<\/li>/g)].map((m) => m[1].trim().toLowerCase()); } catch {}
  if (!mods.length) add("warn", "ModsConfig", "could not read the active mod list");
  else {
    const i = mods.indexOf(BRIDGE_MOD_ID);
    add(i >= 0 ? "ok" : "fail", "Bridge mod enabled", i >= 0 ? "active" : "not in the active mod list", "npm run install:mod");
    // Everything past the base game and DLC changes the rules the agent was written for. Not a
    // failure, but worth seeing: Dubs Bad Hygiene alone adds bladder, hygiene and thirst needs.
    const third = mods.filter((m) => !OFFICIAL.test(m) && m !== BRIDGE_MOD_ID);
    if (third.length) add("warn", "Other mods", `${third.length} active: ${third.slice(0, 6).join(", ")}${third.length > 6 ? ", ..." : ""}`, "the agent is tuned for vanilla + DLC; see PLAYGUIDE.md");
  }

  // Secrets: present, private, valid. Values are never printed.
  const env = readEnv();
  const envFile = path.join(ROOT, ".env");
  if (!fs.existsSync(envFile)) add("fail", ".env", "missing", "cp .env.example .env and fill it in");
  else {
    const mode = fs.statSync(envFile).mode & 0o777;
    add(mode & 0o077 ? "warn" : "ok", ".env permissions", mode.toString(8), "chmod 600 .env");
    for (const k of ["TWITCH_CHANNEL", "TWITCH_STREAM_KEY"]) add(env[k] ? "ok" : "fail", k, env[k] ? "set" : "missing", "fill it in .env");
    for (const k of ["TWITCH_CLIENT_ID", "TWITCH_BOT_USERNAME", "TWITCH_BOT_OAUTH"]) add(env[k] ? "ok" : "warn", k, env[k] ? "set" : "missing: chat replies and titles will not work", "open http://localhost:18888/auth/twitch");
  }
  if (online && env.TWITCH_BOT_OAUTH) {
    try {
      const token = env.TWITCH_BOT_OAUTH.replace(/^oauth:/, "");
      const r = await fetch("https://id.twitch.tv/oauth2/validate", { headers: { Authorization: `OAuth ${token}` }, signal: AbortSignal.timeout(6000) });
      const v = await r.json();
      if (!r.ok) add("fail", "Twitch token", `rejected (${v.message ?? r.status})`, "open http://localhost:18888/auth/twitch");
      else {
        const days = Math.floor((v.expires_in ?? 0) / 86400);
        const scopes = (v.scopes ?? []).join(", ");
        add(days < 3 ? "warn" : "ok", "Twitch token", `${v.login}, ${days} days left, ${scopes}`, "re-authorise at http://localhost:18888/auth/twitch");
      }
    } catch (e) { add("warn", "Twitch token", `could not check (${e.message})`); }
  }

  // The MCP server other AIs play through, and the agent's game table.
  const mcpDist = path.join(ROOT, "mcp/dist/index.js");
  const mcpSrc = Math.max(0, ...walk(path.join(ROOT, "mcp/src")).map((f) => mtime(f) ?? 0));
  if (!fs.existsSync(mcpDist)) add("warn", "MCP server", "not built; every MCP client shows it as failed to connect", "npm run build:mcp");
  else if ((mtime(mcpDist) ?? 0) < mcpSrc) add("warn", "MCP server", "older than its sources", "npm run build:mcp");
  else add("ok", "MCP server", "built");
  try {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, "reference/game-data.json"), "utf8"));
    const installed = fs.readFileSync(path.join(APP, "Version.txt"), "utf8").trim();
    add(data.version === installed ? "ok" : "warn", "Game data table", data.version === installed ? installed : `built from ${data.version}, game is ${installed}`, "python3 scripts/extract-game-data.py");
  } catch { add("warn", "Game data table", "missing or unreadable", "python3 scripts/extract-game-data.py"); }

  // The tests are the only proof the agent's decisions still hold.
  const t = spawnSync(process.execPath, ["--test", "scripts/", "stream-app/"], { cwd: ROOT, encoding: "utf8" });
  const pass = /ℹ pass (\d+)/.exec(t.stdout ?? "")?.[1], fail = /ℹ fail (\d+)/.exec(t.stdout ?? "")?.[1];
  add(t.status === 0 ? "ok" : "fail", "Tests", `${pass ?? "?"} passed, ${fail ?? "?"} failed`, "npm test");

  // Anything already running. A live encoder with no game is the one-hour frozen-frame hazard.
  const running = Object.fromEntries(Object.entries(PROCESSES).map(([k, p]) => [k, pids(p)]));
  if (running.encoder.length && !running.game.length) add("fail", "Broadcast", "an encoder is running with no game: dead air on the channel", "npm run down");
  const live = Object.entries(running).filter(([, v]) => v.length).map(([k]) => k);
  add("ok", "Already running", live.length ? live.join(", ") : "nothing");
  return out;
}

function walk(dir) {
  const files = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "obj" || e.name === "bin" || e.name === "node_modules") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) files.push(...walk(p)); else files.push(p);
    }
  } catch {}
  return files;
}

function printChecks(checks) {
  const mark = { ok: "✓", warn: "!", fail: "✗" };
  for (const c of checks) {
    console.log(redact(`${mark[c.level]} ${c.name.padEnd(20)} ${c.detail}${c.level !== "ok" && c.fix ? `   -> ${c.fix}` : ""}`));
  }
  const fails = checks.filter((c) => c.level === "fail").length, warns = checks.filter((c) => c.level === "warn").length;
  console.log(fails ? `\nNOT READY: ${fails} problem(s), ${warns} warning(s).` : `\nREADY${warns ? ` with ${warns} warning(s)` : ""}.`);
  return fails === 0;
}

// ============================================================================
// status
// ============================================================================

async function status() {
  console.log("Processes");
  for (const [name, pattern] of Object.entries(PROCESSES)) {
    const p = pids(pattern);
    console.log(`  ${name.padEnd(11)} ${p.length ? p.join(" ") : "-"}`);
  }
  const st = await getJson(BRIDGE, "/status");
  console.log("\nGame");
  if (!st) console.log("  bridge not answering (RimWorld closed, loading, or the mod is off)");
  else {
    console.log(`  ${st.playing ? `playing ${st.colonyName ?? ""}, ${st.date ?? ""}, tick ${st.tick}, speed ${st.speed}${st.paused ? " (paused)" : ""}` : `at ${st.programState}`}`);
    if (st.playing) console.log(`  storyteller ${st.storyteller ?? "?"} / ${st.difficulty ?? "?"}, dev mode ${st.devMode ? "ON" : "off"}, god mode ${st.godMode ? "ON" : "off"}`);
    if (st.playing) {
      const col = await getJson(BRIDGE, "/colony", 6000);
      // /colony one-liners: hp, mood, food as 0..1, plus downed, mentalState, weapon, doing.
      const pct = (v) => (v == null ? "?" : `${Math.round(v * 100)}%`);
      for (const c of col?.colonists ?? []) {
        console.log(`  - ${c.name}: health ${pct(c.hp)}, mood ${pct(c.mood)}, food ${pct(c.food)}${c.weapon ? `, ${c.weapon}` : ", unarmed"}${c.mentalState ? `, BREAK: ${c.mentalState}` : ""}${c.downed ? ", DOWNED" : ""}${c.doing ? ` | ${c.doing}` : ""}`);
      }
      if (col && !(col.colonists ?? []).length) console.log("  no colonists on the map");
    }
  }
  const s = await getJson(STUDIO, "/api/stream/status");
  console.log("\nBroadcast");
  if (!s) console.log("  studio not answering");
  else console.log(redact(`  ${s.running ? "LIVE" : "off"}, capture ${s.captureState ?? "?"}${s.fps ? `, ${s.fps} fps` : ""}${s.speed ? `, ${s.speed}` : ""}${s.bitrate ? `, ${s.bitrate}` : ""}${s.error ? `, last error: ${s.error}` : ""}`));
  if (pids(PROCESSES.encoder).length && !pids(PROCESSES.game).length) {
    console.log("\n  WARNING: an encoder is running with no game. The channel is showing a frozen frame. Run: npm run down");
  }
  const runs = fs.existsSync(path.join(ROOT, "runs")) ? fs.readdirSync(path.join(ROOT, "runs")).filter((f) => f.endsWith(".md")).sort((a, b) => (mtime(path.join(ROOT, "runs", b)) ?? 0) - (mtime(path.join(ROOT, "runs", a)) ?? 0)) : [];
  if (runs[0]) console.log(`\nLatest run summary: runs/${runs[0]}`);
}

// ============================================================================
// report
// ============================================================================

const tailFile = (file, n) => {
  try { return fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-n); } catch { return []; }
};

/**
 * Everything an operator, human or AI, needs to say how the run is going, in one screen, with
 * nothing secret in it. Quote this rather than describing the logs from memory.
 */
async function report() {
  const runsDir = path.join(ROOT, "runs");
  const summaries = fs.existsSync(runsDir)
    ? fs.readdirSync(runsDir).filter((f) => f.endsWith(".md")).sort((a, b) => (mtime(path.join(runsDir, b)) ?? 0) - (mtime(path.join(runsDir, a)) ?? 0))
    : [];
  if (summaries[0]) {
    console.log(`Latest run: runs/${summaries[0]}\n`);
    console.log(redact(fs.readFileSync(path.join(runsDir, summaries[0]), "utf8").trim()));
    const journal = path.join(runsDir, summaries[0].replace(/\.md$/, ".jsonl"));
    const rows = tailFile(journal, 4000).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const interesting = rows.filter((r) => ["stall", "colony-lost", "colonist-lost", "helpless", "combat-start", "intro-event-due", "room-complete", "milestone", "food-emergency", "food-recovered", "phase"].includes(r.type)).slice(-14);
    if (interesting.length) {
      console.log("\nRecent events");
      for (const r of interesting) {
        const day = r.tick != null ? `day ${Math.floor(r.tick / 60000) + 1}` : "";
        const detail = r.why ?? r.text ?? r.cause ?? r.letter ?? r.reason ?? r.phase ?? r.room ?? r.label ?? r.event ?? "";
        console.log(redact(`  ${day.padEnd(7)} ${r.type.padEnd(16)} ${String(detail).slice(0, 150)}`));
      }
    }
  } else console.log("No run summaries yet (runs/ is empty).");

  const agentLog = tailFile(path.join(ROOT, ".agent-state", "agent.log"), 40);
  console.log(`\nColony agent, last ${agentLog.length} lines (.agent-state/agent.log)`);
  for (const l of agentLog) console.log(redact("  " + l.slice(0, 220)));
  const supLog = tailFile(path.join(LOGS, "supervisor.log"), 12);
  console.log(`\nSupervisor, last ${supLog.length} lines (logs/supervisor.log)`);
  for (const l of supLog) console.log(redact("  " + l.slice(0, 220)));
  const studioLog = tailFile(path.join(LOGS, "studio.log"), 8).filter((l) => /error|warn|LIVE|started|stopped|StreamEngine/i.test(l));
  if (studioLog.length) {
    console.log(`\nStudio, recent notable lines (logs/studio.log)`);
    for (const l of studioLog) console.log(redact("  " + l.slice(0, 220)));
  }
  console.log("");
  await status();
}

// ============================================================================
// up / down
// ============================================================================

function startDetached(name, args, extraEnv = {}) {
  fs.mkdirSync(LOGS, { recursive: true });
  const log = fs.openSync(path.join(LOGS, `${name}.log`), "a");
  const child = spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: ["ignore", log, log], env: { ...process.env, ...extraEnv } });
  child.unref();
  return child.pid;
}

async function up(flags) {
  const checks = await preflight({ online: !flags.has("--offline") });
  const ready = printChecks(checks);
  if (!ready && !flags.has("--force")) { console.log("Not starting. Fix the problems above, or pass --force."); process.exit(1); }

  // A stale mod is installed now if the game is closed; a running game would not load it anyway.
  const modStale = checks.some((c) => c.name.startsWith("Bridge") && c.level !== "ok");
  if (modStale) {
    if (pids(PROCESSES.game).length) console.log("! The bridge mod is out of date but RimWorld is open; restart it after `npm run install:mod` to pick up the new build.");
    else {
      console.log("Installing the current bridge mod...");
      const r = spawnSync("bash", [path.join(ROOT, "scripts/install-mod.sh")], { stdio: "inherit" });
      if (r.status !== 0) { console.log("Mod install failed; not starting."); process.exit(1); }
    }
  }

  if (!pids(PROCESSES.studio).length) console.log(`studio started (pid ${startDetached("studio", ["stream-app/server.mjs"])}), log logs/studio.log`);
  else console.log("studio already running");
  if (!pids(PROCESSES.game).length) {
    try { execSync(`open -a ${JSON.stringify(APP)}`); console.log("RimWorld launching"); } catch (e) { console.log(`could not open RimWorld: ${e.message}`); }
  }
  if (!pids(PROCESSES.supervisor).length) {
    const onTitle = flags.has("--new") ? "new" : "load";
    console.log(`supervisor started (pid ${startDetached("supervisor", ["scripts/supervisor.mjs"], { SUPERVISOR_ON_TITLE: onTitle })}), log logs/supervisor.log`);
    console.log(onTitle === "new" ? "It starts a fresh Naked Brutality colony at the title screen." : "It loads the newest save if the game sits at the title screen for 90 seconds.");
  } else console.log("supervisor already running");
  console.log("The supervisor starts the colony agent and the broadcast once a colony is loaded. Watch with: npm run status");
}

function stop(name, signal = "SIGTERM") {
  const list = pids(PROCESSES[name]);
  for (const pid of list) { try { process.kill(pid, signal); } catch {} }
  return list.length;
}

async function down(flags) {
  // The broadcast first, through the studio, so Twitch sees a clean end rather than a dropped
  // connection, and before the supervisor can notice and restart it.
  const stopped = await fetch(`${STUDIO}/api/stream/stop`, { method: "POST", signal: AbortSignal.timeout(8000) }).then((r) => r.ok).catch(() => false);
  console.log(stopped ? "broadcast stopped" : "broadcast: studio not answering");
  console.log(`supervisor: ${stop("supervisor") ? "stopped" : "not running"}`);
  // SIGTERM lets the agent release its lease and write the run summary.
  console.log(`colony agent: ${stop("agent") ? "stopped" : "not running"}`);
  console.log(`studio: ${stop("studio") ? "stopped" : "not running"}`);
  await new Promise((r) => setTimeout(r, 1500));
  for (const name of ["encoder", "relay", "capture"]) {
    const n = stop(name, "SIGKILL");
    if (n) console.log(`${name}: ${n} leftover process(es) killed`);
  }
  if (flags.has("--quit-game")) {
    const quit = await fetch(`${BRIDGE}/game/quit`, { method: "POST", headers: { "X-Agent-Id": "stack" }, signal: AbortSignal.timeout(5000) }).then((r) => r.ok).catch(() => false);
    console.log(quit ? "RimWorld asked to quit (no save; the agent saves daily)" : "RimWorld: bridge not answering; quit it by hand if it is still open");
  } else if (pids(PROCESSES.game).length) {
    console.log("RimWorld left running. Pass --quit-game to close it too.");
  }
  const left = Object.entries(PROCESSES).filter(([k]) => k !== "game").filter(([, p]) => pids(p).length).map(([k]) => k);
  console.log(left.length ? `STILL RUNNING: ${left.join(", ")}` : "All stack processes are down.");
}

// ============================================================================

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = new Set(rest);
  if (cmd === "preflight") process.exit(printChecks(await preflight({ online: !flags.has("--offline") })) ? 0 : 1);
  else if (cmd === "status") await status();
  else if (cmd === "report") await report();
  else if (cmd === "pause" || cmd === "resume") {
    const flag = path.join(ROOT, ".agent-state", "pause");
    fs.mkdirSync(path.dirname(flag), { recursive: true });
    if (cmd === "pause") { fs.writeFileSync(flag, `${new Date().toISOString()}\n`); console.log("Colony agent paused: it idles until `npm run resume`. Game and broadcast continue."); }
    else { try { fs.unlinkSync(flag); } catch {} console.log("Colony agent resumed."); }
  }
  else if (cmd === "up") await up(flags);
  else if (cmd === "down") await down(flags);
  else {
    console.log("usage: node scripts/stack.mjs preflight|status|report|pause|resume|up|down [--new] [--force] [--offline] [--quit-game]");
    process.exit(2);
  }
}
