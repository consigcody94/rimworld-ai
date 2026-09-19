/**
 * Hardware-Accelerated FFmpeg Streaming Engine
 * Uses macOS avfoundation and h264_videotoolbox for low-CPU 1080p60 / 720p60 Twitch broadcasting.
 */

import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CAPTURE_BIN = fileURLToPath(new URL("./bin/capture-window", import.meta.url));

export class StreamEngine {
  constructor(options = {}) {
    this.streamKey = options.streamKey ?? "";
    this.ingestServer = options.ingestServer ?? "rtmp://live.twitch.tv/app";
    this.fps = options.fps ?? 30;
    this.bitrate = options.bitrate ?? "4500k";
    this.resolution = options.resolution ?? "1920x1080";
    this.deviceIndex = options.deviceIndex ?? "3";
    this.captureChild = null;
    this.child = null;
    this.stats = {
      running: false,
      fps: 0,
      bitrate: "0 kbits/s",
      speed: "0x",
      frames: 0,
      time: "00:00:00",
      startedAt: null,
      error: null,
    };
    this.listeners = new Set();
  }

  onStats(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitStats() {
    for (const listener of this.listeners) {
      try {
        listener(this.stats);
      } catch {}
    }
  }

  start(customKey = null) {
    if (this.child || this.captureChild) {
      throw new Error("Stream is already active.");
    }

    const key = customKey || this.streamKey;
    if (!key) {
      throw new Error("Missing Twitch Stream Key. Configure it in settings or .env.");
    }

    const rtmpUrl = `${this.ingestServer}/${key}`;

    // 1. Detect RimWorld window dimensions dynamically
    let winWidth = 1680;
    let winHeight = 1920;
    try {
      const out = execFileSync(CAPTURE_BIN, ["--dims"], { encoding: "utf8", timeout: 5000 }).trim();
      const parts = out.split(/\s+/);
      if (parts.length >= 2) {
        const w = parseInt(parts[0], 10);
        const h = parseInt(parts[1], 10);
        if (w > 200 && h > 200) {
          winWidth = w;
          winHeight = h;
        }
      }
    } catch (e) {
      console.warn(`[StreamEngine] Warning: Could not detect window dims, defaulting to ${winWidth}x${winHeight}: ${e.message}`);
    }

    console.log(`[StreamEngine] Target RimWorld Window Size: ${winWidth}x${winHeight}`);

    // 2. Launch native ScreenCaptureKit capture process (stdout = raw BGRA frames)
    this.captureChild = spawn(CAPTURE_BIN, [], { stdio: ["ignore", "pipe", "inherit"] });

    // 3. Launch FFmpeg reading raw frames from stdin and encoding via VideoToolbox
    const vfFilter = "scale=-2:1080,pad=1920:1080:(1920-iw)/2:(1080-ih)/2:black,format=yuv420p";
    const args = [
      "-y",
      "-f", "rawvideo",
      "-pixel_format", "bgra",
      "-video_size", `${winWidth}x${winHeight}`,
      "-framerate", String(this.fps),
      "-i", "-",
      "-f", "lavfi",
      "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-c:v", "h264_videotoolbox",
      "-vf", vfFilter,
      "-b:v", this.bitrate,
      "-maxrate", "6000k",
      "-bufsize", "12000k",
      "-g", String(this.fps * 2),
      "-c:a", "aac",
      "-b:a", "160k",
      "-ar", "44100",
      "-f", "flv",
      rtmpUrl,
    ];

    console.log(`[StreamEngine] Spawning FFmpeg with hardware encoding (h264_videotoolbox)...`);
    this.child = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });

    // Pipe captured frames into FFmpeg stdin
    this.captureChild.stdout.pipe(this.child.stdin);

    this.stats.running = true;
    this.stats.startedAt = Date.now();
    this.stats.error = null;
    this.emitStats();

    let stderrBuf = "";
    this.child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split("\r");
      if (lines.length > 1) {
        stderrBuf = lines[lines.length - 1];
        const lastLine = lines[lines.length - 2];
        this.parseFfmpegStats(lastLine);
      }
    });

    const cleanup = () => {
      if (this.captureChild) {
        try { this.captureChild.kill("SIGINT"); } catch {}
        this.captureChild = null;
      }
      if (this.child) {
        try { this.child.kill("SIGINT"); } catch {}
        this.child = null;
      }
      this.stats.running = false;
      this.stats.startedAt = null;
      this.emitStats();
    };

    this.child.on("close", (code) => {
      console.log(`[StreamEngine] FFmpeg process exited with code ${code}`);
      cleanup();
    });

    this.captureChild.on("close", (code) => {
      console.log(`[StreamEngine] Capture process exited with code ${code}`);
      cleanup();
    });

    this.child.on("error", (err) => {
      console.error("[StreamEngine] FFmpeg process error:", err);
      this.stats.error = err.message;
      cleanup();
    });

    this.captureChild.on("error", (err) => {
      console.error("[StreamEngine] Capture process error:", err);
      this.stats.error = err.message;
      cleanup();
    });

    return { ok: true, status: "broadcasting" };
  }

  parseFfmpegStats(line) {
    const frameMatch = line.match(/frame=\s*(\d+)/);
    const fpsMatch = line.match(/fps=\s*([\d.]+)/);
    const timeMatch = line.match(/time=\s*([\d:.]+)/);
    const bitrateMatch = line.match(/bitrate=\s*([\d.]+kbits\/s)/);
    const speedMatch = line.match(/speed=\s*([\d.]+x)/);

    if (frameMatch) this.stats.frames = parseInt(frameMatch[1], 10);
    if (fpsMatch) this.stats.fps = parseFloat(fpsMatch[1]);
    if (timeMatch) this.stats.time = timeMatch[1];
    if (bitrateMatch) this.stats.bitrate = bitrateMatch[1];
    if (speedMatch) this.stats.speed = speedMatch[1];

    this.emitStats();
  }

  stop() {
    if (!this.child && !this.captureChild) return { ok: true, status: "idle" };

    console.log("[StreamEngine] Stopping broadcast gracefully...");
    if (this.captureChild) {
      try { this.captureChild.kill("SIGINT"); } catch {}
    }
    if (this.child) {
      try { this.child.kill("SIGINT"); } catch {}
    }

    const killTimeout = setTimeout(() => {
      if (this.captureChild) {
        try { this.captureChild.kill("SIGKILL"); } catch {}
        this.captureChild = null;
      }
      if (this.child) {
        try { this.child.kill("SIGKILL"); } catch {}
        this.child = null;
      }
    }, 3000);

    return { ok: true, status: "stopping" };
  }
}
