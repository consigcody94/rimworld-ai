#!/usr/bin/env node
// Smoke test: spawn the MCP server over stdio, list tools, call a few. Requires RimWorld + the bridge mod running.
// Usage: node scripts/smoke.mjs [tool[=jsonArgs] ...]   e.g. node scripts/smoke.mjs rimworld_status 'rimworld_pawns={"detail":false}'
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = spawn(process.execPath, [path.join(here, "..", "dist", "index.js")], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const pending = new Map();
server.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch {}
  }
});
let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("timeout " + method)); } }, 120000);
  });
}
function notify(method, params) { server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); }

const calls = process.argv.slice(2);
try {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
  console.log("server:", init.result.serverInfo);
  notify("notifications/initialized", {});
  const tools = await rpc("tools/list", {});
  console.log("tools:", tools.result.tools.length, tools.result.tools.map((t) => t.name).join(", "));
  const toRun = calls.length ? calls : ["rimworld_status"];
  for (const spec of toRun) {
    const eq = spec.indexOf("=");
    const name = eq < 0 ? spec : spec.slice(0, eq);
    const args = eq < 0 ? {} : JSON.parse(spec.slice(eq + 1));
    const r = await rpc("tools/call", { name, arguments: args });
    const c = r.result?.content?.[0];
    console.log(`\n== ${name}(${JSON.stringify(args)}) isError=${r.result?.isError ?? false}`);
    if (c?.type === "image") console.log(`[image ${c.mimeType} ${c.data.length} b64 chars]`);
    else console.log((c?.text ?? JSON.stringify(r)).slice(0, 1500));
  }
} catch (e) {
  console.error("SMOKE FAILED:", e.message);
  process.exitCode = 1;
} finally {
  server.kill();
  process.exit(process.exitCode ?? 0);
}
