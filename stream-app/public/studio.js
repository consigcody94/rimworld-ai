/* ==========================================================================
   RimWorld AI Stream Studio, operator dashboard client.

   Endpoints used:
     GET  /api/stream/status    encoder telemetry
     GET  /api/events           chat, poll, voice, brain, eventsub
     GET  /api/settings         channel, key and token presence
     POST /api/settings         { channel?, streamKey? }
     POST /api/stream/start     begin broadcasting
     POST /api/stream/stop      end broadcasting
     POST /api/chat/send        { message }
     POST /api/twitch/channel   set the Twitch category and title
     POST /api/events/test      { type, user, amount }   (wired in server.mjs)
   ========================================================================== */

"use strict";

const STATUS_MS = 1000;
const EVENTS_MS = 1500;

const $ = (id) => document.getElementById(id);

let isStreaming = false;
let toggleBusy = false;

/* --------------------------------------------------------------------------
   Utilities
   -------------------------------------------------------------------------- */

async function api(path, options) {
  const res = await fetch(path, { cache: "no-store", ...options });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status} from ${path}`);
  }
  return data ?? {};
}

async function postJson(path, body) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

function setClass(el, className, list) {
  if (!el) return;
  for (const c of list) el.classList.toggle(c, c === className);
}

let toastTimer = null;
function toast(message, kind = "ok") {
  const el = $("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("is-ok", kind === "ok");
  el.classList.toggle("is-bad", kind === "bad");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 4200);
}

/** 1804 seconds -> "30m 04s". Used for wall-clock uptime. */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "not running";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/* --------------------------------------------------------------------------
   Encoder telemetry
   -------------------------------------------------------------------------- */

const STAT_CLASSES = ["is-ok", "is-warn", "is-bad", "is-idle"];

function renderStreamStatus(s) {
  const running = Boolean(s.running);
  isStreaming = running;

  // LIVE / OFFLINE. "starting" covers the window where ffmpeg is up but the
  // capture has not reacquired the game window yet.
  const pill = $("live-pill");
  const starting = running && s.captureState !== "capturing";
  const state = !running ? "offline" : starting ? "starting" : "live";
  if (pill && pill.dataset.state !== state) pill.dataset.state = state;
  setText($("live-text"), !running ? "OFFLINE" : starting ? "STARTING" : "LIVE");

  const captureState = String(s.captureState ?? "idle");
  const capEl = $("capture-state");
  setText(capEl, `capture ${captureState}`);
  if (capEl) {
    capEl.classList.toggle("is-ok", captureState === "capturing");
    capEl.classList.toggle("is-warn", captureState === "window-lost");
  }

  const btn = $("btn-stream-toggle");
  if (btn && !toggleBusy) {
    setText(btn, running ? "Stop stream" : "Start stream");
    btn.className = running ? "btn btn-danger" : "btn btn-primary";
  }

  // Telemetry strip
  const fps = num(s.fps, 0);
  const fpsEl = $("t-fps");
  setText(fpsEl, running ? fps.toFixed(1) : "0");
  const targetFps = num(s.targetFps, 30);
  setClass(
    fpsEl,
    !running ? "is-idle" : fps >= targetFps * 0.95 ? "is-ok" : fps > 0 ? "is-warn" : "is-bad",
    STAT_CLASSES
  );

  setText($("t-bitrate"), running ? String(s.bitrate ?? "0 kbits/s") : "0 kbits/s");
  setClass($("t-bitrate"), running ? "is-ok" : "is-idle", STAT_CLASSES);

  const speedRaw = String(s.speed ?? "0x");
  const speed = num(speedRaw.replace("x", ""), 0);
  const speedEl = $("t-speed");
  setText(speedEl, running ? speedRaw : "0x");
  // Below 1.0x means the encoder is falling behind real time, which on a live
  // stream shows up as buffering for viewers.
  setClass(
    speedEl,
    !running ? "is-idle" : speed >= 0.98 ? "is-ok" : speed > 0 ? "is-bad" : "is-warn",
    STAT_CLASSES
  );

  setText($("t-frames"), String(num(s.frames, 0).toLocaleString()));
  setText($("t-time"), String(s.time ?? "00:00:00"));

  const startedAt = num(s.startedAt, null);
  setText($("t-uptime"), running && startedAt ? formatDuration(Date.now() - startedAt) : "not running");

  const capVal = $("t-capture");
  setText(capVal, captureState);
  setClass(
    capVal,
    captureState === "capturing" ? "is-ok" : captureState === "window-lost" ? "is-warn" : "is-idle",
    STAT_CLASSES
  );

  const restarts = num(s.restartCount, 0);
  setText($("t-restarts"), String(restarts));
  setClass($("t-restarts"), restarts === 0 ? "is-idle" : restarts < 3 ? "is-warn" : "is-bad", STAT_CLASSES);

  // Configured target, which is what you check first when quality looks wrong.
  const target = [
    s.targetBitrate ? String(s.targetBitrate) : null,
    s.targetFps ? `${s.targetFps}fps` : null,
    s.keyframeSeconds ? `${s.keyframeSeconds}s keyframes` : null,
  ].filter(Boolean).join(" / ");
  setText($("t-target"), target || "unknown");

  // Encoder error banner
  const errEl = $("encoder-error");
  if (errEl) {
    if (s.error) {
      setText(errEl, String(s.error));
      errEl.hidden = false;
    } else {
      errEl.hidden = true;
    }
  }

  // Channel info result from the last Helix update
  const info = s.channelInfo;
  const infoEl = $("channel-info-status");
  if (infoEl && info) {
    if (info.ok) {
      setText(infoEl, `${info.category ?? "RimWorld"}: ${info.title ?? ""}`.trim());
      infoEl.className = "inline-status is-ok";
    } else {
      setText(infoEl, String(info.error ?? "failed"));
      infoEl.className = "inline-status is-bad";
    }
  }
}

/* --------------------------------------------------------------------------
   Chat monitor
   -------------------------------------------------------------------------- */

let chatSignature = "";

function renderChat(data) {
  const log = $("chat-log");
  if (!log) return;

  const chip = $("chip-chat");
  if (chip) {
    const connected = Boolean(data.twitchConnected);
    setText(chip, connected ? `#${data.channel || "live"}` : "offline");
    chip.className = connected ? "chip is-ok" : "chip is-bad";
  }

  const chat = Array.isArray(data.chat) ? data.chat : [];
  const signature = `${chat.length}|${chat.length ? JSON.stringify(chat[chat.length - 1]) : ""}`;
  if (signature === chatSignature) return;
  chatSignature = signature;

  if (chat.length === 0) return;

  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 40;

  log.textContent = "";
  for (const m of chat) {
    const username = String(m.username ?? "viewer");
    const message = String(m.message ?? "");

    const line = document.createElement("div");
    line.className = "chat-line";
    if (username === "PersonaCore") line.classList.add("is-ai");
    else if (username === "Admin") line.classList.add("is-admin");
    if (message.startsWith("!")) line.classList.add("is-command");

    if (m.timestamp) {
      const t = document.createElement("span");
      t.className = "c-time";
      const match = String(m.timestamp).match(/^(\d{1,2}:\d{2}:\d{2})/);
      t.textContent = match ? match[1] : String(m.timestamp);
      line.appendChild(t);
    }

    const u = document.createElement("span");
    u.className = "c-user";
    u.textContent = `${username}:`;
    line.appendChild(u);

    // textContent, never innerHTML: chat is untrusted input.
    const body = document.createElement("span");
    body.className = "c-text";
    body.textContent = message;
    line.appendChild(body);

    log.appendChild(line);
  }

  if (stick) log.scrollTop = log.scrollHeight;
}

/* --------------------------------------------------------------------------
   Poll
   -------------------------------------------------------------------------- */

function renderPoll(data) {
  const list = $("poll-list");
  if (!list) return;

  const poll = data.poll && typeof data.poll === "object" ? data.poll : {};
  const rows = Object.entries(poll)
    .map(([choice, count]) => [choice, num(count, 0)])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);

  const total = rows.reduce((sum, [, n]) => sum + n, 0);
  const chip = $("chip-poll");
  setText(chip, total === 1 ? "1 vote" : `${total} votes`);
  if (chip) chip.className = total > 0 ? "chip is-ok" : "chip";

  if (rows.length === 0) {
    if (!list.querySelector(".hint")) {
      list.textContent = "";
      const p = document.createElement("p");
      p.className = "hint";
      p.innerHTML = "No votes yet. Viewers use <code>!vote &lt;choice&gt;</code>.";
      list.appendChild(p);
    }
    return;
  }

  const max = rows[0][1] || 1;
  const signature = rows.map(([c, n]) => `${c}:${n}`).join("|");
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;

  list.textContent = "";
  for (const [choice, count] of rows) {
    const row = document.createElement("div");
    row.className = count === max ? "poll-row is-leader" : "poll-row";

    const top = document.createElement("div");
    top.className = "poll-top";
    const c = document.createElement("span");
    c.className = "poll-choice";
    c.textContent = choice;
    const n = document.createElement("span");
    n.className = "poll-count";
    n.textContent = count === 1 ? "1 vote" : `${count} votes`;
    top.append(c, n);

    const bar = document.createElement("div");
    bar.className = "poll-bar";
    const fill = document.createElement("div");
    fill.className = "poll-fill";
    fill.style.width = `${Math.round((count / max) * 100)}%`;
    bar.appendChild(fill);

    row.append(top, bar);
    list.appendChild(row);
  }
}

/* --------------------------------------------------------------------------
   Voice and brain
   -------------------------------------------------------------------------- */

function kvRow(dl, key, value, cls) {
  const dt = document.createElement("dt");
  dt.textContent = key;
  const dd = document.createElement("dd");
  dd.textContent = value;
  if (cls) dd.className = cls;
  dl.append(dt, dd);
}

function renderVoice(data) {
  const meta = $("voice-meta");
  if (!meta) return;

  const voice = data.voice && typeof data.voice === "object" ? data.voice : {};
  const brain = data.brain && typeof data.brain === "object" ? data.brain : {};

  const state = voice.speaking ? "speaking" : voice.synthesizing ? "synthesizing" : "idle";
  const chip = $("chip-voice");
  setText(chip, state);
  if (chip) chip.className = state === "idle" ? "chip" : "chip is-ok";

  const dl = document.createElement("dl");
  dl.className = "kv";
  kvRow(dl, "State", state, state === "idle" ? null : "is-ok");
  kvRow(dl, "Engine", String(voice.engine ?? "unknown"));
  kvRow(dl, "Queued", String(num(voice.queued, 0)));
  if (voice.stats) kvRow(dl, "Spoken", String(num(voice.stats.spoken, 0)));
  kvRow(dl, "Brain", `${brain.mode ?? "unknown"} (${brain.llmAvailable ? "llm live" : "rules only"})`,
    brain.llmAvailable ? "is-ok" : "is-warn");
  if (brain.stats) {
    kvRow(dl, "Brain calls", `llm ${num(brain.stats.llm, 0)}, rules ${num(brain.stats.rules, 0)}, errors ${num(brain.stats.llmErrors, 0)}`,
      num(brain.stats.llmErrors, 0) > 0 ? "is-warn" : null);
  }

  meta.replaceWith(dl);
  dl.id = "voice-meta";

  setText($("voice-last"), voice.lastText ? String(voice.lastText) : "");
}

/* --------------------------------------------------------------------------
   EventSub status
   -------------------------------------------------------------------------- */

/** Which scope each subscription type needs, for the operator's benefit. */
const SCOPE_BY_TYPE = {
  "channel.follow": "moderator:read:followers",
  "channel.subscribe": "channel:read:subscriptions",
  "channel.subscription.gift": "channel:read:subscriptions",
  "channel.subscription.message": "channel:read:subscriptions",
  "channel.cheer": "bits:read",
  "channel.channel_points_custom_reward_redemption.add": "channel:read:redemptions",
};

function renderEventSub(data) {
  const list = $("eventsub-list");
  const metaHost = $("eventsub-meta");
  const chip = $("chip-eventsub");
  if (!list || !metaHost) return;

  const status = data.eventsub && typeof data.eventsub === "object" ? data.eventsub : null;

  if (!status) {
    setText(chip, "not wired");
    if (chip) chip.className = "chip is-warn";
    return; // leave the "add the eventsub field" hint in place
  }

  const subscribed = Array.isArray(status.subscribed) ? status.subscribed : [];
  const failed = Array.isArray(status.failed) ? status.failed : [];
  const revoked = Array.isArray(status.revoked) ? status.revoked : [];
  const missing = Array.isArray(status.missingScopes) ? status.missingScopes : [];

  const connected = Boolean(status.connected);
  setText(chip, connected ? `${subscribed.length} active` : "disconnected");
  if (chip) {
    chip.className = !connected ? "chip is-bad" : failed.length > 0 ? "chip is-warn" : "chip is-ok";
  }

  // Meta block
  const dl = document.createElement("dl");
  dl.className = "kv";
  kvRow(dl, "Connection", connected ? "connected" : "disconnected", connected ? "is-ok" : "is-bad");
  kvRow(dl, "Subscriptions", `${subscribed.length} active, ${failed.length} failed`,
    failed.length > 0 ? "is-warn" : "is-ok");
  if (status.lastEventAt) {
    kvRow(dl, "Last event", `${formatDuration(Date.now() - num(status.lastEventAt, Date.now()))} ago`);
  }
  if (num(status.reconnects, 0) > 0) kvRow(dl, "Reconnects", String(status.reconnects));
  if (status.wsImplementation) kvRow(dl, "WebSocket", String(status.wsImplementation));
  if (revoked.length > 0) kvRow(dl, "Revoked", revoked.map((r) => r.type).join(", "), "is-bad");
  if (status.lastError) kvRow(dl, "Last error", String(status.lastError), "is-bad");
  metaHost.replaceWith(dl);
  dl.id = "eventsub-meta";

  // Subscription list
  list.textContent = "";

  if (missing.length > 0) {
    const warn = document.createElement("div");
    warn.className = "scope-warn";
    warn.textContent =
      `The token is missing ${missing.length} scope${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. ` +
      `Re-authorize at /auth/twitch to enable the alerts that need them.`;
    list.appendChild(warn);
  }

  for (const sub of subscribed) {
    const row = document.createElement("div");
    row.className = "sub-row is-ok";
    const type = document.createElement("span");
    type.className = "sub-type";
    type.textContent = `${sub.type}${sub.version ? ` v${sub.version}` : ""}`;
    const why = document.createElement("span");
    why.className = "sub-why";
    why.textContent = "active";
    row.append(type, why);
    list.appendChild(row);
  }

  for (const f of failed) {
    const row = document.createElement("div");
    row.className = "sub-row is-bad";
    const type = document.createElement("span");
    type.className = "sub-type";
    type.textContent = `${f.type}${f.version ? ` v${f.version}` : ""}`;
    const why = document.createElement("span");
    why.className = "sub-why";
    const scope = f.scope ?? SCOPE_BY_TYPE[f.type] ?? null;
    why.textContent = f.reason
      ? String(f.reason)
      : scope
        ? `failed, needs scope ${scope}`
        : "failed";
    row.append(type, why);
    list.appendChild(row);
  }

  if (subscribed.length === 0 && failed.length === 0) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "No subscriptions reported yet.";
    list.appendChild(p);
  }
}

/* --------------------------------------------------------------------------
   Test alerts
   -------------------------------------------------------------------------- */

const TEST_ALERTS = [
  { type: "follow",  label: "Follow",   note: "new follower", amount: null },
  { type: "sub",     label: "Sub",      note: "tier 1",       amount: 1 },
  { type: "resub",   label: "Resub",    note: "12 months",    amount: 12 },
  { type: "giftsub", label: "Gift subs", note: "5 gifted",    amount: 5 },
  { type: "cheer",   label: "Cheer",    note: "500 bits",     amount: 500 },
  { type: "raid",    label: "Raid",     note: "42 viewers",   amount: 42 },
  { type: "redeem",  label: "Redeem",   note: "channel points", amount: 1000 },
  { type: "online",  label: "Online",   note: "stream up",    amount: null },
  { type: "offline", label: "Offline",  note: "stream down",  amount: null },
];

function buildTestButtons() {
  const grid = $("test-grid");
  if (!grid) return;
  grid.textContent = "";

  for (const alert of TEST_ALERTS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "test-btn";
    btn.dataset.kind = alert.type;

    const name = document.createElement("span");
    name.className = "t-name";
    name.textContent = alert.label;
    const note = document.createElement("span");
    note.className = "t-note";
    note.textContent = alert.note;
    btn.append(name, note);

    btn.addEventListener("click", () => fireTestAlert(alert, btn));
    grid.appendChild(btn);
  }
}

async function fireTestAlert(alert, btn) {
  const status = $("test-status");
  const user = $("in-test-user")?.value.trim() || "TestViewer";
  const typed = $("in-test-amount")?.value.trim();
  const amount = typed === "" || typed === undefined ? alert.amount : num(typed, alert.amount);

  btn.disabled = true;
  try {
    await postJson("/api/events/test", { type: alert.type, user, amount });
    if (status) {
      status.textContent = `Sent ${alert.type} as ${user}${amount != null ? ` (${amount})` : ""}.`;
      status.className = "inline-status is-ok";
    }
    toast(`Test alert sent: ${alert.type}`, "ok");
  } catch (err) {
    if (status) {
      status.textContent = `Failed: ${err.message}`;
      status.className = "inline-status is-bad";
    }
    toast(`Test alert failed: ${err.message}`, "bad");
  } finally {
    btn.disabled = false;
  }
}

/* --------------------------------------------------------------------------
   Settings
   -------------------------------------------------------------------------- */

async function loadSettings() {
  try {
    const s = await api("/api/settings");

    const channelInput = $("in-channel");
    if (channelInput && s.channel && document.activeElement !== channelInput) {
      channelInput.value = s.channel;
    }

    const keyInput = $("in-key");
    if (keyInput) {
      keyInput.placeholder = s.hasKey ? "configured in .env, hidden" : "live_...";
    }

    const oauth = $("oauth-status");
    if (oauth) {
      if (s.hasOauth && s.hasClientId) {
        oauth.textContent = s.botUsername ? `connected as ${s.botUsername}` : "connected";
        oauth.className = "inline-status is-ok";
      } else if (s.hasOauth) {
        oauth.textContent = "token saved, client id missing";
        oauth.className = "inline-status is-bad";
      } else {
        oauth.textContent = "not connected";
        oauth.className = "inline-status";
      }
    }

    const chip = $("chip-settings");
    if (chip) {
      const ready = Boolean(s.channel && s.hasKey && s.hasOauth && s.hasClientId);
      setText(chip, ready ? "ready" : "incomplete");
      chip.className = ready ? "chip is-ok" : "chip is-warn";
    }
  } catch (err) {
    const chip = $("chip-settings");
    if (chip) {
      setText(chip, "unreachable");
      chip.className = "chip is-bad";
    }
  }
}

async function saveChannel() {
  const channel = $("in-channel")?.value.trim();
  if (!channel) return toast("Enter a channel name first.", "bad");
  try {
    await postJson("/api/settings", { channel });
    toast(`Channel saved: ${channel}`, "ok");
    loadSettings();
  } catch (err) {
    toast(`Could not save the channel: ${err.message}`, "bad");
  }
}

async function saveKey() {
  const input = $("in-key");
  const streamKey = input?.value.trim();
  if (!streamKey) return toast("Paste a stream key first.", "bad");
  try {
    await postJson("/api/settings", { streamKey });
    if (input) input.value = "";
    toast("Stream key saved to .env.", "ok");
    loadSettings();
  } catch (err) {
    toast(`Could not save the key: ${err.message}`, "bad");
  }
}

async function applyChannelInfo() {
  const btn = $("btn-apply-channel-info");
  if (btn) btn.disabled = true;
  try {
    const result = await postJson("/api/twitch/channel", {});
    if (result.ok) toast(`Category set to ${result.category ?? "RimWorld"}.`, "ok");
    else toast(`Channel update failed: ${result.error ?? "unknown error"}`, "bad");
  } catch (err) {
    toast(`Channel update failed: ${err.message}`, "bad");
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* --------------------------------------------------------------------------
   Stream control
   -------------------------------------------------------------------------- */

async function toggleStream() {
  const btn = $("btn-stream-toggle");
  toggleBusy = true;
  if (btn) {
    btn.disabled = true;
    setText(btn, isStreaming ? "Stopping..." : "Starting...");
  }
  try {
    const result = await postJson(isStreaming ? "/api/stream/stop" : "/api/stream/start", {});
    toast(result.status ? `Stream ${result.status}.` : "Done.", "ok");
  } catch (err) {
    toast(`Stream control failed: ${err.message}`, "bad");
  } finally {
    toggleBusy = false;
    if (btn) btn.disabled = false;
    tickStatus();
  }
}

async function sendChat() {
  const input = $("in-chat");
  const message = input?.value.trim();
  if (!message) return;
  if (input) input.value = "";
  try {
    await postJson("/api/chat/send", { message });
  } catch (err) {
    toast(`Could not send: ${err.message}`, "bad");
  }
}

/* --------------------------------------------------------------------------
   Polling
   -------------------------------------------------------------------------- */

async function tickStatus() {
  try {
    const s = await api("/api/stream/status");
    renderStreamStatus(s ?? {});
  } catch (err) {
    const pill = $("live-pill");
    if (pill) pill.dataset.state = "offline";
    setText($("live-text"), "NO SERVER");
  }
}

async function tickEvents() {
  try {
    const data = await api("/api/events");
    renderChat(data);
    renderPoll(data);
    renderVoice(data);
    renderEventSub(data);
  } catch (err) {
    const chip = $("chip-chat");
    if (chip) {
      setText(chip, "unreachable");
      chip.className = "chip is-bad";
    }
  }
}

function wire() {
  $("btn-stream-toggle")?.addEventListener("click", toggleStream);
  $("btn-save-channel")?.addEventListener("click", saveChannel);
  $("btn-save-key")?.addEventListener("click", saveKey);
  $("btn-apply-channel-info")?.addEventListener("click", applyChannelInfo);
  $("btn-send-chat")?.addEventListener("click", sendChat);

  $("in-chat")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChat();
  });
  $("in-channel")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveChannel();
  });
  $("in-key")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveKey();
  });
}

function start() {
  wire();
  buildTestButtons();
  loadSettings();
  tickStatus();
  tickEvents();
  setInterval(tickStatus, STATUS_MS);
  setInterval(tickEvents, EVENTS_MS);
  setInterval(loadSettings, 15000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
