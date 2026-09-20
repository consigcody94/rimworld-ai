/**
 * Twitch Chat Integration Engine
 * Connects to Twitch IRC via WebSocket and bridges viewer commands to the RimWorld AI Bridge.
 * Supports authenticated two-way bot mode and anonymous listener mode (justinfan).
 */

export class TwitchChatEngine {
  constructor(options = {}) {
    this.channel = (options.channel ?? "").replace(/^#/, "").toLowerCase();
    this.botUsername = options.botUsername ?? "";
    this.oauthToken = options.oauthToken ?? "";
    this.bridgeUrl = (options.bridgeUrl ?? "http://127.0.0.1:18800").replace(/\/$/, "");
    this.voiceEngine = options.voiceEngine ?? null;
    this.chatBrain = options.chatBrain ?? null;
    this.ws = null;
    this.connected = false;
    this.isAuthenticated = false;
    this.listeners = new Set();
    this.chatHistory = [];
    this.votes = new Map(); // poll choices: Map<choice, Set<user>>
    this.reconnectTimer = null;
  }

  onMessage(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  broadcastEvent(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[TwitchChat] Listener error:", err.message);
      }
    }
  }

  async callBridge(method, path, body = null) {
    const url = `${this.bridgeUrl}${path}`;
    const opts = {
      method,
      headers: { "Content-Type": "application/json", "X-Agent-Id": process.env.RIMWORLD_AGENT_ID || "colony-agent" },
      signal: AbortSignal.timeout(10000),
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    return res.json();
  }

  connect() {
    if (!this.channel) {
      console.log("[TwitchChat] No channel specified. Standing by.");
      return;
    }

    // Detach the old socket's handlers first, or closing it to replace it fires onclose and
    // schedules another connect, which loops forever once the channel is saved.
    clearTimeout(this.reconnectTimer);
    this.retireSocket();

    const wsUrl = "wss://irc-ws.chat.twitch.tv:443";
    console.log(`[TwitchChat] Connecting to ${wsUrl} for channel #${this.channel}...`);
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.authError = null;
      const pass = this.oauthToken ? (this.oauthToken.startsWith("oauth:") ? this.oauthToken : `oauth:${this.oauthToken}`) : "SCHMOOPIE";
      const nick = this.botUsername || `justinfan${Math.floor(10000 + Math.random() * 90000)}`;
      this.isAuthenticated = Boolean(this.oauthToken && this.botUsername);

      this.send(`PASS ${String(pass).replace(/[\r\n\0]/g, "")}`);
      this.send(`NICK ${String(nick).replace(/[\r\n\0]/g, "")}`);
      this.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      this.send(`JOIN #${String(this.channel).replace(/[\r\n\0 ]/g, "")}`);

      console.log(`[TwitchChat] Joined #${this.channel} as ${nick} (authenticated: ${this.isAuthenticated})`);
      this.broadcastEvent({ type: "connection", connected: true, authenticated: this.isAuthenticated, channel: this.channel });
    };

    this.ws.onmessage = (event) => {
      const raw = event.data.toString();
      for (const line of raw.split("\r\n")) {
        if (!line) continue;
        // Never await here: an unhandled rejection from a chat line would end the broadcast.
        this.handleIrcLine(line).catch((e) => console.warn(`[TwitchChat] line failed: ${e.message}`));
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.broadcastEvent({ type: "connection", connected: false, channel: this.channel });
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error("[TwitchChat] WebSocket error:", err.message ?? err);
    };
  }

  /** Detach handlers before closing, so replacing a socket cannot trigger the reconnect path. */
  retireSocket() {
    if (!this.ws) return;
    try {
      this.ws.onopen = this.ws.onmessage = this.ws.onerror = this.ws.onclose = null;
      this.ws.close();
    } catch {}
    this.ws = null;
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectAttempts = (this.reconnectAttempts ?? 0) + 1;
    const delay = Math.min(60000, 2000 * 2 ** Math.min(this.reconnectAttempts - 1, 5));
    console.log(`[TwitchChat] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts}).`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  disconnect() {
    clearTimeout(this.reconnectTimer);
    this.retireSocket();
    this.connected = false;
  }

  /** Raw frame write. Never call this with untrusted text; use sendChat. */
  send(line) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(`${line}\r\n`);
      return true;
    } catch (e) {
      console.warn(`[TwitchChat] send failed: ${e.message}`);
      return false;
    }
  }

  /**
   * Post to chat. Strips CR, LF and NUL so no caller can terminate the IRC line and issue
   * commands as the bot, caps the length at Twitch's limit, and rate limits to stay under the
   * 20 messages per 30 seconds that would otherwise get the account muted mid-broadcast.
   */
  sendChat(message) {
    const clean = String(message ?? "").replace(/[\r\n\0]+/g, " ").trim().slice(0, 450);
    if (!clean || !this.channel) return false;

    const now = Date.now();
    this.sendTimes = (this.sendTimes ?? []).filter((t) => now - t < 30000);
    if (this.sendTimes.length >= 18) {
      this.dropped = (this.dropped ?? 0) + 1;
      console.warn(`[TwitchChat] Rate limit reached; dropped a message (${this.dropped} total).`);
      return false;
    }

    if (!this.connected || !this.isAuthenticated) {
      console.log(`[TwitchChat (not authenticated, would have said)]: ${clean}`);
      return false;
    }
    if (!this.send(`PRIVMSG #${this.channel} :${clean}`)) return false;
    this.sendTimes.push(now);
    return true;
  }

  async handleIrcLine(line) {
    if (line.startsWith("PING")) {
      this.send("PONG :tmi.twitch.tv");
      return;
    }

    // Twitch asks clients to reconnect periodically; treat it as a normal reconnect.
    if (/^(:\S+ )?RECONNECT\b/.test(line)) {
      console.log("[TwitchChat] Server asked us to reconnect.");
      this.scheduleReconnect();
      return;
    }

    // A failed login arrives as a NOTICE, not a close. Without this the client looks connected
    // forever while every message it sends is silently dropped.
    const notice = line.match(/^(?:@\S+ )?:tmi\.twitch\.tv NOTICE \S+ :(.+)$/);
    if (notice) {
      const text = notice[1];
      if (/login authentication failed|improperly formatted auth/i.test(text)) {
        this.authError = text;
        this.isAuthenticated = false;
        console.warn(`[TwitchChat] Authentication rejected: ${text}. Falling back to read-only.`);
      } else {
        console.log(`[TwitchChat] NOTICE: ${text}`);
      }
      return;
    }

    if (!line.includes("PRIVMSG")) return;

    // Twitch prefixes every line with IRCv3 tags once twitch.tv/tags is acknowledged, so the
    // leading "@tag=value;..." group is optional but must be tolerated. Without it, no real
    // viewer message ever matches.
    const match = line.match(/^(?:@(\S+) )?:([^!]+)![^ ]+ PRIVMSG #[^ ]+ :(.*)$/);
    if (!match) return;

    const tags = match[1] ? Object.fromEntries(match[1].split(";").map((kv) => {
      const i = kv.indexOf("=");
      return i < 0 ? [kv, ""] : [kv.slice(0, i), kv.slice(i + 1)];
    })) : {};
    const username = tags["display-name"]?.trim() || match[2];
    const message = match[3].trim();
    if (!message) return;

    const chatMsg = {
      username,
      message,
      timestamp: new Date().toLocaleTimeString(),
    };

    this.chatHistory.push(chatMsg);
    if (this.chatHistory.length > 50) this.chatHistory.shift();
    if (this.chatBrain?.noteChat) this.chatBrain.noteChat(username, message);

    this.broadcastEvent({ type: "chat", ...chatMsg });

    // Display viewer chat directly inside RimWorld in-game HUD
    try {
      await this.callBridge("POST", "/chat/push", { user: username, text: message, color: tags.color || undefined });
    } catch {}
    try {
      await this.callBridge("POST", "/notify", { text: `[Twitch] ${username}: ${message.slice(0, 75)}`, type: "neutral" });
    } catch {}

    if (message.startsWith("!")) {
      await this.handleCommand(username, message);
    } else {
      await this.respondConversationally(username, message, false);
    }
  }

  async respondConversationally(username, message, force) {
    if (!this.chatBrain) return;
    let response = null;
    try {
      response = await this.chatBrain.reply(username, message, { force });
    } catch (e) {
      console.warn("[TwitchChat] reply failed:", e.message);
    }
    if (!response) return;
    this.sendChat(response);
    this.chatHistory.push({ username: "PersonaCore", message: response, timestamp: new Date().toLocaleTimeString() });
    if (this.chatHistory.length > 50) this.chatHistory.shift();
    this.broadcastEvent({ type: "reply", username: "PersonaCore", message: response, timestamp: new Date().toLocaleTimeString() });
    try { await this.callBridge("POST", "/chat/push", { user: "PersonaCore", text: response.slice(0, 140), color: "#7DD3FC" }); } catch {}
    if (this.voiceEngine?.enabled) this.voiceEngine.speak(response, { force: true });
  }

  async handleCommand(username, message) {
    const parts = message.slice(1).split(" ");
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(" ").trim();

    try {
      switch (cmd) {
        case "help":
        case "commands": {
          const text = `Available commands: !ask <question>, !status, !colonists, !pawn <name>, !research, !resources, !say <message>, !vote <tech>, !poll`;
          this.sendChat(text);
          break;
        }

        case "ask": {
          if (!args) {
            this.sendChat(`Usage: !ask <question for the AI>`);
            return;
          }
          await this.respondConversationally(username, args, true);
          break;
        }

        case "status": {
          const snap = await this.callBridge("GET", "/snapshot");
          const reply = `[RimWorld AI] ${snap.colonyName ?? "Colony"} | Date: ${snap.date} (${snap.weather}, ${Math.round(snap.temperatureC)}C) | Speed: ${snap.speed}x | Colonists: ${snap.colonists?.length ?? 0} | DevMode: OFF`;
          this.sendChat(reply);
          break;
        }

        case "colonists": {
          const snap = await this.callBridge("GET", "/snapshot");
          const list = (snap.colonists ?? [])
            .map((c) => `${c.name} (HP ${Math.round((c.health?.pct ?? 1) * 100)}%, Mood ${Math.round((c.needs?.mood ?? 1) * 100)}%, Job: ${c.job?.report ?? "idle"})`)
            .join(" | ");
          this.sendChat(`[Colonists] ${list}`.slice(0, 480));
          break;
        }

        case "pawn": {
          if (!args) {
            this.sendChat(`Usage: !pawn <name>`);
            return;
          }
          let p = null;
          let pawnsRes = { pawns: [] };
          try {
            p = await this.callBridge("GET", `/pawn/${encodeURIComponent(args)}`);
          } catch {}
          if (!p || p.ok === false || !p.name) {
            pawnsRes = await this.callBridge("GET", "/pawns?detail=true");
            p = (pawnsRes.pawns ?? []).find(
              (x) => x.name?.toLowerCase() === args.toLowerCase() || String(x.id) === args
            );
          }
          if (!p) {
            const names = (pawnsRes.pawns ?? []).map((x) => x.name).join(", ");
            this.sendChat(`Colonist "${args}" not found. Active colonists: ${names || "none"}`);
            return;
          }
          const skills = Object.entries(p.skills ?? {})
            .map(([k, v]) => `${k}: ${v}`)
            .slice(0, 5)
            .join(", ");
          this.sendChat(`[Pawn ${p.name}] Gender: ${p.gender}, Age: ${p.age} | HP: ${Math.round((p.health?.pct ?? 1) * 100)}% | Job: ${p.job?.report ?? "idle"} | Skills: ${skills}`);
          break;
        }

        case "research": {
          const res = await this.callBridge("GET", "/research");
          const cur = res.current ? `${res.current.label} (${Math.round(res.current.progress * 100)}%)` : "None";
          const available = (res.available ?? []).slice(0, 5).map((a) => a.label ?? a.def).join(", ");
          this.sendChat(`[Research] Active: ${cur} | Available options: ${available}`);
          break;
        }

        case "resources": {
          const r = await this.callBridge("GET", "/resources");
          const resObj = r.resources ?? {};
          const text = Object.entries(resObj)
            .sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0))
            .slice(0, 10)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ");
          const foodText = r.foodNutrition ? ` | Edible Food: ${r.foodNutrition}` : "";
          this.sendChat(`[Stockpiled Resources] ${text}${foodText}`.slice(0, 480));
          break;
        }

        case "say": {
          if (!args) {
            this.sendChat(`Usage: !say <message to show on RimWorld screen>`);
            return;
          }
          const displayMsg = `[Twitch] ${username}: ${args.slice(0, 100)}`;
          await this.callBridge("POST", "/notify", { text: displayMsg, type: "neutral" });
          this.broadcastEvent({ type: "notification", from: username, text: args });
          this.sendChat(`@${username} Your message has appeared on the RimWorld game screen!`);
          if (this.voiceEngine?.enabled) {
            this.voiceEngine.speak(`${username} says: ${args}`);
          }
          break;
        }

        case "vote": {
          if (!args) {
            this.sendChat(`Usage: !vote <tech name> (e.g. !vote SolarPanels, !vote Gunsmithing)`);
            return;
          }
          const choice = args.toLowerCase().replace(/[\r\n\0]/g, " ").trim().slice(0, 40);
          if (!choice) return;
          if (!this.votes.has(choice) && this.votes.size >= 12) {
            this.sendChat(`@${username} The poll already has 12 options. Vote for one of those, or wait for the next poll.`);
            return;
          }
          // Remove user from previous votes
          for (const voters of this.votes.values()) {
            voters.delete(username);
          }
          if (!this.votes.has(choice)) {
            this.votes.set(choice, new Set());
          }
          this.votes.get(choice).add(username);
          const count = this.votes.get(choice).size;
          this.broadcastEvent({ type: "vote", poll: this.getPollSummary() });
          this.sendChat(`@${username} Voted for "${args}" (Total votes: ${count}).`);
          break;
        }

        case "poll": {
          const summary = this.getPollSummary();
          if (Object.keys(summary).length === 0) {
            this.sendChat(`No active votes yet. Use !vote <choice> to start!`);
          } else {
            const standings = Object.entries(summary)
              .map(([k, v]) => `${k}: ${v} votes`)
              .join(" | ");
            this.sendChat(`[Active Poll] ${standings}`);
          }
          break;
        }
      }
    } catch (err) {
      console.error(`[TwitchChat] Command error (!${cmd}):`, err.message);
      this.sendChat(`@${username} !${cmd} could not run just now. Try again in a moment.`);
    }
  }

  getPollSummary() {
    const summary = {};
    for (const [k, voters] of this.votes.entries()) {
      summary[k] = voters.size;
    }
    return summary;
  }
}
