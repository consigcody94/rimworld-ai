#!/usr/bin/env node
/**
 * RimWorld AI Stream Studio Server
 * Serves the Studio Dashboard, Broadcast Overlay, and drives Twitch Chat & Video Streaming.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TwitchChatEngine } from "./twitch-chat.mjs";
import { StreamEngine } from "./streamer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, "..", ".env");
const PUBLIC_DIR = path.join(__dirname, "public");

// Load .env if present
function loadEnv() {
  const env = {};
  if (fs.existsSync(ENV_FILE)) {
    const lines = fs.readFileSync(ENV_FILE, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq > 0) {
        const k = trimmed.slice(0, eq).trim();
        const v = trimmed.slice(eq + 1).trim();
        env[k] = v;
        if (!process.env[k]) process.env[k] = v;
      }
    }
  }
  return env;
}

const env = loadEnv();

function saveEnv(updates) {
  let content = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf-8") : "";
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined || v === null || v === "") continue;
    const line = `${k}=${v}`;
    const regex = new RegExp(`^${k}=.*$`, "m");
    content = regex.test(content) ? content.replace(regex, line) : `${content.trim()}\n${line}`;
  }
  fs.writeFileSync(ENV_FILE, content.trim() + "\n", "utf-8");
}

let lastChannelInfo = null;
/** Set the Twitch category to RimWorld and the stream title (needs client id + user token with channel:manage:broadcast). */
async function applyChannelInfo(reason, title) {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const token = process.env.TWITCH_BOT_OAUTH;
  if (!clientId || !token) {
    lastChannelInfo = { ok: false, error: "Twitch Client ID and OAuth token are required (open /auth/twitch)." };
    return lastChannelInfo;
  }
  const result = await updateTwitchChannelInfo({ clientId, token, title: title || process.env.STREAM_TITLE || DEFAULT_STREAM_TITLE });
  lastChannelInfo = { ...result, at: Date.now(), reason };
  console.log(`[Twitch] channel updated (${reason}): category ${result.category}, title "${result.title}"`);
  return lastChannelInfo;
}
const PORT = parseInt(process.env.STREAM_PORT || "18888", 10);
const BRIDGE_URL = (process.env.RIMWORLD_API || "http://127.0.0.1:18800").replace(/\/$/, "");

// App State
let agentThoughts = [];

import { VoiceEngine } from "./voice.mjs";
import { ChatBrain } from "./chat-brain.mjs";
import { updateTwitchChannelInfo, resolveTwitchLogin, DEFAULT_STREAM_TITLE } from "./twitch-api.mjs";

// Voice is off by default: the AI talks in Twitch chat. Set VOICE_ENGINE to vocello, neural or
// say in .env to also speak the same lines aloud on stream.
const voiceEngine = new VoiceEngine({
  engine: env.VOICE_ENGINE || process.env.VOICE_ENGINE || "off",
  enabled: (env.VOICE_ENGINE || process.env.VOICE_ENGINE || "off").toLowerCase() !== "off",
  voiceName: env.VOICE_NAME || process.env.VOICE_NAME || "com.apple.siri.natural.Nora",
  rate: 0.38,
});
console.log(`[Voice] ${voiceEngine.enabled ? `enabled (${voiceEngine.activeEngine()})` : "disabled; commentary goes to Twitch chat only"}.`);
const chatBrain = new ChatBrain({ bridgeUrl: BRIDGE_URL });
// No pre-written greetings: every spoken line is generated live from game events and chat.

// Initialize Engines
const chatEngine = new TwitchChatEngine({
  channel: env.TWITCH_CHANNEL || process.env.TWITCH_CHANNEL || "",
  botUsername: env.TWITCH_BOT_USERNAME || process.env.TWITCH_BOT_USERNAME || "",
  oauthToken: env.TWITCH_BOT_OAUTH || process.env.TWITCH_BOT_OAUTH || "",
  bridgeUrl: BRIDGE_URL,
  voiceEngine,
  chatBrain,
});

const streamEngine = new StreamEngine({
  streamKey: env.TWITCH_STREAM_KEY || process.env.TWITCH_STREAM_KEY || "",
  fps: 30,
  bitrate: "4500k",
});

if (chatEngine.channel) {
  chatEngine.connect();
}

// Helpers
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (chunk) => (buf += chunk));
    req.on("end", () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
    return;
  }
  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(filePath).pipe(res);
}

// HTTP Request Handler
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // ------------------------------------------------------------------------
    // Static Routes
    // ------------------------------------------------------------------------
    if (pathname === "/" || pathname === "/index.html") {
      return serveStatic(res, path.join(PUBLIC_DIR, "index.html"), "text/html");
    }
    if (pathname === "/overlay" || pathname === "/overlay.html") {
      return serveStatic(res, path.join(PUBLIC_DIR, "overlay.html"), "text/html");
    }
    if (pathname === "/studio.css") {
      return serveStatic(res, path.join(PUBLIC_DIR, "studio.css"), "text/css");
    }
    if (pathname === "/studio.js") {
      return serveStatic(res, path.join(PUBLIC_DIR, "studio.js"), "application/javascript");
    }
    if (pathname === "/overlay.css") {
      return serveStatic(res, path.join(PUBLIC_DIR, "overlay.css"), "text/css");
    }
    if (pathname === "/overlay.js") {
      return serveStatic(res, path.join(PUBLIC_DIR, "overlay.js"), "application/javascript");
    }

    // ------------------------------------------------------------------------
    // API: Colony Snapshot & Live Telemetry
    // ------------------------------------------------------------------------
    if (pathname === "/api/snapshot" && req.method === "GET") {
      try {
        const bridgeRes = await fetch(`${BRIDGE_URL}/snapshot`, { signal: AbortSignal.timeout(5000) });
        const snap = await bridgeRes.json();
        return sendJson(res, 200, snap);
      } catch (err) {
        return sendJson(res, 200, {
          ok: false,
          error: "Bridge unreachable",
          colonyName: "",
          date: "",
          weather: "",
          temperatureC: null,
          colonists: [],
        });
      }
    }

    // ------------------------------------------------------------------------
    // API: Stream & Chat Events (SSE / Polling)
    // ------------------------------------------------------------------------
    if (pathname === "/api/events" && req.method === "GET") {
      return sendJson(res, 200, {
        ok: true,
        twitchConnected: chatEngine.connected,
        channel: chatEngine.channel,
        chat: chatEngine.chatHistory,
        poll: chatEngine.getPollSummary(),
        thoughts: agentThoughts,
        voice: { ...voiceEngine.state, stats: voiceEngine.stats },
        brain: { mode: chatBrain.mode, llmAvailable: chatBrain.available, stats: chatBrain.stats },
      });
    }

    // ------------------------------------------------------------------------
    // API: Push AI Agent Thought / Decision
    // ------------------------------------------------------------------------
    if (pathname === "/api/thought" && req.method === "POST") {
      const body = await parseJsonBody(req);
      if (body.text) {
        agentThoughts.push(body.text);
        if (agentThoughts.length > 20) agentThoughts.shift();
      }
      return sendJson(res, 200, { ok: true, count: agentThoughts.length });
    }

    // ------------------------------------------------------------------------
    // API: Trigger AI Voice Commentary
    // ------------------------------------------------------------------------
    // Live commentary. The agent reports WHAT HAPPENED, the brain writes the line, and the line
    // goes to Twitch chat. Speech is opt-in (VOICE_ENGINE), because the AI talking in chat reads
    // as a participant in the room while a synthetic voice reads as a narrator over the top.
    if (pathname === "/api/commentary" && req.method === "POST") {
      const body = await parseJsonBody(req);
      if (!body.event) return sendJson(res, 400, { ok: false, error: "event required" });
      let text = null;
      try {
        text = await chatBrain.commentary(body.event, body.detail ?? "", { askChat: Boolean(body.askChat) });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: e.message });
      }
      if (!text) return sendJson(res, 200, { ok: true, posted: false });

      const at = new Date().toLocaleTimeString();
      agentThoughts.push(text);
      if (agentThoughts.length > 20) agentThoughts.shift();
      chatEngine.chatHistory.push({ username: "PersonaCore", message: text, timestamp: at });
      if (chatEngine.chatHistory.length > 50) chatEngine.chatHistory.shift();
      chatEngine.broadcastEvent({ type: "reply", username: "PersonaCore", message: text, timestamp: at });
      if (body.toChat !== false) chatEngine.sendChat(text);
      try {
        await fetch(`${BRIDGE_URL}/chat/push`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user: "PersonaCore", text: text.slice(0, 140), color: "#7DD3FC" }),
          signal: AbortSignal.timeout(1500),
        });
      } catch {}
      const spoken = voiceEngine.enabled ? voiceEngine.speak(text, { force: body.priority === "high", priority: body.priority }) : false;
      return sendJson(res, 200, { ok: true, posted: true, spoken, text });
    }

    if (pathname === "/api/voice/speak" && req.method === "POST") {
      const body = await parseJsonBody(req);
      let accepted = false;
      if (body.text) {
        accepted = voiceEngine.speak(body.text, { force: Boolean(body.force), priority: body.priority });
      }
      return sendJson(res, 200, { ok: true, accepted, text: body.text, state: voiceEngine.state });
    }

    // ------------------------------------------------------------------------
    // API: Send Chat Message / Trigger Command
    // ------------------------------------------------------------------------
    if (pathname === "/api/chat/send" && req.method === "POST") {
      const body = await parseJsonBody(req);
      const msg = body.message?.trim();
      if (!msg) return sendJson(res, 400, { ok: false, error: "Empty message" });

      if (msg.startsWith("!")) {
        await chatEngine.handleCommand("Admin", msg);
      } else {
        chatEngine.chatHistory.push({ username: "Admin", message: msg, timestamp: new Date().toLocaleTimeString() });
        chatEngine.sendChat(msg);
      }
      return sendJson(res, 200, { ok: true });
    }

    // ------------------------------------------------------------------------
    // API: Stream Controls
    // ------------------------------------------------------------------------
    if (pathname === "/api/stream/start" && req.method === "POST") {
      const result = streamEngine.start();
      applyChannelInfo("stream start").catch((e) => console.warn("[Twitch] channel update failed:", e.message));
      return sendJson(res, 200, result);
    }

    if (pathname === "/api/stream/stop" && req.method === "POST") {
      const result = streamEngine.stop();
      return sendJson(res, 200, result);
    }

    if (pathname === "/api/stream/status" && req.method === "GET") {
      return sendJson(res, 200, { ...streamEngine.stats, channelInfo: lastChannelInfo });
    }

    // ------------------------------------------------------------------------
    // API: Settings
    // ------------------------------------------------------------------------
    if (pathname === "/api/settings" && req.method === "GET") {
      return sendJson(res, 200, {
        ok: true,
        channel: chatEngine.channel,
        hasKey: Boolean(streamEngine.streamKey),
        hasOauth: Boolean(chatEngine.oauthToken),
        hasClientId: Boolean(process.env.TWITCH_CLIENT_ID),
        botUsername: chatEngine.botUsername || null,
        channelInfo: lastChannelInfo,
      });
    }

    if (pathname === "/api/settings" && req.method === "POST") {
      const body = await parseJsonBody(req);
      const updates = [];

      if (body.channel !== undefined) {
        const ch = body.channel.trim();
        process.env.TWITCH_CHANNEL = ch;
        chatEngine.channel = ch;
        chatEngine.connect();
        updates.push(`TWITCH_CHANNEL=${ch}`);
      }

      if (body.streamKey) {
        const key = body.streamKey.trim();
        process.env.TWITCH_STREAM_KEY = key;
        streamEngine.streamKey = key;
        updates.push(`TWITCH_STREAM_KEY=${key}`);
      }

      // Persist to .env safely
      if (updates.length > 0) {
        let envContent = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf-8") : "";
        for (const update of updates) {
          const key = update.split("=")[0];
          const regex = new RegExp(`^${key}=.*$`, "m");
          if (regex.test(envContent)) {
            envContent = envContent.replace(regex, update);
          } else {
            envContent += `\n${update}`;
          }
        }
        fs.writeFileSync(ENV_FILE, envContent.trim() + "\n", "utf-8");
      }

      return sendJson(res, 200, { ok: true });
    }

    // ------------------------------------------------------------------------
    // Twitch OAuth Flow
    // ------------------------------------------------------------------------
    if (pathname === "/auth/twitch") {
      const clientId = process.env.TWITCH_CLIENT_ID;
      const redirectUri = `http://localhost:${PORT}/auth/callback`;

      if (clientId) {
        const oauthUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=chat:read+chat:edit+channel:manage:broadcast`;
        res.writeHead(302, { Location: oauthUrl });
        res.end();
        return;
      }

      // If no custom Twitch Client ID registered yet, offer direct token generator
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Twitch Authorization</title><style>body{font-family:sans-serif;background:#0d1117;color:#c9d1d9;padding:40px;max-width:600px;margin:auto;}a{color:#58a6ff;}input{width:100%;padding:10px;margin:10px 0;background:#161b22;border:1px solid #30363d;color:#fff;border-radius:6px;box-sizing:border-box;}button{background:#9146ff;color:#fff;border:none;padding:10px 20px;border-radius:6px;cursor:pointer;font-weight:bold;}</style></head>
        <body>
          <h2>Twitch Bot Authorization</h2>
          <p>Generate a token with <a href="https://twitchtokengenerator.com/" target="_blank">twitchtokengenerator.com</a>: choose <b>Custom Scope Token</b>, tick <code>chat:read</code>, <code>chat:edit</code> and <code>channel:manage:broadcast</code>, authorize with the account that streams, then paste the <b>Client ID</b> and <b>Access Token</b> below. The bot username is resolved from the token automatically.</p>
          <form method="POST" action="/auth/save-token">
            <label>Client ID:</label>
            <input type="text" name="clientId" placeholder="Client ID from the generator" required>
            <label>Access Token:</label>
            <input type="password" name="oauthToken" placeholder="access token (with or without oauth: prefix)" required>
            <label>Bot Username (optional, resolved from the token when blank):</label>
            <input type="text" name="botUsername" placeholder="leave blank">
            <button type="submit">Save Token &amp; Connect</button>
          </form>
          <p><a href="/">← Return to Studio</a></p>
        </body>
        </html>
      `);
      return;
    }

    if (pathname === "/auth/save-token" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        const params = new URLSearchParams(body);
        let botUsername = params.get("botUsername")?.trim();
        let oauthToken = params.get("oauthToken")?.trim();
        const clientId = params.get("clientId")?.trim() || process.env.TWITCH_CLIENT_ID;
        if (oauthToken && !/^oauth:/i.test(oauthToken)) oauthToken = `oauth:${oauthToken}`;

        if (oauthToken) {
          if (!botUsername && clientId) {
            try { botUsername = (await resolveTwitchLogin({ clientId, token: oauthToken })).login; }
            catch (e) { console.warn("[Twitch] could not resolve login from token:", e.message); }
          }
          if (clientId) process.env.TWITCH_CLIENT_ID = clientId;
          process.env.TWITCH_BOT_OAUTH = oauthToken;
          chatEngine.oauthToken = oauthToken;
          if (botUsername) {
            process.env.TWITCH_BOT_USERNAME = botUsername;
            chatEngine.botUsername = botUsername;
          }
          chatEngine.connect();
          saveEnv({ TWITCH_CLIENT_ID: clientId, TWITCH_BOT_USERNAME: botUsername, TWITCH_BOT_OAUTH: oauthToken });
          applyChannelInfo("token saved").catch(() => {});
        }

        res.writeHead(302, { Location: "/" });
        res.end();
      });
      return;
    }

    if (pathname === "/api/twitch/channel" && req.method === "POST") {
      const body = await parseJsonBody(req);
      try {
        const result = await applyChannelInfo("manual", body.title);
        return sendJson(res, 200, result);
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message });
      }
    }

    if (pathname === "/auth/callback") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`
        <!DOCTYPE html>
        <html><body>
          <script>
            const hash = window.location.hash.substring(1);
            const params = new URLSearchParams(hash);
            const token = params.get("access_token");
            if (token) {
              fetch("/auth/save-token", {
                method: "POST",
                body: new URLSearchParams({ botUsername: "TwitchUser", oauthToken: "oauth:" + token })
              }).then(() => window.location.href = "/");
            } else {
              window.location.href = "/";
            }
          </script>
        </body></html>
      `);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  } catch (err) {
    console.error("[StreamStudio Server Error]:", err);
    sendJson(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`================================================================`);
  console.log(`  🪐 RimWorld AI Stream Studio listening on http://localhost:${PORT}`);
  console.log(`  📺 Live Overlay URL: http://localhost:${PORT}/overlay`);
  console.log(`================================================================`);
});
