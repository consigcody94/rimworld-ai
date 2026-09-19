/**
 * Thin HTTP client for the RimWorld AI Bridge mod (http://127.0.0.1:18800 by default).
 */
export const API_URL = (process.env.RIMWORLD_API ?? "http://127.0.0.1:18800").replace(/\/$/, "");
export const TOKEN = process.env.RIMWORLD_AI_TOKEN ?? "";
export const AGENT_ID = process.env.RIMWORLD_AGENT_ID ?? "";
export const CHARACTER_LIMIT = 60_000;

export class BridgeError extends Error {
  constructor(message: string, public status = 0, public body?: unknown) {
    super(message);
  }
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (TOKEN) h["X-Token"] = TOKEN;
  if (AGENT_ID) h["X-Agent-Id"] = AGENT_ID;
  return h;
}

export async function api<T = any>(method: "GET" | "POST", path: string, params?: Record<string, unknown>, timeoutMs = 90_000): Promise<T> {
  let url = API_URL + path;
  let body: string | undefined;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null) clean[k] = v;
  if (method === "GET") {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(clean)) qs.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    const s = qs.toString();
    if (s) url += (url.includes("?") ? "&" : "?") + s;
  } else {
    body = JSON.stringify(clean);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { method, headers: headers(), body, signal: ctrl.signal });
  } catch (e: any) {
    clearTimeout(timer);
    if (e?.name === "AbortError") throw new BridgeError(`RimWorld did not answer within ${timeoutMs / 1000}s (${method} ${path}). The game may be loading or frozen.`);
    throw new BridgeError(
      `Cannot reach RimWorld at ${API_URL} (${e?.cause?.code ?? e?.message}). ` +
        `Is RimWorld running with the "RimWorld AI Bridge" mod enabled? Start it, wait for the main menu, then retry. ` +
        `Set RIMWORLD_API if the port differs.`
    );
  }
  clearTimeout(timer);
  const ct = res.headers.get("content-type") ?? "";
  if (ct.startsWith("image/")) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { image: buf.toString("base64"), mimeType: ct.split(";")[0] } as unknown as T;
  }
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok || json?.ok === false) {
    throw new BridgeError(`${json?.error ?? res.statusText} (HTTP ${res.status}, ${method} ${path})`, res.status, json);
  }
  return json as T;
}

/** Trim the "ok" envelope key and keep responses under the character budget. */
export function present(data: any): { text: string; structured: any } {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const { ok, ...rest } = data;
    data = rest;
  }
  let text = JSON.stringify(data, null, 1);
  if (text.length > CHARACTER_LIMIT) {
    text = text.slice(0, CHARACTER_LIMIT) + `\n… [truncated at ${CHARACTER_LIMIT} chars; use limit/offset/filters to narrow the request]`;
  }
  return { text, structured: data };
}
