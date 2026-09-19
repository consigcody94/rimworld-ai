/**
 * Hardware-Accelerated FFmpeg Streaming Engine
 * Uses macOS avfoundation and h264_videotoolbox for low-CPU 1080p60 / 720p60 Twitch broadcasting.
 */

import { spawn } from "node:child_process";

export class StreamEngine {
  constructor(options = {}) {
    this.streamKey = options.streamKey ?? "";
    this.ingestServer = options.ingestServer ?? "rtmp://live.twitch.tv/app";
    this.fps = options.fps ?? 60;
    this.bitrate = options.bitrate ?? "4500k";
    this.resolution = options.resolution ?? "1920x1080"; // or 1280x720
    this.deviceIndex = options.deviceIndex ?? "3"; // avfoundation screen device index
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
    if (this.child) {
      throw new Error("Stream is already active.");
    }

    const key = customKey || this.streamKey;
    if (!key) {
      throw new Error("Missing Twitch Stream Key. Configure it in settings or .env.");
    }

    const rtmpUrl = `${this.ingestServer}/${key}`;

    const args = [
      "-y",
      "-f", "avfoundation",
      "-capture_cursor", "1",
      "-framerate", String(this.fps),
      "-i", `${this.deviceIndex}:none`,
      "-f", "lavfi",
      "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-c:v", "h264_videotoolbox",
      "-vf", "scale=1920:1080,format=yuv420p",
      "-b:v", this.bitrate,
      "-maxrate", "6000k",
      "-bufsize", "12000k",
      "-g", String(this.fps * 2), // 2-second keyframe interval required by Twitch
      "-c:a", "aac",
      "-b:a", "160k",
      "-ar", "44100",
      "-f", "flv",
      rtmpUrl,
    ];

    console.log(`[StreamEngine] Spawning FFmpeg with hardware encoding (h264_videotoolbox)...`);
    this.child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
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

    this.child.on("close", (code) => {
      console.log(`[StreamEngine] FFmpeg process exited with code ${code}`);
      this.stats.running = false;
      this.stats.startedAt = null;
      this.child = null;
      this.emitStats();
    });

    this.child.on("error", (err) => {
      console.error("[StreamEngine] Process error:", err);
      this.stats.error = err.message;
      this.stats.running = false;
      this.emitStats();
    });

    return { ok: true, status: "broadcasting" };
  }

  parseFfmpegStats(line) {
    // Example: frame= 120 fps= 60 q=0.0 size= 1024kB time=00:00:02.00 bitrate=4194.3kbits/s speed=1.00x
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
    if (!this.child) return { ok: true, status: "idle" };

    console.log("[StreamEngine] Stopping broadcast gracefully...");
    this.child.kill("SIGINT");
    const killTimeout = setTimeout(() => {
      if (this.child) {
        console.log("[StreamEngine] Force terminating FFmpeg...");
        this.child.kill("SIGKILL");
      }
    }, 4000);

    this.child.once("close", () => {
      clearTimeout(killTimeout);
    });

    return { ok: true, status: "stopping" };
  }
}
