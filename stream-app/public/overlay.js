/* ==========================================================================
   RimWorld AI broadcast overlay client.

   Polls two endpoints roughly every 1.5 seconds:
     GET /api/events    chat, poll, thoughts, voice, brain, twitchEvents
     GET /api/snapshot   colony telemetry from the RimWorld bridge

   Panel selection:
     /overlay?parts=chat,alerts,hud,poll   (default: all)
   Valid values: chat, alerts, hud, poll, voice. "hud" implies "voice".

   Every field is read defensively. A missing key, a null, or an unreachable
   bridge degrades to a placeholder rather than throwing, because this page runs
   unattended inside OBS for hours.
   ========================================================================== */

"use strict";

const POLL_MS = 1500;

/* --------------------------------------------------------------------------
   Part selection
   -------------------------------------------------------------------------- */

const ALL_PARTS = ["chat", "alerts", "hud", "poll", "voice"];

function resolveParts() {
  const raw = new URLSearchParams(location.search).get("parts");
  if (!raw || raw.trim() === "" || raw.trim().toLowerCase() === "all") {
    return { set: new Set(ALL_PARTS), requested: ALL_PARTS.slice(), isSolo: false };
  }
  const requested = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => ALL_PARTS.includes(s));

  if (requested.length === 0) {
    console.warn(`[overlay] No recognised part in "${raw}". Showing everything. Valid: ${ALL_PARTS.join(", ")}`);
    return { set: new Set(ALL_PARTS), requested: ALL_PARTS.slice(), isSolo: false };
  }

  const set = new Set(requested);
  if (set.has("hud")) set.add("voice"); // the voice readout belongs to the HUD
  return { set, requested, isSolo: requested.length === 1 };
}

const PARTS = resolveParts();

function applyParts() {
  for (const el of document.querySelectorAll("[data-part]")) {
    if (!PARTS.set.has(el.dataset.part)) el.remove();
  }
  for (const rail of document.querySelectorAll(".rail")) {
    if (rail.children.length === 0) rail.remove();
  }
  if (PARTS.isSolo) {
    document.body.classList.add("is-solo", `solo-${PARTS.requested[0]}`);
  }
  console.log(`[overlay] Active parts: ${[...PARTS.set].join(", ")}`);
}

/* --------------------------------------------------------------------------
   Small helpers
   -------------------------------------------------------------------------- */

const $ = (id) => document.getElementById(id);

function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Clamp a 0..1 ratio to a 0..100 percentage. */
function pct(value, fallback = 0) {
  const n = num(value, null);
  if (n === null) return fallback;
  return Math.max(0, Math.min(100, Math.round(n * 100)));
}

function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

/** Strip RimWorld's inline markup so it does not leak onto the broadcast. */
function cleanGameText(text) {
  return String(text ?? "")
    .replace(/<color=[^>]*>/gi, "")
    .replace(/<\/color>/gi, "")
    .replace(/\(\*[A-Za-z_=0-9]+\)/g, "")
    .replace(/\(\/[A-Za-z_]+\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* --------------------------------------------------------------------------
   Twitch emotes

   Global emotes are keyed by their exact, case-sensitive name. Anything not in
   this table falls through as plain text, and any image that fails to load is
   swapped back to its text form by the error handler, so a stale or wrong id is
   cosmetically harmless rather than a hole in the message.
   -------------------------------------------------------------------------- */

const EMOTE_IDS = {
  // Explicitly required set
  Kappa: "25",
  PogChamp: "305954156",
  LUL: "425618",
  // Note: id 86 is the long-documented BibleThump id, but it currently returns
  // 404 from the v2 CDN, so this one falls through to its text form. To restore
  // the image, read the live id once from GET /helix/chat/emotes/global.
  BibleThump: "86",
  ResidentSleeper: "245",
  Kreygasm: "41",
  "4Head": "354",
  // Other long-standing globals
  DansGame: "33",
  SwiftRage: "34",
  PJSalt: "36",
  FailFish: "360",
  HeyGuys: "30259",
  VoHiYo: "81274",
  WutFace: "28087",
  TriHard: "120232",
  cmonBruh: "84608",
  SeemsGood: "64138",
  NotLikeThis: "58765",
  BabyRage: "22639",
  // Classic ASCII globals
  ":)": "1",
  ":(": "2",
  ":D": "3",
  ">(": "4",
  ":|": "5",
  "O_o": "6",
  "B)": "7",
  ":O": "8",
  "<3": "9",
  ":/": "10",
  ";)": "11",
  ":P": "12",
  ";P": "13",
  "R)": "14",
};

function emoteUrl(id) {
  return `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`;
}

function makeEmoteNode(name, id) {
  const img = new Image();
  img.className = "emote";
  img.src = emoteUrl(id);
  img.alt = name;
  img.title = name;
  // No network, a blocked CDN, or a retired id: fall back to the literal text.
  img.addEventListener("error", () => {
    if (img.parentNode) img.parentNode.replaceChild(document.createTextNode(name), img);
  });
  return img;
}

/**
 * Build a chat message body as real DOM nodes: emote images, highlighted
 * @mentions, and plain text. Nothing is ever written as HTML, so viewer input
 * cannot inject markup.
 */
function renderMessageBody(text) {
  const frag = document.createDocumentFragment();
  const tokens = String(text ?? "").split(/(\s+)/);

  for (const token of tokens) {
    if (token === "") continue;
    if (/^\s+$/.test(token)) {
      frag.appendChild(document.createTextNode(token));
      continue;
    }

    const emoteId = EMOTE_IDS[token];
    if (emoteId) {
      frag.appendChild(makeEmoteNode(token, emoteId));
      continue;
    }

    const mention = token.match(/^(@[A-Za-z0-9_]{1,25})(.*)$/);
    if (mention) {
      const span = document.createElement("span");
      span.className = "mention";
      span.textContent = mention[1];
      frag.appendChild(span);
      if (mention[2]) frag.appendChild(document.createTextNode(mention[2]));
      continue;
    }

    frag.appendChild(document.createTextNode(token));
  }
  return frag;
}

/* --------------------------------------------------------------------------
   Per-user chat colors, stable across refreshes
   -------------------------------------------------------------------------- */

const USER_COLORS = [
  "#ff7f7f", "#7dd3fc", "#4ade80", "#fbbf24", "#c084fc", "#f472b6",
  "#38bdf8", "#a3e635", "#fb923c", "#22d3ee", "#e879f9", "#facc15",
  "#34d399", "#93c5fd", "#fca5a5", "#d8b4fe",
];

function userColor(username) {
  let hash = 0;
  const name = String(username ?? "");
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length];
}

/* --------------------------------------------------------------------------
   Chat panel
   -------------------------------------------------------------------------- */

const MAX_CHAT_NODES = 14;
const INITIAL_CHAT_NODES = 10;

const chatState = { lastKey: null, primed: false };

function chatKey(m) {
  return `${m.timestamp ?? ""}|${m.username ?? ""}|${m.message ?? ""}`;
}

function buildChatNode(m) {
  const row = document.createElement("div");
  row.className = "chat-msg";

  const username = String(m.username ?? "viewer");
  const message = String(m.message ?? "");

  if (username === "PersonaCore") row.classList.add("is-ai");
  else if (username === "Admin") row.classList.add("is-admin");
  if (message.startsWith("!")) row.classList.add("is-command");

  if (m.timestamp) {
    const time = document.createElement("span");
    time.className = "chat-time";
    // Trim a locale time string down to HH:MM so it stays narrow.
    const match = String(m.timestamp).match(/^(\d{1,2}:\d{2})/);
    time.textContent = match ? match[1] : String(m.timestamp);
    row.appendChild(time);
  }

  const user = document.createElement("span");
  user.className = "chat-user";
  user.textContent = username;
  if (username !== "PersonaCore" && username !== "Admin") {
    user.style.color = userColor(username);
  }
  row.appendChild(user);

  const colon = document.createElement("span");
  colon.className = "chat-colon";
  colon.textContent = ":";
  row.appendChild(colon);

  const body = document.createElement("span");
  body.className = "chat-text";
  body.appendChild(renderMessageBody(message));
  row.appendChild(body);

  return row;
}

function renderChat(events) {
  const feed = $("chat-feed");
  if (!feed) return;

  setText($("chat-channel"), events.twitchConnected ? `#${events.channel || "live"}` : "offline");

  const chat = Array.isArray(events.chat) ? events.chat : [];
  if (chat.length === 0) return;

  const keys = chat.map(chatKey);

  // Work out which messages are genuinely new. The server keeps a rolling
  // window, so the last key we rendered may have already scrolled out of it.
  let startIdx;
  if (!chatState.primed) {
    startIdx = Math.max(0, keys.length - INITIAL_CHAT_NODES);
    chatState.primed = true;
  } else if (chatState.lastKey === null) {
    startIdx = 0;
  } else {
    const found = keys.lastIndexOf(chatState.lastKey);
    startIdx = found >= 0 ? found + 1 : 0;
  }

  if (startIdx === 0 && chatState.lastKey !== null) {
    // The window rolled entirely past us. Rebuild rather than duplicate.
    feed.textContent = "";
  } else {
    const placeholder = feed.querySelector(".empty-note");
    if (placeholder) placeholder.remove();
  }

  for (let i = startIdx; i < chat.length; i += 1) {
    feed.appendChild(buildChatNode(chat[i]));
  }
  chatState.lastKey = keys[keys.length - 1] ?? null;

  while (feed.children.length > MAX_CHAT_NODES) {
    feed.removeChild(feed.firstElementChild);
  }

  feed.scrollTop = feed.scrollHeight;
}

/* --------------------------------------------------------------------------
   Poll panel
   -------------------------------------------------------------------------- */

function renderPoll(events) {
  const list = $("poll-list");
  if (!list) return;

  const poll = events.poll && typeof events.poll === "object" ? events.poll : {};
  const rows = Object.entries(poll)
    .map(([choice, count]) => [choice, num(count, 0)])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);

  const total = rows.reduce((sum, [, count]) => sum + count, 0);
  setText($("poll-total"), total === 1 ? "1 vote" : `${total} votes`);

  if (rows.length === 0) {
    if (!list.querySelector(".empty-note")) {
      list.textContent = "";
      const note = document.createElement("div");
      note.className = "empty-note";
      note.innerHTML = "Type <b>!vote &lt;choice&gt;</b> in chat to open a vote";
      list.appendChild(note);
    }
    return;
  }

  const max = rows[0][1] || 1;
  const signature = rows.map(([c, n]) => `${c}:${n}`).join("|");

  if (list.dataset.signature !== signature) {
    // Rebuild only when the standings actually change, so the bars animate
    // from their previous width instead of restarting every poll tick.
    const existing = new Map();
    for (const row of list.querySelectorAll(".poll-row")) existing.set(row.dataset.choice, row);

    list.textContent = "";
    for (const [choice, count] of rows) {
      let row = existing.get(choice);
      if (!row) {
        row = document.createElement("div");
        row.className = "poll-row";
        row.dataset.choice = choice;
        row.innerHTML =
          '<div class="poll-top"><span class="poll-choice"></span><span class="poll-count"></span></div>' +
          '<div class="bar bar-lg"><div class="bar-fill bar-poll" style="width:0%"></div></div>';
      }
      row.classList.toggle("is-leader", count === max);
      row.querySelector(".poll-choice").textContent = choice;
      row.querySelector(".poll-count").textContent = count === 1 ? "1 vote" : `${count} votes`;
      list.appendChild(row);
      // Set the width after insertion so the transition has a starting value.
      const fill = row.querySelector(".bar-fill");
      requestAnimationFrame(() => {
        fill.style.width = `${Math.round((count / max) * 100)}%`;
      });
    }
    list.dataset.signature = signature;
  }
}

/* --------------------------------------------------------------------------
   Voice indicator
   -------------------------------------------------------------------------- */

function renderVoice(events) {
  const card = $("card-voice");
  if (!card) return;

  const voice = events.voice && typeof events.voice === "object" ? events.voice : {};
  let state = "idle";
  let label = "Voice idle";

  if (voice.speaking) {
    state = "speaking";
    label = "Speaking";
  } else if (voice.synthesizing) {
    state = "synthesizing";
    label = "Composing a line";
  }

  const queued = num(voice.queued, 0);
  if (state === "idle" && queued > 0) {
    state = "synthesizing";
    label = queued === 1 ? "1 line queued" : `${queued} lines queued`;
  }

  if (card.dataset.state !== state) card.dataset.state = state;
  setText($("voice-label"), label);

  const caption = $("voice-caption");
  if (caption) {
    // Only hold the caption up while something is actually being said.
    const show = state !== "idle" && voice.lastText;
    setText(caption, show ? String(voice.lastText) : "");
  }
}

/* --------------------------------------------------------------------------
   AI reasoning feed
   -------------------------------------------------------------------------- */

const MAX_THOUGHTS = 4;

function renderThoughts(events) {
  const feed = $("thought-feed");
  if (!feed) return;

  const brain = events.brain && typeof events.brain === "object" ? events.brain : {};
  const meta = $("brain-meta");
  if (meta) {
    const live = Boolean(brain.llmAvailable);
    meta.classList.toggle("is-off", !live);
    setText(meta, brain.mode ? String(brain.mode) : live ? "live" : "rules");
  }

  const thoughts = Array.isArray(events.thoughts) ? events.thoughts : [];
  if (thoughts.length === 0) return;

  // Newest first, so the latest line is always in view at the top.
  const latest = thoughts.slice(-MAX_THOUGHTS).reverse();
  const signature = latest.join(" ");
  if (feed.dataset.signature === signature) return;
  feed.dataset.signature = signature;

  feed.textContent = "";
  latest.forEach((text, idx) => {
    const row = document.createElement("div");
    row.className = idx === 0 ? "thought is-latest" : "thought";
    row.textContent = cleanGameText(text);
    feed.appendChild(row);
  });
}

/* --------------------------------------------------------------------------
   Colony HUD
   -------------------------------------------------------------------------- */

/** Readable labels for the RimWorld def names that show up most. */
const RESOURCE_LABELS = {
  Steel: "Steel",
  WoodLog: "Wood",
  Silver: "Silver",
  Gold: "Gold",
  Plasteel: "Plasteel",
  Cloth: "Cloth",
  ComponentIndustrial: "Components",
  ComponentSpacer: "Adv components",
  MedicineHerbal: "Herbal meds",
  MedicineIndustrial: "Medicine",
  MedicineUltratech: "Glitterworld",
  MealSimple: "Simple meals",
  MealFine: "Fine meals",
  MealLavish: "Lavish meals",
  MealSurvivalPack: "Packed meals",
  MealNutrientPaste: "Paste meals",
  RawPotatoes: "Potatoes",
  RawRice: "Rice",
  RawCorn: "Corn",
  RawBerries: "Berries",
  Hay: "Hay",
  Pemmican: "Pemmican",
  Chemfuel: "Chemfuel",
  Uranium: "Uranium",
  Jade: "Jade",
  Granite: "Granite blocks",
  Limestone: "Limestone blocks",
};

/** Ordering priority. Anything unlisted lands after these, alphabetically. */
const RESOURCE_PRIORITY = [
  "Steel", "WoodLog", "ComponentIndustrial", "MedicineHerbal", "MedicineIndustrial",
  "MealSimple", "MealFine", "MealSurvivalPack", "Silver", "Cloth", "Plasteel",
];

const MAX_STOCK_ITEMS = 8;

function prettyResourceName(def) {
  if (RESOURCE_LABELS[def]) return RESOURCE_LABELS[def];
  // SomeCamelCaseDef -> "Some camel case def"
  const spaced = String(def).replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function renderStockpile(snap) {
  const grid = $("stock-grid");
  if (!grid) return;

  const resources = snap.resources && typeof snap.resources === "object" ? snap.resources : {};
  const entries = Object.entries(resources).filter(([, v]) => num(v, 0) > 0);

  const nutrition = num(snap.foodNutrition, null);
  setText($("stock-food"), nutrition === null ? "" : `nutrition ${Math.round(nutrition)}`);

  if (entries.length === 0) {
    if (!grid.querySelector(".stock-empty")) {
      grid.textContent = "";
      const note = document.createElement("div");
      note.className = "stock-empty";
      note.textContent = "No stockpile data";
      grid.appendChild(note);
    }
    return;
  }

  entries.sort((a, b) => {
    const ai = RESOURCE_PRIORITY.indexOf(a[0]);
    const bi = RESOURCE_PRIORITY.indexOf(b[0]);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    return a[0].localeCompare(b[0]);
  });

  const shown = entries.slice(0, MAX_STOCK_ITEMS);
  const signature = shown.map(([k, v]) => `${k}:${v}`).join("|");
  if (grid.dataset.signature === signature) return;
  grid.dataset.signature = signature;

  grid.textContent = "";
  for (const [def, amount] of shown) {
    const item = document.createElement("div");
    item.className = "stock-item";
    const label = document.createElement("span");
    label.className = "stock-label";
    label.textContent = prettyResourceName(def);
    const value = document.createElement("span");
    value.className = "stock-value";
    value.textContent = String(Math.round(num(amount, 0)));
    item.append(label, value);
    grid.appendChild(item);
  }
}

function meterRow(label, value, kind, critBelow) {
  const wrap = document.createElement("div");
  wrap.className = "meter";

  const name = document.createElement("span");
  name.className = "meter-label";
  name.textContent = label;

  const bar = document.createElement("div");
  bar.className = "bar";
  const fill = document.createElement("div");
  fill.className = `bar-fill bar-${kind}`;
  fill.style.width = "0%";
  if (value <= critBelow) fill.classList.add("is-crit");
  else if (value <= critBelow + 15) fill.classList.add("is-low");
  bar.appendChild(fill);

  const val = document.createElement("span");
  val.className = "meter-val";
  val.textContent = `${value}%`;

  wrap.append(name, bar, val);
  // Animate from zero on the first paint, then from the previous value after.
  requestAnimationFrame(() => {
    fill.style.width = `${value}%`;
  });
  return wrap;
}

function buildPawnCard(c) {
  const card = document.createElement("div");
  card.className = "pawn";
  if (c.drafted) card.classList.add("is-drafted");

  const top = document.createElement("div");
  top.className = "pawn-top";

  const nameWrap = document.createElement("span");
  const name = document.createElement("span");
  name.className = "pawn-name";
  name.textContent = String(c.name ?? "Colonist");
  nameWrap.appendChild(name);
  if (c.drafted) {
    const flag = document.createElement("span");
    flag.className = "pawn-flag";
    flag.textContent = "DRAFTED";
    nameWrap.appendChild(flag);
  }

  const job = document.createElement("span");
  job.className = "pawn-job";
  const report = cleanGameText(c.job?.report ?? c.job?.def ?? "");
  job.textContent = report || "idle";
  job.title = report;

  top.append(nameWrap, job);
  card.appendChild(top);

  const meters = document.createElement("div");
  meters.className = "pawn-meters";

  const needs = c.needs && typeof c.needs === "object" ? c.needs : {};
  const moodPct = pct(needs.mood, 0);
  // A pawn below its own break threshold is the thing worth flagging red.
  const breakPct = pct(c.moodBreakThreshold, 20);

  meters.append(
    meterRow("HP", pct(c.health?.pct, 100), "hp", 25),
    meterRow("MOOD", moodPct, "mood", breakPct),
    meterRow("FOOD", pct(needs.food, 0), "food", 20),
    meterRow("REST", pct(needs.rest, 0), "rest", 20)
  );
  card.appendChild(meters);
  return card;
}

const MAX_PAWN_CARDS = 6;

function renderColonists(snap) {
  const list = $("colonist-list");
  if (!list) return;

  const colonists = Array.isArray(snap.colonists) ? snap.colonists : [];
  setText($("colonist-count"), String(colonists.length));

  if (colonists.length === 0) {
    if (!list.querySelector(".empty-note")) {
      list.textContent = "";
      const note = document.createElement("div");
      note.className = "empty-note";
      note.textContent = "Waiting for colonist telemetry";
      list.appendChild(note);
    }
    return;
  }

  const shown = colonists.slice(0, MAX_PAWN_CARDS);
  const signature = shown
    .map((c) => [
      c.name, c.drafted, c.job?.report,
      pct(c.health?.pct), pct(c.needs?.mood), pct(c.needs?.food), pct(c.needs?.rest),
    ].join("~"))
    .join("|");

  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;

  list.textContent = "";
  for (const c of shown) list.appendChild(buildPawnCard(c));
}

function renderHud(snap) {
  const bridgeDown = snap.ok === false;

  setText($("colony-name"), snap.colonyName || "Colony");
  setText(
    $("game-date"),
    snap.date || (bridgeDown ? "Colony bridge unreachable" : "Waiting for the colony bridge")
  );
  setText($("game-weather"), snap.weather || "unknown");

  const tempEl = $("game-temp");
  const temp = num(snap.temperatureC, null);
  if (tempEl) {
    setText(tempEl, temp === null ? "" : `${Math.round(temp)}C`);
    tempEl.classList.toggle("is-cold", temp !== null && temp <= 0);
    tempEl.classList.toggle("is-hot", temp !== null && temp >= 30);
  }

  const speedEl = $("game-speed");
  if (speedEl) {
    const paused = Boolean(snap.paused);
    const speed = num(snap.speed, null);
    setText(speedEl, paused ? "PAUSED" : speed === null ? "1x" : `${speed}x`);
    speedEl.classList.toggle("is-paused", paused);
  }

  // Research
  const research = snap.research && typeof snap.research === "object" ? snap.research : null;
  const researchName = research ? research.label || research.project : null;
  setText($("research-name"), researchName ? String(researchName) : "No active project");
  const progress = pct(research?.progress, 0);
  setText($("research-pct"), `${progress}%`);
  const fill = $("research-fill");
  if (fill) fill.style.width = `${progress}%`;

  renderStockpile(snap);
  renderColonists(snap);
}

/* --------------------------------------------------------------------------
   Alert layer

   Events arrive from /api/events as `twitchEvents`: an array of normalized
   objects { type, user, amount, tier, message, at } (optionally with an `id`),
   oldest first. On the first poll every event already present is marked as seen,
   so refreshing the OBS source does not replay the backlog.
   -------------------------------------------------------------------------- */

const ALERT_VISIBLE_MS = 6000;
const ALERT_GAP_MS = 500;
const MAX_ALERT_QUEUE = 12;

const ALERT_STYLE = {
  follow:  { kicker: "New follower", glyph: "✦", color: "#7dd3fc", big: false },
  sub:     { kicker: "New subscriber", glyph: "★", color: "#a970ff", big: true },
  resub:   { kicker: "Resubscribed", glyph: "★", color: "#c084fc", big: true },
  giftsub: { kicker: "Gifted subs", glyph: "♥", color: "#f472b6", big: true },
  cheer:   { kicker: "Bits cheered", glyph: "◆", color: "#fbbf24", big: true },
  raid:    { kicker: "Incoming raid", glyph: "➤", color: "#4ade80", big: true },
  redeem:  { kicker: "Channel points", glyph: "●", color: "#38bdf8", big: false },
  online:  { kicker: "Stream online", glyph: "▶", color: "#4ade80", big: false },
  offline: { kicker: "Stream offline", glyph: "■", color: "#94a3b8", big: false },
};

const alertState = { seen: new Set(), queue: [], showing: false, primed: false };

function alertKey(evt) {
  if (evt && evt.id !== undefined && evt.id !== null) return `id:${evt.id}`;
  return `${evt?.type}|${evt?.user}|${evt?.at}|${evt?.amount}|${evt?.message}`;
}

function ingestAlerts(events) {
  if (!PARTS.set.has("alerts")) return;

  const incoming = Array.isArray(events.twitchEvents)
    ? events.twitchEvents
    : Array.isArray(events.twitchAlerts)
      ? events.twitchAlerts
      : null;
  if (!incoming) return;

  for (const evt of incoming) {
    if (!evt || !evt.type) continue;
    const key = alertKey(evt);
    if (alertState.seen.has(key)) continue;
    alertState.seen.add(key);
    // First poll only records what is already there, it does not play it.
    if (alertState.primed && alertState.queue.length < MAX_ALERT_QUEUE) {
      alertState.queue.push(evt);
    }
  }
  alertState.primed = true;

  // Keep the seen set from growing without bound over a long broadcast.
  if (alertState.seen.size > 600) {
    alertState.seen = new Set([...alertState.seen].slice(-300));
  }

  pumpAlerts();
}

function alertCopy(evt) {
  const style = ALERT_STYLE[evt.type] ?? { kicker: "Alert", glyph: "✦", color: "#7dd3fc", big: false };
  const user = evt.user ? String(evt.user) : "Someone";
  const amount = num(evt.amount, null);
  const tier = evt.tier ? String(evt.tier) : null;

  let headline = user;
  let sub = evt.message ? cleanGameText(evt.message) : "";
  let amountText = null;

  switch (evt.type) {
    case "sub":
      sub = tier && tier !== "1" ? `Tier ${tier} subscription` : "New subscription";
      break;
    case "resub":
      sub = [
        amount ? `${amount} month${amount === 1 ? "" : "s"} running` : null,
        tier && tier !== "1" ? `tier ${tier}` : null,
      ].filter(Boolean).join(", ");
      if (evt.message) sub = sub ? `${sub}. ${cleanGameText(evt.message)}` : cleanGameText(evt.message);
      break;
    case "giftsub":
      amountText = amount ? `x${amount}` : null;
      sub = [
        amount ? `${amount} sub${amount === 1 ? "" : "s"} gifted` : "Gifted a sub",
        tier && tier !== "1" ? `tier ${tier}` : null,
      ].filter(Boolean).join(", ");
      break;
    case "cheer":
      amountText = amount ? String(amount) : null;
      sub = evt.message ? cleanGameText(evt.message) : `${amount ?? ""} bits`.trim();
      break;
    case "raid":
      amountText = amount ? String(amount) : null;
      sub = amount ? `Arriving with ${amount} viewer${amount === 1 ? "" : "s"}` : "Raid incoming";
      break;
    case "redeem":
      sub = evt.message ? cleanGameText(evt.message) : "Redeemed a reward";
      amountText = amount ? String(amount) : null;
      break;
    case "online":
      headline = "We are live";
      sub = user !== "Someone" ? `${user} is broadcasting` : "";
      break;
    case "offline":
      headline = "Stream ended";
      sub = "";
      break;
    default:
      break;
  }

  // A cheer is only "big" once it is worth celebrating.
  const big = evt.type === "cheer" ? (amount ?? 0) >= 100 : style.big;
  return { ...style, big, headline, sub, amountText };
}

function pumpAlerts() {
  if (alertState.showing || alertState.queue.length === 0) return;
  const banner = $("alert-banner");
  if (!banner) return;

  const evt = alertState.queue.shift();
  const copy = alertCopy(evt);
  alertState.showing = true;

  banner.dataset.kind = evt.type;
  banner.classList.toggle("is-big", copy.big);
  setText($("alert-kicker"), copy.kicker);
  setText($("alert-headline"), copy.headline);
  setText($("alert-sub"), copy.sub || "");
  setText($("alert-glyph"), copy.glyph);

  const amountEl = $("alert-amount");
  if (amountEl) {
    if (copy.amountText) {
      amountEl.hidden = false;
      setText(amountEl, copy.amountText);
    } else {
      amountEl.hidden = true;
    }
  }

  banner.hidden = false;
  banner.classList.remove("is-out");
  // Force a reflow so re-running the enter animation actually restarts it.
  banner.classList.remove("is-in");
  void banner.offsetWidth;
  banner.classList.add("is-in");

  if (copy.big) burst(banner, copy.color);

  setTimeout(() => {
    banner.classList.remove("is-in");
    banner.classList.add("is-out");
    setTimeout(() => {
      banner.hidden = true;
      banner.classList.remove("is-out", "is-big");
      alertState.showing = false;
      // Queued alerts never overlap: the next one waits out the gap.
      setTimeout(pumpAlerts, ALERT_GAP_MS);
    }, 440); // matches the alert-out animation
  }, ALERT_VISIBLE_MS);
}

/* --------------------------------------------------------------------------
   Canvas particle burst, no libraries.
   If a 2d context cannot be acquired the banner is marked .no-canvas and the
   CSS-only sparkle fallback in overlay.css takes over instead.
   -------------------------------------------------------------------------- */

/* The canvas is inset by the safe margin and sized to the safe rect, so a
   particle can never be painted in the outer 40px of the broadcast frame. */
const SAFE_PX = 40;
const FX_W = 1920 - SAFE_PX * 2;
const FX_H = 1080 - SAFE_PX * 2;

const fx = { canvas: null, ctx: null, particles: [], running: false, checked: false };

function fxContext() {
  if (fx.checked) return fx.ctx;
  fx.checked = true;
  fx.canvas = $("fx-canvas");
  if (!fx.canvas || typeof fx.canvas.getContext !== "function") {
    console.warn("[overlay] No canvas element. Falling back to the CSS particle effect.");
    return null;
  }
  try {
    fx.ctx = fx.canvas.getContext("2d");
  } catch (err) {
    console.warn(`[overlay] Canvas 2d context unavailable (${err.message}). Using the CSS fallback.`);
    fx.ctx = null;
  }
  if (!fx.ctx) console.warn("[overlay] Canvas 2d context unavailable. Using the CSS fallback.");
  return fx.ctx;
}

function shadeOf(hex, index) {
  // A little variety per particle without hauling in a color library.
  const tints = ["#ffffff", "#ffe9a8", hex, hex, "#dff3ff"];
  return tints[index % tints.length];
}

function burst(banner, color) {
  const ctx = fxContext();
  if (!ctx) {
    banner.classList.add("no-canvas");
    return;
  }
  banner.classList.remove("no-canvas");

  // Viewport coordinates shifted into the canvas' own (safe-rect) space.
  const rect = banner.getBoundingClientRect();
  const originY = rect.top + rect.height / 2 - SAFE_PX;
  const count = 150;

  for (let i = 0; i < count; i += 1) {
    const originX = rect.left + rect.width * (0.12 + Math.random() * 0.76) - SAFE_PX;
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.3;
    const speed = 5 + Math.random() * 12;
    fx.particles.push({
      x: originX,
      y: originY,
      vx: Math.cos(angle) * speed * (0.6 + Math.random() * 0.8),
      vy: Math.sin(angle) * speed,
      size: 4 + Math.random() * 6,
      rot: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 0.34,
      life: 1,
      decay: 0.008 + Math.random() * 0.010,
      color: shadeOf(color, i),
    });
  }

  if (!fx.running) {
    fx.running = true;
    requestAnimationFrame(fxFrame);
  }
}

function fxFrame() {
  const ctx = fx.ctx;
  if (!ctx) {
    fx.running = false;
    return;
  }

  ctx.clearRect(0, 0, FX_W, FX_H);

  for (let i = fx.particles.length - 1; i >= 0; i -= 1) {
    const p = fx.particles[i];
    p.vy += 0.34;      // gravity
    p.vx *= 0.992;     // drag
    p.x += p.vx;
    p.y += p.vy;
    p.rot += p.spin;
    p.life -= p.decay;

    if (p.life <= 0 || p.y > FX_H + 40) {
      fx.particles.splice(i, 1);
      continue;
    }

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
    ctx.restore();
  }

  if (fx.particles.length > 0) {
    requestAnimationFrame(fxFrame);
  } else {
    ctx.clearRect(0, 0, FX_W, FX_H);
    fx.running = false;
  }
}

/* --------------------------------------------------------------------------
   Polling
   -------------------------------------------------------------------------- */

const needsEvents =
  PARTS.set.has("chat") || PARTS.set.has("poll") || PARTS.set.has("alerts") ||
  PARTS.set.has("voice") || PARTS.set.has("hud");
const needsSnapshot = PARTS.set.has("hud");

let eventsFailures = 0;
let snapshotFailures = 0;

async function getJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function tickEvents() {
  if (!needsEvents) return;
  try {
    const data = await getJson("/api/events");
    eventsFailures = 0;
    if (PARTS.set.has("chat")) renderChat(data);
    if (PARTS.set.has("poll")) renderPoll(data);
    if (PARTS.set.has("voice")) renderVoice(data);
    if (PARTS.set.has("hud")) renderThoughts(data);
    ingestAlerts(data);
  } catch (err) {
    eventsFailures += 1;
    if (eventsFailures === 1 || eventsFailures % 20 === 0) {
      console.warn(`[overlay] /api/events unreachable (${eventsFailures} in a row): ${err.message}`);
    }
  }
}

async function tickSnapshot() {
  if (!needsSnapshot) return;
  try {
    const data = await getJson("/api/snapshot");
    snapshotFailures = 0;
    renderHud(data && typeof data === "object" ? data : { ok: false });
  } catch (err) {
    snapshotFailures += 1;
    if (snapshotFailures === 1 || snapshotFailures % 20 === 0) {
      console.warn(`[overlay] /api/snapshot unreachable (${snapshotFailures} in a row): ${err.message}`);
    }
    // Keep the last good values on screen rather than blanking the HUD.
  }
}

function start() {
  applyParts();
  tickEvents();
  tickSnapshot();
  setInterval(tickEvents, POLL_MS);
  setInterval(tickSnapshot, POLL_MS);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
