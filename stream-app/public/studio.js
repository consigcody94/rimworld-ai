/**
 * Client script for Stream Studio Dashboard
 * Controls broadcast start/stop, settings, live chat, and telemetry.
 */

let isStreaming = false;

// DOM Elements
const btnStreamToggle = document.getElementById("btn-stream-toggle");
const liveIndicator = document.getElementById("live-indicator");
const streamStatusLabel = document.getElementById("stream-status-label");
const mFps = document.getElementById("m-fps");
const mBitrate = document.getElementById("m-bitrate");
const mTime = document.getElementById("m-time");
const mFrames = document.getElementById("m-frames");

const twitchChannelInput = document.getElementById("twitch-channel");
const twitchKeyInput = document.getElementById("twitch-key");
const btnSaveKey = document.getElementById("btn-save-key");
const btnOauthConnect = document.getElementById("btn-oauth-connect");
const oauthStatus = document.getElementById("oauth-status");

const studioChatWindow = document.getElementById("studio-chat-window");
const chatCount = document.getElementById("chat-count");
const testChatInput = document.getElementById("test-chat-input");
const btnSendChat = document.getElementById("btn-send-chat");

const pollContainer = document.getElementById("poll-container");
const twitchBadge = document.getElementById("twitch-badge");

// Initialize State
async function init() {
  await loadSettings();
  await updateStreamStatus();
  await updateChatEvents();

  setInterval(updateStreamStatus, 1000);
  setInterval(updateChatEvents, 1500);

  btnStreamToggle.addEventListener("click", toggleStream);
  btnSaveKey.addEventListener("click", saveSettings);
  btnSendChat.addEventListener("click", sendChatMessage);
  testChatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChatMessage();
  });
  btnOauthConnect.addEventListener("click", startTwitchOAuth);
}

async function loadSettings() {
  try {
    const res = await fetch("/api/settings");
    if (!res.ok) return;
    const s = await res.json();
    if (s.channel) twitchChannelInput.value = s.channel;
    if (s.hasKey) twitchKeyInput.placeholder = "Key configured in .env (hidden)";
    if (s.hasOauth) {
      oauthStatus.textContent = "Connected (OAuth active)";
      oauthStatus.style.color = "#3fb950";
    }
  } catch (err) {
    console.warn("Could not load settings:", err);
  }
}

async function saveSettings() {
  const channel = twitchChannelInput.value.trim();
  const key = twitchKeyInput.value.trim();

  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, streamKey: key }),
    });
    const data = await res.json();
    if (data.ok) {
      alert("Settings saved successfully.");
      if (key) twitchKeyInput.value = "";
      loadSettings();
    }
  } catch (err) {
    alert(`Failed to save settings: ${err.message}`);
  }
}

async function toggleStream() {
  btnStreamToggle.disabled = true;
  try {
    const endpoint = isStreaming ? "/api/stream/stop" : "/api/stream/start";
    const res = await fetch(endpoint, { method: "POST" });
    const data = await res.json();
    if (!data.ok) {
      alert(`Stream error: ${data.error}`);
    }
    await updateStreamStatus();
  } catch (err) {
    alert(`Action failed: ${err.message}`);
  } finally {
    btnStreamToggle.disabled = false;
  }
}

async function updateStreamStatus() {
  try {
    const res = await fetch("/api/stream/status");
    if (!res.ok) return;
    const s = await res.json();

    isStreaming = s.running;
    if (isStreaming) {
      liveIndicator.className = "live-indicator live";
      streamStatusLabel.textContent = "LIVE BROADCAST";
      btnStreamToggle.textContent = "Stop Stream";
      btnStreamToggle.className = "btn btn-danger btn-large";
      mFps.textContent = s.fps || 60;
      mBitrate.textContent = s.bitrate || "4500 kbps";
      mTime.textContent = s.time || "00:00:00";
      mFrames.textContent = s.frames || 0;
    } else {
      liveIndicator.className = "live-indicator";
      streamStatusLabel.textContent = "OFFLINE";
      btnStreamToggle.textContent = "Start Stream";
      btnStreamToggle.className = "btn btn-primary btn-large";
      mFps.textContent = "0";
      mBitrate.textContent = "0 kbps";
      mTime.textContent = "00:00:00";
      mFrames.textContent = "0";
    }
  } catch (err) {}
}

async function updateChatEvents() {
  try {
    const res = await fetch("/api/events");
    if (!res.ok) return;
    const data = await res.json();

    // Update connection badge
    if (data.twitchConnected) {
      twitchBadge.className = "badge ok";
      twitchBadge.textContent = `#${data.channel || "connected"}`;
    } else {
      twitchBadge.className = "badge";
      twitchBadge.textContent = "Disconnected";
    }

    // Update chat window
    if (data.chat && data.chat.length > 0) {
      chatCount.textContent = `${data.chat.length} messages`;
      studioChatWindow.innerHTML = data.chat
        .map((m) => `<div class="chat-bubble"><span class="username">${m.username}:</span> ${escapeHtml(m.message)}</div>`)
        .join("");
      studioChatWindow.scrollTop = studioChatWindow.scrollHeight;
    }

    // Update polls
    if (data.poll && Object.keys(data.poll).length > 0) {
      pollContainer.innerHTML = Object.entries(data.poll)
        .map(([choice, count]) => `<div class="poll-item"><span class="choice">${choice}</span><span class="count">${count} votes</span></div>`)
        .join("");
    }
  } catch (err) {}
}

async function sendChatMessage() {
  const text = testChatInput.value.trim();
  if (!text) return;
  testChatInput.value = "";

  try {
    await fetch("/api/chat/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
  } catch (err) {
    console.error("Failed to send chat:", err);
  }
}

function startTwitchOAuth() {
  window.location.href = "/auth/twitch";
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

init();
