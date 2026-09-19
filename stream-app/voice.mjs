/**
 * RimWorld AI Streamer Voice Engine
 *
 * Primary engine: Vocello (Qwen3-TTS via MLX, local, no cloud). Vocello loads a 2 GB model
 * on every process start, so single clips cost ~10-15 s. To keep that cost down the engine
 * batches every queued line into ONE `vocello batch` call (one model load), caches clips by
 * text hash so greetings and repeated commentary replay instantly, and pre-warms a list of
 * phrases at startup.
 *
 * Fallback engine: Apple neural Siri voice through ./bin/speak-neural (instant), used when
 * Vocello is missing, fails, or the queue backs up beyond `maxVocelloBacklog`.
 *
 * Playback goes through afplay on the default output device, which the stream's system-audio
 * capture picks up, so viewers hear the commentary.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPEAK_NEURAL_BIN = path.join(__dirname, "bin", "speak-neural");
const DEFAULT_VOCELLO_DIR = path.join(__dirname, "..", "Vocello");

function sha1(s) {
  return createHash("sha1").update(s).digest("hex").slice(0, 20);
}

export class VoiceEngine {
  constructor(options = {}) {
    this.engine = (options.engine ?? process.env.VOICE_ENGINE ?? "vocello").toLowerCase();
    this.vocelloDir = options.vocelloDir ?? process.env.VOCELLO_DIR ?? DEFAULT_VOCELLO_DIR;
    this.vocelloBin = path.join(this.vocelloDir, "build", "vocello");
    this.speaker = options.speaker ?? process.env.VOCELLO_SPEAKER ?? "aiden";
    this.delivery = options.delivery ?? process.env.VOCELLO_DELIVERY ?? "";
    this.voiceName = options.voiceName ?? process.env.VOICE_NAME ?? "com.apple.siri.natural.Nora";
    this.rate = options.rate ?? 0.38;
    this.enabled = options.enabled ?? true;
    this.cacheDir = options.cacheDir ?? path.join(__dirname, ".voice-cache");
    this.maxVocelloBacklog = options.maxVocelloBacklog ?? 4;
    this.maxBatch = options.maxBatch ?? 4;

    this.queue = [];
    this.busy = false;
    this.listeners = new Set();
    this.recentPhrases = new Map();
    this.lastSpokeTime = 0;
    this.state = { speaking: false, synthesizing: false, engine: this.activeEngine(), queued: 0, lastText: "" };
    this.stats = { spoken: 0, cacheHits: 0, vocelloFailures: 0, fallbacks: 0 };

    try { mkdirSync(this.cacheDir, { recursive: true }); } catch {}
    this.pruneCache();
  }

  activeEngine() {
    if (this.engine === "vocello" && existsSync(this.vocelloBin)) return "vocello";
    if (existsSync(SPEAK_NEURAL_BIN)) return "neural";
    return "say";
  }

  onSpeak(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  broadcast(event) {
    for (const l of this.listeners) {
      try { l(event); } catch {}
    }
  }

  setState(patch) {
    Object.assign(this.state, patch, { queued: this.queue.length });
    this.broadcast({ type: "voice-state", ...this.state });
  }

  /** Strip markdown, emoji and control characters so the TTS reads cleanly. */
  clean(text) {
    return String(text)
      .replace(/[*_`#>\[\]]/g, "")
      .replace(/https?:\/\/\S+/g, "link")
      .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/gu, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 400);
  }

  /**
   * Queue a line. options: { force: bypass dedupe/rate-limit, priority: "high" jumps the queue }
   */
  speak(text, options = {}) {
    if (!this.enabled || !text) return false;
    const clean = this.clean(text);
    if (!clean) return false;

    const now = Date.now();
    const lastSpoken = this.recentPhrases.get(clean) ?? 0;
    if (!options.force && now - lastSpoken < 45000) return false;
    if (!options.force && now - this.lastSpokeTime < 4000 && this.queue.length > 2) return false;

    this.recentPhrases.set(clean, now);
    this.lastSpokeTime = now;
    if (this.recentPhrases.size > 200) {
      const oldest = [...this.recentPhrases.entries()].sort((a, b) => a[1] - b[1]).slice(0, 100);
      for (const [k] of oldest) this.recentPhrases.delete(k);
    }

    const item = { text: clean, options, enqueuedAt: now };
    if (options.priority === "high") this.queue.unshift(item);
    else this.queue.push(item);
    // Drop stale low-priority chatter if the queue explodes.
    while (this.queue.length > 8) {
      const idx = this.queue.findIndex((q) => q.options.priority !== "high");
      if (idx < 0) break;
      this.queue.splice(idx, 1);
    }
    this.setState({});
    this.pump();
    return true;
  }

  /** Pre-synthesize phrases (greeting lines etc.) so they play instantly later. */
  async warmup(phrases = []) {
    if (this.activeEngine() !== "vocello") return;
    const missing = phrases.map((p) => this.clean(p)).filter((p) => p && !existsSync(this.cachePath(p)));
    if (missing.length === 0) return;
    try {
      await this.vocelloBatch(missing);
      console.log(`[VoiceEngine] Warmed ${missing.length} cached phrase(s).`);
    } catch (e) {
      console.warn(`[VoiceEngine] Warmup failed: ${e.message}`);
    }
  }

  cachePath(text) {
    return path.join(this.cacheDir, `${this.speaker}-${sha1(text)}.wav`);
  }

  pruneCache(maxFiles = 400) {
    try {
      const files = readdirSync(this.cacheDir)
        .filter((f) => f.endsWith(".wav"))
        .map((f) => ({ f, t: statSync(path.join(this.cacheDir, f)).mtimeMs }))
        .sort((a, b) => a.t - b.t);
      while (files.length > maxFiles) {
        const victim = files.shift();
        try { unlinkSync(path.join(this.cacheDir, victim.f)); } catch {}
      }
    } catch {}
  }

  async pump() {
    if (this.busy || this.queue.length === 0) return;
    this.busy = true;
    try {
      while (this.queue.length > 0) {
        const engine = this.activeEngine();
        if (engine === "vocello") {
          // Take a batch: cached clips play immediately, uncached ones are synthesized together.
          const batch = this.queue.splice(0, this.maxBatch);
          const overflow = this.queue.length > this.maxVocelloBacklog;
          const uncached = batch.filter((i) => !existsSync(this.cachePath(i.text)));
          if (uncached.length > 0 && !overflow) {
            this.setState({ synthesizing: true, engine: "vocello", lastText: uncached[0].text });
            try {
              await this.vocelloBatch(uncached.map((i) => i.text));
            } catch (e) {
              this.stats.vocelloFailures++;
              console.warn(`[VoiceEngine] Vocello failed (${e.message}); falling back to neural for this batch.`);
            }
            this.setState({ synthesizing: false });
          }
          for (const item of batch) {
            const wav = this.cachePath(item.text);
            if (existsSync(wav)) {
              if (uncached.every((u) => u.text !== item.text)) this.stats.cacheHits++;
              await this.play(wav, item.text, "vocello");
            } else {
              this.stats.fallbacks++;
              await this.speakNeural(item.text);
            }
          }
        } else {
          const item = this.queue.shift();
          await this.speakNeural(item.text);
        }
      }
    } finally {
      this.busy = false;
      this.setState({ speaking: false, synthesizing: false });
    }
  }

  vocelloBatch(texts) {
    return new Promise((resolve, reject) => {
      const args = [
        "batch", "--mode", "custom", "--variant", "speed",
        "--speaker", this.speaker, "--file", "-", "--out-dir", this.cacheDir, "--quiet",
      ];
      if (this.delivery) args.push("--delivery", this.delivery);
      const proc = spawn(this.vocelloBin, args, { cwd: this.vocelloDir, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 180000);
      proc.stdout.on("data", (d) => { out += d.toString(); });
      proc.stderr.on("data", (d) => { err += d.toString(); });
      proc.on("error", (e) => { clearTimeout(timer); reject(e); });
      proc.on("close", (code) => {
        clearTimeout(timer);
        const paths = out.split("\n").map((l) => l.trim()).filter((l) => l.endsWith(".wav"));
        if (code !== 0 || paths.length !== texts.length) {
          return reject(new Error(`vocello exit ${code}, ${paths.length}/${texts.length} clips: ${err.trim().split("\n").pop() ?? ""}`));
        }
        // Move outputs into deterministic cache names.
        Promise.all(paths.map((p, i) => this.renameAsync(p, this.cachePath(texts[i]))))
          .then(() => resolve(paths))
          .catch(reject);
      });
      proc.stdin.write(texts.map((t) => t.replace(/\r?\n/g, " ")).join("\n") + "\n");
      proc.stdin.end();
    });
  }

  async renameAsync(from, to) {
    const fs = await import("node:fs/promises");
    try { await fs.rename(from, to); } catch { await fs.copyFile(from, to); }
  }

  play(wav, text, engine) {
    return new Promise((resolve) => {
      this.stats.spoken++;
      this.setState({ speaking: true, engine, lastText: text });
      this.broadcast({ type: "speech", text, voice: engine === "vocello" ? `Vocello ${this.speaker}` : this.voiceName });
      const player = spawn("afplay", [wav], { stdio: "ignore" });
      const done = () => { this.setState({ speaking: false }); setTimeout(resolve, 200); };
      player.on("close", done);
      player.on("error", done);
    });
  }

  speakNeural(text) {
    return new Promise((resolve) => {
      const hasNeural = existsSync(SPEAK_NEURAL_BIN);
      this.stats.spoken++;
      this.setState({ speaking: true, engine: hasNeural ? "neural" : "say", lastText: text });
      this.broadcast({ type: "speech", text, voice: hasNeural ? this.voiceName : "say" });
      const child = hasNeural
        ? spawn(SPEAK_NEURAL_BIN, ["--voice", this.voiceName, "--rate", String(this.rate), text], { stdio: "ignore" })
        : spawn("say", ["-v", "Daniel", "-r", "175", text], { stdio: "ignore" });
      const done = () => { this.setState({ speaking: false }); setTimeout(resolve, 200); };
      child.on("close", done);
      child.on("error", (err) => { console.warn("[VoiceEngine] speech error:", err.message); done(); });
    });
  }
}
