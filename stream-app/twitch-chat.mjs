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

    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
    }

    const wsUrl = "wss://irc-ws.chat.twitch.tv:443";
    console.log(`[TwitchChat] Connecting to ${wsUrl} for channel #${this.channel}...`);
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.connected = true;
      const pass = this.oauthToken ? (this.oauthToken.startsWith("oauth:") ? this.oauthToken : `oauth:${this.oauthToken}`) : "SCHMOOPIE";
      const nick = this.botUsername || `justinfan${Math.floor(10000 + Math.random() * 90000)}`;
      this.isAuthenticated = Boolean(this.oauthToken && this.botUsername);

      this.ws.send(`PASS ${pass}\r\n`);
      this.ws.send(`NICK ${nick}\r\n`);
      this.ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands\r\n");
      this.ws.send(`JOIN #${this.channel}\r\n`);

      console.log(`[TwitchChat] Joined #${this.channel} as ${nick} (authenticated: ${this.isAuthenticated})`);
      this.broadcastEvent({ type: "connection", connected: true, authenticated: this.isAuthenticated, channel: this.channel });
    };

    this.ws.onmessage = async (event) => {
      const raw = event.data.toString();
      const lines = raw.split("\r\n");
      for (const line of lines) {
        if (!line) continue;
        await this.handleIrcLine(line);
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      console.log("[TwitchChat] Connection closed. Reconnecting in 5s...");
      this.broadcastEvent({ type: "connection", connected: false, channel: this.channel });
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connect(), 5000);
    };

    this.ws.onerror = (err) => {
      console.error("[TwitchChat] WebSocket error:", err.message ?? err);
    };
  }

  disconnect() {
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.connected = false;
  }

  sendChat(message) {
    if (!this.connected || !this.ws || !this.channel) return;
    if (!this.isAuthenticated) {
      console.log(`[TwitchChat (Simulated Reply)]: ${message}`);
      return;
    }
    this.ws.send(`PRIVMSG #${this.channel} :${message}\r\n`);
  }

  async handleIrcLine(line) {
    if (line.startsWith("PING")) {
      this.ws.send("PONG :tmi.twitch.tv\r\n");
      return;
    }

    if (!line.includes("PRIVMSG")) return;

    // Parse Twitch PRIVMSG: :username!username@username.tmi.twitch.tv PRIVMSG #channel :message text
    const match = line.match(/^:([^!]+)![^ ]+ PRIVMSG #[^ ]+ :(.+)$/);
    if (!match) return;

    const username = match[1];
    const message = match[2].trim();

    const chatMsg = {
      username,
      message,
      timestamp: new Date().toLocaleTimeString(),
    };

    this.chatHistory.push(chatMsg);
    if (this.chatHistory.length > 50) this.chatHistory.shift();

    this.broadcastEvent({ type: "chat", ...chatMsg });

    // Display viewer chat directly inside RimWorld UI
    try {
      await this.callBridge("POST", "/notify", { text: `[Twitch] ${username}: ${message.slice(0, 75)}`, type: "neutral" });
    } catch {}

    if (message.startsWith("!")) {
      await this.handleCommand(username, message);
    } else if (this.voiceEngine) {
      const response = this.voiceEngine.formatPersonaResponse(username, message);
      this.sendChat(response);
      this.voiceEngine.speak(response);
    }
  }

  async handleCommand(username, message) {
    const parts = message.slice(1).split(" ");
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(" ").trim();

    try {
      switch (cmd) {
        case "help":
        case "commands": {
          const text = `Available commands: !status, !colonists, !pawn <name>, !research, !resources, !say <message>, !vote <tech>, !poll`;
          this.sendChat(text);
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
          this.sendChat(`[Colonists] ${list}`);
          break;
        }

        case "pawn": {
          if (!args) {
            this.sendChat(`Usage: !pawn <name> (e.g. !pawn Jenni, !pawn Callie, !pawn Roro)`);
            return;
          }
          let p = null;
          try {
            p = await this.callBridge("GET", `/pawn/${encodeURIComponent(args)}`);
          } catch {}
          if (!p || p.ok === false || !p.name) {
            const pawnsRes = await this.callBridge("GET", "/pawns?detail=true");
            p = (pawnsRes.pawns ?? []).find(
              (x) => x.name?.toLowerCase() === args.toLowerCase() || String(x.id) === args
            );
          }
          if (!p) {
            this.sendChat(`Colonist "${args}" not found. Active colonists: Jenni, Callie, Roro`);
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
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ");
          const foodText = r.foodNutrition ? ` | Edible Food: ${r.foodNutrition}` : "";
          this.sendChat(`[Stockpiled Resources] ${text}${foodText}`);
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
          if (this.voiceEngine) {
            this.voiceEngine.speak(`${username} says: ${args}`);
          }
          break;
        }

        case "vote": {
          if (!args) {
            this.sendChat(`Usage: !vote <tech name> (e.g. !vote SolarPanels, !vote Gunsmithing)`);
            return;
          }
          const choice = args.toLowerCase();
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
      this.sendChat(`Error executing !${cmd}: ${err.message}`);
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
