/**
 * RimWorld AI Streamer Voice Engine
 * Persona: Top-tier min-max RimWorld player / tactical streamer.
 * Supports native macOS TTS (Daniel, Eddy, Samantha) and browser overlay speech synthesis.
 */

import { spawn } from "node:child_process";

export class VoiceEngine {
  constructor(options = {}) {
    this.voiceName = options.voiceName ?? "Daniel";
    this.rate = options.rate ?? 185; // Natural, confident speaking rate
    this.enabled = options.enabled ?? true;
    this.isSpeaking = false;
    this.queue = [];
    this.listeners = new Set();
  }

  onSpeak(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  broadcast(event) {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {}
    }
  }

  formatPersonaResponse(username, message, type = "chat") {
    const cleanMsg = message.trim();
    const lower = cleanMsg.toLowerCase();

    if (lower.includes("killbox") || lower.includes("defense")) {
      return `@${username} Killboxes are standard min-max protocol. Staggered wooden spike traps deal 45 puncture damage, eliminating early raiders before weapons discharge. Zero colonist injury risk.`;
    }
    if (lower.includes("mood") || lower.includes("mental break") || lower.includes("break")) {
      return `@${username} Mood management is simple arithmetic. Solve Ate Raw Food with simple meals, eliminate barracks with private 12-cell bedrooms, and keep beauty above 0.5. Mental breaks are a failure of planning.`;
    }
    if (lower.includes("research") || lower.includes("tech")) {
      return `@${username} Tech tree sequence is optimized: Batteries, Solar Panels, Smithing, Gunsmithing, Blowback, then Microelectronics. Never detour into luxury techs before industrial defense.`;
    }
    if (lower.includes("food") || lower.includes("starv") || lower.includes("cook")) {
      return `@${username} Early game is 100% rice on fertile soil. 3-day growth cycle outpaces potatoes and corn, building a buffer before winter temperature drop.`;
    }
    if (lower.includes("who is best") || lower.includes("best pawn") || lower.includes("favorite")) {
      return `@${username} Doctor Roro has Medicine level 8 with double passion, and Callie is Social 9 and Intellectual 11. Complete skill synergy across surgery and research.`;
    }
    if (lower.includes("stream") || lower.includes("ai") || lower.includes("who are you")) {
      return `@${username} I am an autonomous AI playing RimWorld Cassandra Adventure Story with zero dev mode. 100% legitimate gameplay with full bridge API control.`;
    }

    // Default pro commentary
    return `@${username} Copy that. Monitoring colony metrics and executing optimized play.`;
  }

  speak(text, options = {}) {
    if (!this.enabled || !text) return;
    const clean = text.replace(/[@#_*]/g, "").trim();
    if (!clean) return;

    this.queue.push({ text: clean, options });
    this.processQueue();
  }

  processQueue() {
    if (this.isSpeaking || this.queue.length === 0) return;
    const item = this.queue.shift();
    this.isSpeaking = true;

    // Broadcast to stream overlay / browser listeners
    this.broadcast({ type: "speech", text: item.text, voice: this.voiceName });

    // Spawn macOS say process
    try {
      const child = spawn("say", ["-v", this.voiceName, "-r", String(this.rate), item.text]);
      child.on("close", () => {
        this.isSpeaking = false;
        setTimeout(() => this.processQueue(), 250);
      });
      child.on("error", (err) => {
        console.warn("[VoiceEngine] say error:", err.message);
        this.isSpeaking = false;
        setTimeout(() => this.processQueue(), 250);
      });
    } catch {
      this.isSpeaking = false;
    }
  }
}
