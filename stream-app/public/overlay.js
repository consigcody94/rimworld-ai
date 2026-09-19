/**
 * Client script for live broadcast HUD
 * Polls local stream-app server for snapshot, colonist vitals, and live chat updates.
 */

async function updateTelemetry() {
  try {
    const res = await fetch("/api/snapshot");
    if (!res.ok) return;
    const snap = await res.json();

    // Top Header
    document.getElementById("colony-name").textContent = snap.colonyName || "NewDawn";
    document.getElementById("game-date").textContent = snap.date || "Spring 5500";
    document.getElementById("game-weather").textContent = `${Math.round(snap.temperatureC || 10)}C ${snap.weather || "Clear"}`;
    document.getElementById("storyteller").textContent = snap.storyteller || "Cassandra Classic";

    // Stockpiled Resources
    const r = snap.resources || {};
    document.getElementById("res-food").textContent = `${r.MealSurvivalPack || r.MealSimple || 0} Meals`;
    document.getElementById("res-med").textContent = `${r.MedicineIndustrial || r.MedicineHerbal || 0} Meds`;
    document.getElementById("res-wood").textContent = `${r.WoodLog || 0} Wood`;
    document.getElementById("res-steel").textContent = `${r.Steel || 0} Steel`;
    document.getElementById("res-comp").textContent = `${r.ComponentIndustrial || 0} Comp`;

    // Research
    if (snap.research) {
      const pct = Math.round((snap.research.progress || 0) * 100);
      document.getElementById("research-name").textContent = `${snap.research.label} (${pct}%)`;
      document.getElementById("research-fill").style.width = `${pct}%`;
    }

    // Colonists
    const panel = document.getElementById("colonists-panel");
    const colonists = snap.colonists || [];
    panel.innerHTML = colonists
      .map((c) => {
        const hp = Math.round((c.health?.pct ?? 1) * 100);
        const mood = Math.round((c.needs?.mood ?? 1) * 100);
        const job = c.job?.report || "idle";
        return `
          <div class="pawn-card">
            <div class="pawn-header">
              <span class="pawn-name">${c.name}</span>
              <span class="pawn-job">${job}</span>
            </div>
            <div class="meter-row">
              <span class="meter-label">HP</span>
              <div class="meter-track"><div class="meter-fill-hp" style="width: ${hp}%;"></div></div>
            </div>
            <div class="meter-row">
              <span class="meter-label">MOOD</span>
              <div class="meter-track"><div class="meter-fill-mood" style="width: ${mood}%;"></div></div>
            </div>
          </div>
        `;
      })
      .join("");
  } catch (err) {
    console.warn("Overlay telemetry update failed:", err);
  }
}

async function updateChatAndThoughts() {
  try {
    const res = await fetch("/api/events");
    if (!res.ok) return;
    const data = await res.json();

    // Chat feed
    const chatFeed = document.getElementById("chat-feed");
    if (data.chat && data.chat.length > 0) {
      chatFeed.innerHTML = data.chat
        .slice(-5)
        .map((m) => `<div class="chat-entry"><span class="chat-user">${m.username}:</span> ${escapeHtml(m.message)}</div>`)
        .join("");
    }

    // Thought feed
    const thoughtFeed = document.getElementById("thought-feed");
    if (data.thoughts && data.thoughts.length > 0) {
      thoughtFeed.innerHTML = data.thoughts
        .slice(-3)
        .map((t, idx) => `<div class="thought-item ${idx === data.thoughts.length - 1 ? "active" : ""}">${escapeHtml(t)}</div>`)
        .join("");
    }
  } catch (err) {
    console.warn("Overlay events update failed:", err);
  }
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Polling loops
setInterval(updateTelemetry, 1500);
setInterval(updateChatAndThoughts, 1500);
updateTelemetry();
updateChatAndThoughts();
