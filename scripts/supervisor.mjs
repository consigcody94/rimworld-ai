/**
 * Keeps the run alive.
 *
 * Several things have each stopped a run dead while looking fine from the outside: the game left
 * paused, the colony agent exited or was never started, the broadcast quietly dropping to idle,
 * RimWorld itself crashing, and the game sitting at the title screen after a relaunch with
 * nothing to load the colony back. None of them announce themselves, and an agent handed the
 * colony sat for ten minutes beside a paused game without noticing.
 *
 * So this watches the facts that matter, reads them from the game and the studio rather than
 * from anything an agent reports, and repairs each one on its own.
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
/** How long the game may sit at the title screen before the newest save is loaded. */
const MENU_GRACE_MS = Number(process.env.SUPERVISOR_MENU_GRACE_MS ?? 90000);
/** A colony agent whose heartbeat is older than this is hung, and gets killed and restarted. */
const HEARTBEAT_STALE_MS = Number(process.env.SUPERVISOR_HEARTBEAT_STALE_MS ?? 120000);
/** What to do at the title screen: "load" the newest save, or start one fresh colony ("new"). */
const ON_TITLE = process.env.SUPERVISOR_ON_TITLE ?? "load";

/** The reference campaign: see "The campaign rules" in README.md. */
export const NEW_COLONY = {
  scenario: "NakedBrutality", storyteller: "Cassandra", difficulty: "Rough",
  neolithic: true, curatePawn: true, season: "Spring",
};

const stamp = () => new Date().toISOString().slice(11, 19);

async function httpJson(base, p, method = "GET", body = null) {
  const r = await fetch(base + p, {
    method,
    headers: { "Content-Type": "application/json", "X-Agent-Id": AGENT_ID },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  return r.json();
}

const shell = {
  // Anchored to the start of the command line: a shell or a grep whose arguments mention the
  // path must never pass for the game or the agent (that mistake stopped a launch, live).
  gameRunning: () => execSync("pgrep -f '^[^ ]*RimWorld\\.app/Contents/MacOS/' || true").toString().trim().length > 0,
  agentRunning: () => execSync("pgrep -f '^[^ ]*node [^ ]*scripts/colony-agent\\.mjs' || true").toString().trim().length > 0,
  paused: () => fs.existsSync(path.join(ROOT, ".agent-state", "pause")),
  /** When the agent last finished starting a turn, or null if it has never said. */
  heartbeatAt() {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, ".agent-state", "heartbeat.json"), "utf8")).at ?? null; }
    catch { return null; }
  },
  killAgent() {
    try {
      const pids = execSync("pgrep -f '^[^ ]*node [^ ]*scripts/colony-agent\\.mjs' || true").toString().trim();
      for (const raw of pids.split(/\s+/)) {
        const pid = Number(raw);
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
      }
    } catch {}
  },
  launchGame: () => execSync("open -a RimWorld"),
  startAgent() {
    fs.mkdirSync(path.join(ROOT, ".agent-state"), { recursive: true });
    const out = fs.openSync(path.join(ROOT, ".agent-state", "agent.log"), "a");
    const child = spawn("node", ["scripts/colony-agent.mjs", "--auto-speed"], {
      cwd: ROOT, detached: true, stdio: ["ignore", out, out],
    });
    child.unref();
    return child.pid;
  },
  stopAgent() {
    try {
      const pids = execSync("pgrep -f '^[^ ]*node [^ ]*scripts/colony-agent\\.mjs' || true").toString().trim();
      for (const raw of pids.split(/\s+/)) {
        const pid = Number(raw);
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
          try { process.kill(pid, "SIGTERM"); } catch {}
        }
      }
    } catch {}
  },
};

/**
 * The supervisor's state machine, with the world injected so it can be tested without a game:
 * `bridge(path, method, body)` and `studio(...)` return parsed JSON, `shell` runs processes, and
 * `now()` is the clock.
 */
export class Supervisor {
  constructor({ bridge, studio, shell: sh = shell, now = () => Date.now(), log = (m) => console.log(`[${stamp()}] ${m}`), onTitle = ON_TITLE } = {}) {
    this.bridge = bridge ?? ((p, m, b) => httpJson(BRIDGE, p, m, b));
    this.studio = studio ?? ((p, m, b) => httpJson(STUDIO, p, m, b));
    this.shell = sh;
    this.now = now;
    this.log = log;
    this.lastDay = null;
    this.gameGoneSince = null;
    this.lastRelaunch = 0;
    this.stuckTicks = 0;
    this.lastTick = null;
    this.wipeChecks = 0;
    this.recovery = null;
    this.menuSince = null;
    this.lastResume = 0;
    this.lastSaid = new Map();
    this.onTitle = onTitle;
  }

  /** Log a line at most once per `ms` for a given key, so a steady state is not a wall of text. */
  say(key, msg, ms = 300000) {
    const last = this.lastSaid.get(key) ?? -Infinity;
    if (this.now() - last < ms) return;
    this.lastSaid.set(key, this.now());
    this.log(msg);
  }

  async check() {
    let st;
    try { st = await this.bridge("/status"); }
    catch {
      // The bridge lives inside RimWorld, so an unreachable bridge means the game itself is gone
      // or still starting. RimWorld once quit, the capture went to window-lost, and the run was
      // over with nothing in any log saying so.
      if (this.shell.gameRunning()) { this.say("starting", "RimWorld is running but the bridge is not answering yet; waiting.", 60000); return; }
      if (this.gameGoneSince === null) { this.gameGoneSince = this.now(); this.log("RimWorld is not running."); return; }
      if (this.now() - this.gameGoneSince < 30000) return;       // it may be mid-quit or mid-launch
      if (this.now() - this.lastRelaunch < 180000) return;       // never relaunch in a loop
      this.lastRelaunch = this.now();
      this.gameGoneSince = null;
      this.log("RimWorld has been gone for 30s; relaunching it. The newest save is loaded once it reaches the title screen.");
      try { this.shell.launchGame(); } catch (e) { this.log(`could not relaunch RimWorld: ${e.message}`); }
      return;
    }
    this.gameGoneSince = null;

    // A wiped colony cannot recover by restarting the agent: its old base ledger belongs to the
    // dead map. Retire it, show the title screen, then generate a completely fresh world.
    if (this.recovery === "menu") {
      if (st.programState === "Entry" && !st.loading) {
        const name = `Return ${this.now().toString(36).slice(-6)}`;
        const result = await this.bridge("/game/new", "POST", { ...NEW_COLONY, colonyName: name });
        if (result.ok) { this.recovery = "loading"; this.log(`starting a fresh colony: ${name}.`); }
        else this.log(`fresh colony request failed: ${result.error ?? "unknown error"}`);
      }
      return;
    }
    if (this.recovery === "loading") {
      if (!st.playing || st.loading) return;
      this.recovery = null;
      this.wipeChecks = 0;
      this.lastTick = null;
      this.log(`colony loaded: ${st.colonyName ?? "unnamed"}.`);
    }

    if (!st.playing) {
      await this.resumeFromTitle(st);
      return;
    }
    this.menuSince = null;

    const col = await this.bridge("/colony").catch(() => ({}));
    const living = Array.isArray(col.colonists) ? col.colonists.length : null;
    this.wipeChecks = living === 0 ? this.wipeChecks + 1 : 0;
    if (this.wipeChecks >= 3) {
      this.log(`colony wiped at tick ${st.tick}; retiring this run and returning to title.`);
      await this.studio("/api/chat/send", "POST", {
        message: "The colony was lost. I logged the run and am starting a fresh Naked Brutality attempt now; the AI will keep learning and trying.",
      }).catch(() => {});
      this.shell.stopAgent();
      const result = await this.bridge("/game/menu", "POST", {});
      if (result.ok) this.recovery = "menu";
      else this.log(`could not return to title after wipe: ${result.error ?? "unknown error"}`);
      return;
    }

    // 1. Paused. A paused game looks identical to a slow one until you read the flag.
    if (st.paused || st.speed === 0) {
      await this.bridge("/speed", "POST", { speed: 1 }).catch(() => {});
      this.log("game was paused; resumed at speed 1.");
    }

    // 2. The tick actually advancing. Speed can read 1 while the game sits behind a modal dialog.
    if (this.lastTick !== null && st.tick === this.lastTick) {
      this.stuckTicks++;
      if (this.stuckTicks === 3) {
        await this.bridge("/dialog/close", "POST", { all: true }).catch(() => {});
        await this.bridge("/speed", "POST", { speed: 1 }).catch(() => {});
        this.log(`tick has not moved in ${this.stuckTicks} checks; closed dialogs and resumed.`);
      }
    } else { this.stuckTicks = 0; }
    this.lastTick = st.tick;

    // 3. Somebody has to be playing, and actually taking turns. A hung agent looks alive to
    //    pgrep; its heartbeat file says otherwise.
    if (this.shell.agentRunning()) {
      const beat = this.shell.heartbeatAt?.() ?? null;
      if (beat != null && !st.paused && this.now() - beat > HEARTBEAT_STALE_MS) {
        this.shell.killAgent();
        this.log(`colony agent has not taken a turn in ${Math.round((this.now() - beat) / 1000)}s; killed it, it restarts on the next check.`);
        return;
      }
    } else if (this.shell.paused?.()) {
      this.say("paused", "colony agent is paused (npm run pause); not starting it.", 300000);
    } else {
      this.log(`colony agent was not running; started it as pid ${this.shell.startAgent()}.`);
    }

    // 4. The broadcast. Only ever started while a colony is actually loaded, so the channel never
    //    goes live on a title screen or a loading bar.
    try {
      const s = await this.studio("/api/stream/status");
      if (!s.running) {
        await this.studio("/api/stream/start", "POST", {});
        this.log("broadcast had stopped; started it again.");
      }
    } catch { this.say("studio-down", "the studio is not answering on its port; the colony continues without a broadcast."); }

    const day = Math.floor((st.tick ?? 0) / 60000) + 1;
    if (day !== this.lastDay) {
      this.lastDay = day;
      this.log(`day ${day}, ${living ?? "?"} colonist(s), tick ${st.tick}.`);
    }
  }

  /**
   * At the title screen with nothing in progress: load the newest save.
   *
   * After a crash and relaunch the game lands on the title screen, and nothing used to bring the
   * colony back: this logged "no colony loaded" every twenty seconds while the stream showed the
   * menu. A human at the menu on purpose gets a grace period first, and the load is attempted at
   * most once every five minutes.
   */
  async resumeFromTitle(st) {
    if (st.programState !== "Entry" || st.loading) {
      this.say("not-playing", `no colony loaded (programState ${st.programState}${st.loading ? ", loading" : ""}).`, 120000);
      return;
    }
    this.menuSince ??= this.now();
    // Asked for a fresh colony (npm run up -- --new): start it once, then go back to loading
    // saves, so a crash later in the run resumes that colony instead of replacing it.
    if (this.onTitle === "new") {
      const name = `Persona ${this.now().toString(36).slice(-5)}`;
      const result = await this.bridge("/game/new", "POST", { ...NEW_COLONY, colonyName: name });
      if (result.ok) {
        this.onTitle = "load";
        this.recovery = "loading";
        this.menuSince = null;
        this.log(`starting a fresh colony as asked: ${name}.`);
      } else this.log(`fresh colony request failed: ${result.error ?? "unknown error"}`);
      return;
    }
    if (this.now() - this.menuSince < MENU_GRACE_MS) {
      this.say("menu", "at the title screen; the newest save is loaded if nobody starts a game.", 120000);
      return;
    }
    if (this.now() - this.lastResume < 300000) return;
    this.lastResume = this.now();
    const saves = await this.bridge("/game/saves").catch(() => ({}));
    const newest = (saves.saves ?? [])[0];
    if (!newest?.name) { this.log("at the title screen with no saves to load; waiting for a new game."); return; }
    const result = await this.bridge("/game/load", "POST", { name: newest.name });
    if (result.ok) {
      this.recovery = "loading";
      this.menuSince = null;
      this.log(`loading the newest save, ${newest.name}, after ${Math.round(MENU_GRACE_MS / 1000)}s at the title screen.`);
    } else {
      this.log(`could not load ${newest.name}: ${result.error ?? "unknown error"}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sup = new Supervisor();
  sup.log(`Supervisor watching ${BRIDGE} every ${EVERY_MS / 1000}s.`);
  await sup.check().catch((e) => sup.log(`check failed: ${e.message}`));
  let checking = false;
  setInterval(async () => {
    if (checking) return;
    checking = true;
    try { await sup.check(); } catch (e) { sup.log(`check failed: ${e.message}`); }
    finally { checking = false; }
  }, EVERY_MS);
}
