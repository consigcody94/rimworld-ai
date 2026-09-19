/**
 * Twitch EventSub WebSocket Client
 *
 * Subscribes to real Twitch alert events (follows, subs, gifts, resubs, cheers,
 * raids, channel point redemptions, stream online/offline) over the EventSub
 * WebSocket transport and hands normalized event objects to a callback.
 *
 * Design notes
 *   - Zero dependencies beyond Node built-ins. `WebSocket` is global from Node 22
 *     onward; older runtimes fall back to a lazy `import("ws")`.
 *   - Every subscription is attempted independently. A missing OAuth scope fails
 *     exactly one subscription, is recorded in `status.failed` with the reason and
 *     the scope it needs, and never prevents the others from working.
 *   - `session_reconnect` is handled by opening the new socket first and only
 *     tearing down the old one once the replacement has been welcomed, so no
 *     events are dropped mid-swap. Subscriptions carry over automatically on a
 *     reconnect URL, so they are not re-created.
 *
 * Normalized event shape handed to onEvent():
 *   { type, user, amount, tier, message, at }
 *   type is one of: follow | sub | resub | giftsub | cheer | raid | redeem | online | offline
 */

const EVENTSUB_WS_URL = "wss://eventsub.wss.twitch.tv/ws";
const HELIX_SUBSCRIPTIONS_URL = "https://api.twitch.tv/helix/eventsub/subscriptions";
const VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";

/** Every OAuth scope the subscriptions below need. Request these on the /auth/twitch page. */
export const EVENTSUB_SCOPES = [
  "moderator:read:followers",
  "channel:read:subscriptions",
  "bits:read",
  "channel:read:redemptions",
];

/**
 * The subscription plan. `scope` is the OAuth scope Twitch requires for that
 * topic (null when the topic needs no scope), used both for up-front reporting
 * and for explaining a 403.
 */
const SUBSCRIPTION_PLAN = [
  {
    type: "channel.follow",
    version: "2",
    scope: "moderator:read:followers",
    condition: (id) => ({ broadcaster_user_id: id, moderator_user_id: id }),
  },
  {
    type: "channel.subscribe",
    version: "1",
    scope: "channel:read:subscriptions",
    condition: (id) => ({ broadcaster_user_id: id }),
  },
  {
    type: "channel.subscription.gift",
    version: "1",
    scope: "channel:read:subscriptions",
    condition: (id) => ({ broadcaster_user_id: id }),
  },
  {
    type: "channel.subscription.message",
    version: "1",
    scope: "channel:read:subscriptions",
    condition: (id) => ({ broadcaster_user_id: id }),
  },
  {
    type: "channel.cheer",
    version: "1",
    scope: "bits:read",
    condition: (id) => ({ broadcaster_user_id: id }),
  },
  {
    type: "channel.raid",
    version: "1",
    scope: null,
    condition: (id) => ({ to_broadcaster_user_id: id }),
  },
  {
    type: "channel.channel_points_custom_reward_redemption.add",
    version: "1",
    scope: "channel:read:redemptions",
    condition: (id) => ({ broadcaster_user_id: id }),
  },
  { type: "stream.online", version: "1", scope: null, condition: (id) => ({ broadcaster_user_id: id }) },
  { type: "stream.offline", version: "1", scope: null, condition: (id) => ({ broadcaster_user_id: id }) },
];

/** Resolve a WebSocket constructor: global first (Node 22+), then lazy `ws`. */
async function resolveWebSocket() {
  if (typeof globalThis.WebSocket === "function") {
    return { Ctor: globalThis.WebSocket, source: "global" };
  }
  try {
    const mod = await import("ws");
    const Ctor = mod?.default ?? mod?.WebSocket;
    if (typeof Ctor === "function") return { Ctor, source: "ws-module" };
    throw new Error("the 'ws' module did not export a WebSocket constructor");
  } catch (err) {
    return {
      Ctor: null,
      source: "none",
      error:
        `No WebSocket implementation available. This Node (${process.version}) has no global ` +
        `WebSocket and 'ws' could not be imported (${err.message}). ` +
        `Upgrade to Node 22 or newer, or run: npm install ws`,
    };
  }
}

/** 1000 -> "1", 2000 -> "2", 3000 -> "3", "Prime" -> "Prime". */
function normalizeTier(tier) {
  if (tier === undefined || tier === null || tier === "") return null;
  const raw = String(tier);
  if (/^\d{4}$/.test(raw)) return String(Math.max(1, Math.floor(parseInt(raw, 10) / 1000)));
  return raw;
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export class TwitchEventSub {
  /**
   * @param {object} options
   * @param {string} options.clientId      Twitch application client id
   * @param {string} options.token         user access token (with or without the "oauth:" prefix)
   * @param {string} options.broadcasterId numeric Twitch user id of the channel
   * @param {(evt: object) => void} options.onEvent callback for normalized events
   */
  constructor({ clientId, token, broadcasterId, onEvent } = {}) {
    this.clientId = clientId ?? "";
    this.token = (token ?? "").replace(/^oauth:/i, "");
    this.broadcasterId = broadcasterId ? String(broadcasterId) : "";
    this.onEvent = typeof onEvent === "function" ? onEvent : () => {};

    this.ws = null;
    this.pendingWs = null; // replacement socket during a session_reconnect
    this.sessionId = null;
    this.closedByUser = false;

    this.keepaliveTimeoutSec = 10;
    this.keepaliveTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;

    /** Live status, safe to serialize straight into an API response. */
    this.status = {
      connected: false,
      subscribed: [],       // [{ type, version, id }]
      failed: [],           // [{ type, version, scope, reason, status }]
      revoked: [],          // [{ type, reason, at }]
      lastError: null,
      lastEventAt: null,
      sessionId: null,
      grantedScopes: null,  // null until the token is validated
      missingScopes: [],
      reconnects: 0,
      wsImplementation: null,
      lastKeepaliveAt: null,
    };
  }

  /** Human-readable one-liner for logs and the dashboard. */
  get summary() {
    const ok = this.status.subscribed.length;
    const bad = this.status.failed.length;
    return `${this.status.connected ? "connected" : "disconnected"}, ${ok} subscribed, ${bad} failed`;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  async connect() {
    if (!this.clientId || !this.token || !this.broadcasterId) {
      this.status.lastError =
        "EventSub needs a client id, a user access token and a broadcaster id. Open /auth/twitch to authorize.";
      console.warn(`[EventSub] ${this.status.lastError}`);
      return false;
    }

    const { Ctor, source, error } = await resolveWebSocket();
    this.status.wsImplementation = source;
    if (!Ctor) {
      this.status.lastError = error;
      console.error(`[EventSub] ${error}`);
      return false;
    }
    this.WebSocketCtor = Ctor;
    this.closedByUser = false;

    await this.validateToken();
    this.openSocket(EVENTSUB_WS_URL, false);
    return true;
  }

  disconnect() {
    this.closedByUser = true;
    this.clearTimer("keepaliveTimer");
    this.clearTimer("reconnectTimer");
    for (const key of ["pendingWs", "ws"]) {
      const sock = this[key];
      if (sock) {
        try {
          sock.onclose = null;
          sock.close();
        } catch {}
      }
      this[key] = null;
    }
    this.sessionId = null;
    this.status.connected = false;
    this.status.sessionId = null;
    console.log("[EventSub] Disconnected by request.");
  }

  // --------------------------------------------------------------------------
  // Token validation, purely so we can report missing scopes up front
  // --------------------------------------------------------------------------

  async validateToken() {
    try {
      const res = await fetch(VALIDATE_URL, {
        headers: { Authorization: `OAuth ${this.token}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        this.status.lastError = `Token validation failed (HTTP ${res.status}). The token may be expired; re-authorize at /auth/twitch.`;
        console.warn(`[EventSub] ${this.status.lastError}`);
        return;
      }
      const data = await res.json();
      const granted = Array.isArray(data.scopes) ? data.scopes : [];
      this.status.grantedScopes = granted;
      this.status.missingScopes = EVENTSUB_SCOPES.filter((s) => !granted.includes(s));

      if (this.status.missingScopes.length === 0) {
        console.log(`[EventSub] Token has every scope EventSub needs (${EVENTSUB_SCOPES.join(", ")}).`);
      } else {
        console.warn(`[EventSub] Token is missing ${this.status.missingScopes.length} scope(s):`);
        for (const scope of this.status.missingScopes) {
          const topics = SUBSCRIPTION_PLAN.filter((p) => p.scope === scope).map((p) => p.type);
          console.warn(`[EventSub]   ${scope} -> needed by: ${topics.join(", ")}`);
        }
        console.warn(
          "[EventSub] Re-authorize at /auth/twitch to request them. Everything else will still work."
        );
      }
    } catch (err) {
      this.status.lastError = `Token validation error: ${err.message}`;
      console.warn(`[EventSub] ${this.status.lastError}`);
    }
  }

  // --------------------------------------------------------------------------
  // Socket plumbing
  // --------------------------------------------------------------------------

  /**
   * @param {string} url
   * @param {boolean} isReconnect true when this socket comes from a
   *   session_reconnect: it replaces the live socket only once welcomed, and its
   *   subscriptions are inherited rather than re-created.
   */
  openSocket(url, isReconnect) {
    let sock;
    try {
      sock = new this.WebSocketCtor(url);
    } catch (err) {
      this.status.lastError = `Could not open EventSub socket: ${err.message}`;
      console.error(`[EventSub] ${this.status.lastError}`);
      this.scheduleReconnect();
      return;
    }

    if (isReconnect) this.pendingWs = sock;
    else this.ws = sock;

    sock.onopen = () => {
      console.log(`[EventSub] Socket open (${isReconnect ? "reconnect" : "initial"}): ${url}`);
    };

    sock.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
      } catch (err) {
        console.warn(`[EventSub] Unparseable frame: ${err.message}`);
        return;
      }
      this.handleMessage(msg, sock, isReconnect).catch((err) => {
        this.status.lastError = err.message;
        console.error(`[EventSub] Message handler error: ${err.message}`);
      });
    };

    sock.onerror = (err) => {
      const message = err?.message ?? String(err?.error ?? err ?? "unknown socket error");
      this.status.lastError = `Socket error: ${message}`;
      console.error(`[EventSub] ${this.status.lastError}`);
    };

    sock.onclose = (ev) => {
      // A pending reconnect socket dying is not fatal: the live socket is still up.
      if (isReconnect && this.pendingWs === sock) {
        this.pendingWs = null;
        console.warn("[EventSub] Reconnect socket closed before it was welcomed; keeping the current session.");
        return;
      }
      if (sock !== this.ws) return; // superseded socket finishing its teardown

      this.ws = null;
      this.sessionId = null;
      this.status.connected = false;
      this.status.sessionId = null;
      this.clearTimer("keepaliveTimer");

      if (this.closedByUser) return;
      const code = ev?.code ?? "n/a";
      console.warn(`[EventSub] Connection closed (code ${code}). Reconnecting.`);
      this.scheduleReconnect();
    };
  }

  async handleMessage(msg, sock, isReconnect) {
    const messageType = msg?.metadata?.message_type;
    if (!messageType) return;

    switch (messageType) {
      case "session_welcome": {
        const session = msg.payload?.session ?? {};
        const keepalive = toInt(session.keepalive_timeout_seconds);
        if (keepalive) this.keepaliveTimeoutSec = keepalive;

        if (isReconnect) {
          // Promote the replacement socket, then retire the old one. Twitch keeps
          // the subscriptions alive across a reconnect URL, so do not re-create them.
          const old = this.ws;
          this.ws = sock;
          this.pendingWs = null;
          sock.onclose = this.makeCloseHandler(sock);
          if (old && old !== sock) {
            try {
              old.onclose = null;
              old.close();
            } catch {}
          }
          this.sessionId = session.id ?? null;
          this.status.sessionId = this.sessionId;
          this.status.connected = true;
          this.status.reconnects += 1;
          this.reconnectAttempts = 0;
          console.log(`[EventSub] Reconnected cleanly, session ${this.sessionId}. Subscriptions carried over.`);
          this.armKeepaliveWatchdog();
          return;
        }

        this.sessionId = session.id ?? null;
        this.status.sessionId = this.sessionId;
        this.status.connected = true;
        this.reconnectAttempts = 0;
        console.log(`[EventSub] Welcomed, session ${this.sessionId}. Creating subscriptions.`);
        this.armKeepaliveWatchdog();
        await this.subscribeAll();
        return;
      }

      case "session_keepalive": {
        this.status.lastKeepaliveAt = Date.now();
        this.armKeepaliveWatchdog();
        return;
      }

      case "session_reconnect": {
        const reconnectUrl = msg.payload?.session?.reconnect_url;
        if (!reconnectUrl) {
          console.warn("[EventSub] session_reconnect arrived with no reconnect_url; waiting for close.");
          return;
        }
        console.log("[EventSub] Server asked for a reconnect. Opening the replacement socket.");
        this.openSocket(reconnectUrl, true);
        return;
      }

      case "notification": {
        this.armKeepaliveWatchdog();
        this.status.lastEventAt = Date.now();
        const subType = msg.payload?.subscription?.type ?? msg.metadata?.subscription_type;
        const normalized = this.normalize(subType, msg.payload?.event ?? {});
        if (!normalized) {
          console.log(`[EventSub] Ignoring unmapped notification type: ${subType}`);
          return;
        }
        console.log(
          `[EventSub] ${normalized.type} from ${normalized.user ?? "unknown"}` +
            (normalized.amount != null ? ` (${normalized.amount})` : "")
        );
        try {
          this.onEvent(normalized);
        } catch (err) {
          console.error(`[EventSub] onEvent callback threw: ${err.message}`);
        }
        return;
      }

      case "revocation": {
        const sub = msg.payload?.subscription ?? {};
        const entry = { type: sub.type ?? "unknown", reason: sub.status ?? "revoked", at: Date.now() };
        this.status.revoked.push(entry);
        this.status.subscribed = this.status.subscribed.filter((s) => s.type !== entry.type);
        this.status.lastError = `Subscription revoked: ${entry.type} (${entry.reason})`;
        console.warn(
          `[EventSub] ${this.status.lastError}. Usual causes: the token was revoked, ` +
            `the scope was removed, or the app lost access. Re-authorize at /auth/twitch.`
        );
        return;
      }

      default:
        return;
    }
  }

  /** Rebuilds the close handler for a socket promoted out of the reconnect path. */
  makeCloseHandler(sock) {
    return (ev) => {
      if (sock !== this.ws) return;
      this.ws = null;
      this.sessionId = null;
      this.status.connected = false;
      this.status.sessionId = null;
      this.clearTimer("keepaliveTimer");
      if (this.closedByUser) return;
      console.warn(`[EventSub] Connection closed (code ${ev?.code ?? "n/a"}). Reconnecting.`);
      this.scheduleReconnect();
    };
  }

  // --------------------------------------------------------------------------
  // Subscriptions
  // --------------------------------------------------------------------------

  async subscribeAll() {
    this.status.subscribed = [];
    this.status.failed = [];

    for (const plan of SUBSCRIPTION_PLAN) {
      await this.subscribeOne(plan);
    }

    const ok = this.status.subscribed.length;
    const bad = this.status.failed.length;
    console.log(`[EventSub] Subscriptions ready: ${ok} active, ${bad} failed.`);
    if (bad > 0) {
      for (const f of this.status.failed) {
        const needs = f.scope ? ` (needs scope ${f.scope})` : "";
        console.warn(`[EventSub]   FAILED ${f.type}${needs}: ${f.reason}`);
      }
    }
  }

  async subscribeOne(plan) {
    if (!this.sessionId) {
      this.status.failed.push({
        type: plan.type,
        version: plan.version,
        scope: plan.scope,
        reason: "no active EventSub session id",
        status: null,
      });
      return;
    }

    const body = {
      type: plan.type,
      version: plan.version,
      condition: plan.condition(this.broadcasterId),
      transport: { method: "websocket", session_id: this.sessionId },
    };

    try {
      const res = await fetch(HELIX_SUBSCRIPTIONS_URL, {
        method: "POST",
        headers: {
          "Client-Id": this.clientId,
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok) {
        const data = await res.json();
        const id = data?.data?.[0]?.id ?? null;
        this.status.subscribed.push({ type: plan.type, version: plan.version, id });
        return;
      }

      const text = await res.text();
      this.status.failed.push({
        type: plan.type,
        version: plan.version,
        scope: plan.scope,
        reason: this.explainFailure(res.status, text, plan),
        status: res.status,
      });
    } catch (err) {
      this.status.failed.push({
        type: plan.type,
        version: plan.version,
        scope: plan.scope,
        reason: `request failed: ${err.message}`,
        status: null,
      });
    }
  }

  /** Turn a Helix error into something an operator can act on. */
  explainFailure(httpStatus, rawBody, plan) {
    let detail = rawBody;
    try {
      const parsed = JSON.parse(rawBody);
      detail = parsed.message || parsed.error || rawBody;
    } catch {}
    detail = String(detail).slice(0, 300);

    if (httpStatus === 401) {
      return `HTTP 401: the access token is invalid or expired. Re-authorize at /auth/twitch. (${detail})`;
    }
    if (httpStatus === 403) {
      return plan.scope
        ? `HTTP 403: the token is missing the ${plan.scope} scope. Re-authorize at /auth/twitch. (${detail})`
        : `HTTP 403: the token is not allowed to subscribe to ${plan.type}. (${detail})`;
    }
    if (httpStatus === 409) return `HTTP 409: a subscription for ${plan.type} already exists. (${detail})`;
    if (httpStatus === 429) return `HTTP 429: EventSub subscription rate limit reached. (${detail})`;
    return `HTTP ${httpStatus}: ${detail}`;
  }

  // --------------------------------------------------------------------------
  // Normalization
  // --------------------------------------------------------------------------

  /** Map a raw EventSub payload onto { type, user, amount, tier, message, at }. */
  normalize(subscriptionType, e) {
    const at = Date.now();
    const base = { type: null, user: null, amount: null, tier: null, message: null, at };

    switch (subscriptionType) {
      case "channel.follow":
        return { ...base, type: "follow", user: e.user_name || e.user_login || null };

      case "channel.subscribe":
        return {
          ...base,
          type: "sub",
          user: e.user_name || e.user_login || null,
          tier: normalizeTier(e.tier),
          amount: 1,
          message: e.is_gift ? "gifted subscription" : null,
        };

      case "channel.subscription.message":
        return {
          ...base,
          type: "resub",
          user: e.user_name || e.user_login || null,
          tier: normalizeTier(e.tier),
          amount: toInt(e.cumulative_months) ?? toInt(e.duration_months) ?? 1,
          message: e.message?.text ?? null,
        };

      case "channel.subscription.gift":
        return {
          ...base,
          type: "giftsub",
          user: e.is_anonymous ? "Anonymous" : e.user_name || e.user_login || "Anonymous",
          tier: normalizeTier(e.tier),
          amount: toInt(e.total) ?? 1,
          message:
            toInt(e.cumulative_total) != null ? `${e.cumulative_total} gifted in total` : null,
        };

      case "channel.cheer":
        return {
          ...base,
          type: "cheer",
          user: e.is_anonymous ? "Anonymous" : e.user_name || e.user_login || "Anonymous",
          amount: toInt(e.bits),
          message: e.message ?? null,
        };

      case "channel.raid":
        return {
          ...base,
          type: "raid",
          user: e.from_broadcaster_user_name || e.from_broadcaster_user_login || null,
          amount: toInt(e.viewers),
        };

      case "channel.channel_points_custom_reward_redemption.add":
        return {
          ...base,
          type: "redeem",
          user: e.user_name || e.user_login || null,
          amount: toInt(e.reward?.cost),
          message: [e.reward?.title, e.user_input].filter(Boolean).join(": ") || null,
        };

      case "stream.online":
        return { ...base, type: "online", user: e.broadcaster_user_name || null };

      case "stream.offline":
        return { ...base, type: "offline", user: e.broadcaster_user_name || null };

      default:
        return null;
    }
  }

  // --------------------------------------------------------------------------
  // Timers
  // --------------------------------------------------------------------------

  clearTimer(name) {
    if (this[name]) {
      clearTimeout(this[name]);
      this[name] = null;
    }
  }

  /** If Twitch goes quiet for well past the keepalive window, force a reconnect. */
  armKeepaliveWatchdog() {
    this.clearTimer("keepaliveTimer");
    const windowMs = (this.keepaliveTimeoutSec + 5) * 1000 * 2;
    this.keepaliveTimer = setTimeout(() => {
      this.keepaliveTimer = null;
      if (this.closedByUser) return;
      this.status.lastError = `No keepalive for ${Math.round(windowMs / 1000)}s; forcing a reconnect.`;
      console.warn(`[EventSub] ${this.status.lastError}`);
      const sock = this.ws;
      this.ws = null;
      this.status.connected = false;
      if (sock) {
        try {
          sock.onclose = null;
          sock.close();
        } catch {}
      }
      this.scheduleReconnect();
    }, windowMs);
  }

  scheduleReconnect() {
    if (this.closedByUser || this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.reconnectAttempts - 1, 5));
    console.log(`[EventSub] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}).`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closedByUser) return;
      this.openSocket(EVENTSUB_WS_URL, false);
    }, delay);
  }
}
