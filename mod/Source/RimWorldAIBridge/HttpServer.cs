using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using UnityEngine;
using RimWorld;
using Verse;

namespace RimWorldAIBridge
{
    /// <summary>A parsed request handed to route handlers. Handlers run on the MAIN thread.</summary>
    public sealed class Req
    {
        public string Method;
        public string Path;                       // e.g. "/pawns"
        public string[] Segments;                 // path split on '/'
        public Dictionary<string, string> Query = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, object> Body = new Dictionary<string, object>();

        public string Q(string key, string def = null) => Query.TryGetValue(key, out string v) ? v : def;
        public int QInt(string key, int def) => int.TryParse(Q(key), out int v) ? v : def;
        public bool QBool(string key, bool def = false)
        {
            string v = Q(key);
            if (v == null) return def;
            return v == "1" || v.Equals("true", StringComparison.OrdinalIgnoreCase) || v.Equals("yes", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>Body value, falling back to query string, so GET and POST both work for simple actions.</summary>
        public string Arg(string key, string def = null) => Json.Has(Body, key) ? Json.Str(Body, key) : Q(key, def);
        public int ArgInt(string key, int def = 0) => Json.Has(Body, key) ? Json.Int(Body, key, def) : QInt(key, def);
        public float ArgFloat(string key, float def = 0f) => Json.Has(Body, key) ? Json.Float(Body, key, def) : (float.TryParse(Q(key), out float f) ? f : def);
        public bool ArgBool(string key, bool def = false) => Json.Has(Body, key) ? Json.Bool(Body, key, def) : QBool(key, def);
        public bool HasArg(string key) => Json.Has(Body, key) || Query.ContainsKey(key);
    }

    /// <summary>Raw response for non-JSON payloads (PNG screenshot, HTML dashboard).</summary>
    public sealed class RawResponse
    {
        public byte[] Bytes;
        public string ContentType;
        public int Status = 200;
    }

    /// <summary>
    /// HttpListener bound to loopback. Each request is parsed on the listener thread, then the
    /// route handler is executed on the main thread via MainThread.Run.
    /// </summary>
    public sealed class HttpServer
    {
        public delegate object Handler(Req req);

        private readonly Dictionary<string, Handler> routes = new Dictionary<string, Handler>(StringComparer.OrdinalIgnoreCase);
        private HttpListener listener;
        private Thread thread;
        private volatile bool running;
        public int Port { get; private set; }
        public string Token { get; private set; }
        public long RequestsServed;
        public string LastError;

        public void Route(string method, string path, Handler h) { routes[method.ToUpperInvariant() + " " + path] = h; }
        public void Get(string path, Handler h) => Route("GET", path, h);
        public void Post(string path, Handler h) => Route("POST", path, h);
        /// <summary>Accept both GET and POST for convenience (curl-friendly actions).</summary>
        public void Any(string path, Handler h) { Get(path, h); Post(path, h); }

        public IEnumerable<string> RouteNames => routes.Keys;

        /// <summary>Call a route handler directly (main thread only); used by bulk endpoints.</summary>
        public object Invoke(string routeKey, Req req)
        {
            if (!routes.TryGetValue(routeKey, out Handler h)) throw new BridgeException("No route " + routeKey, 404);
            var result = h(req);
            var env = result as Dictionary<string, object> ?? new Dictionary<string, object> { { "result", result } };
            if (!env.ContainsKey("ok")) env["ok"] = true;
            return env;
        }

        public bool IsRunning => running;

        public void Start(int port, string token)
        {
            Stop();
            Port = port;
            Token = string.IsNullOrWhiteSpace(token) ? null : token.Trim();
            listener = new HttpListener();
            listener.Prefixes.Add("http://127.0.0.1:" + port + "/");
            listener.Prefixes.Add("http://localhost:" + port + "/");
            listener.Start();
            running = true;
            thread = new Thread(Loop) { IsBackground = true, Name = "RimWorldAIBridge.Http" };
            thread.Start();
            Log.Message("[RimWorldAIBridge] HTTP API listening on http://127.0.0.1:" + port + "/  (token " + (Token == null ? "not set" : "required") + ")");
        }

        public void Stop()
        {
            running = false;
            try { listener?.Stop(); listener?.Close(); } catch { }
            listener = null;
            thread = null;
        }

        private void Loop()
        {
            while (running)
            {
                HttpListenerContext ctx;
                try { ctx = listener.GetContext(); }
                catch (Exception) { if (running) Thread.Sleep(50); continue; }
                ThreadPool.QueueUserWorkItem(_ => Handle(ctx));
            }
        }

        private static string currentOwner;
        private static DateTime ownerLeaseExpires = DateTime.MinValue;
        private static readonly object leaseLock = new object();

        public static bool ClaimOwner(string agent, int leaseSec)
        {
            if (string.IsNullOrWhiteSpace(agent)) return false;
            lock (leaseLock)
            {
                if (DateTime.UtcNow < ownerLeaseExpires && currentOwner != null && !string.Equals(currentOwner, agent, StringComparison.OrdinalIgnoreCase))
                    return false;
                currentOwner = agent.Trim();
                ownerLeaseExpires = DateTime.UtcNow.AddSeconds(leaseSec);
                return true;
            }
        }

        public static bool ReleaseOwner(string agent)
        {
            lock (leaseLock)
            {
                if (currentOwner == null) return true;
                if (string.IsNullOrEmpty(agent) || string.Equals(currentOwner, agent, StringComparison.OrdinalIgnoreCase))
                {
                    currentOwner = null;
                    ownerLeaseExpires = DateTime.MinValue;
                    return true;
                }
                return false;
            }
        }

        public static bool CheckOwner(string agent, out string activeOwner, out int remainingSec)
        {
            lock (leaseLock)
            {
                if (DateTime.UtcNow < ownerLeaseExpires && currentOwner != null)
                {
                    activeOwner = currentOwner;
                    remainingSec = (int)Math.Ceiling((ownerLeaseExpires - DateTime.UtcNow).TotalSeconds);
                    return !string.IsNullOrEmpty(agent) && string.Equals(currentOwner, agent, StringComparison.OrdinalIgnoreCase);
                }
                activeOwner = null;
                remainingSec = 0;
                return true;
            }
        }

        private void Handle(HttpListenerContext ctx)
        {
            var res = ctx.Response;
            try
            {
                res.Headers["Access-Control-Allow-Origin"] = "*";
                res.Headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Token, X-Agent-Id";
                res.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
                if (ctx.Request.HttpMethod == "OPTIONS") { res.StatusCode = 204; res.Close(); return; }

                var req = Parse(ctx.Request);
                if (!Authorized(ctx.Request, req)) { WriteJson(res, 401, new Dictionary<string, object> { { "ok", false }, { "error", "Unauthorized: supply the token via X-Token header, Authorization: Bearer, or ?token=" } }); return; }

                // Quick health endpoint (runs off-thread)
                if (req.Method == "GET" && req.Path == "/health")
                {
                    var health = new Dictionary<string, object>
                    {
                        { "ok", true },
                        { "status", "healthy" },
                        { "uptimeSec", (int)(DateTime.UtcNow - Bridge.StartedAt).TotalSeconds },
                        { "requestsServed", Interlocked.Read(ref RequestsServed) },
                        { "bridgeVersion", BridgeMod.Version },
                        { "gameVersion", VersionControl.CurrentVersionStringWithRev },
                        { "loading", LongEventHandler.AnyEventNowOrWaiting },
                        { "programState", Current.ProgramState.ToString() },
                        { "playing", Current.Game != null && Current.ProgramState == ProgramState.Playing }
                    };
                    string owner; int rem;
                    CheckOwner(null, out owner, out rem);
                    if (owner != null) { health["owner"] = owner; health["leaseRemainingSec"] = rem; }
                    WriteJson(res, 200, health, req.QBool("pretty"));
                    return;
                }

                // Agent ownership endpoints (runs off-thread)
                if (req.Path == "/agent/owner")
                {
                    string owner; int rem;
                    CheckOwner(null, out owner, out rem);
                    WriteJson(res, 200, new Dictionary<string, object>
                    {
                        { "ok", true },
                        { "owner", owner },
                        { "leaseRemainingSec", rem },
                        { "isLocked", owner != null }
                    }, req.QBool("pretty"));
                    return;
                }
                if (req.Path == "/agent/claim")
                {
                    string agent = req.Arg("agent");
                    if (string.IsNullOrEmpty(agent)) { WriteJson(res, 400, new Dictionary<string, object> { { "ok", false }, { "error", "Missing 'agent' identifier." } }); return; }
                    int lease = Mathf.Clamp(req.ArgInt("leaseSec", 30), 5, 300);
                    if (ClaimOwner(agent, lease))
                    {
                        WriteJson(res, 200, new Dictionary<string, object> { { "ok", true }, { "claimed", true }, { "agent", agent }, { "leaseSec", lease } }, req.QBool("pretty"));
                    }
                    else
                    {
                        string cur; int curRem;
                        CheckOwner(null, out cur, out curRem);
                        WriteJson(res, 423, new Dictionary<string, object> { { "ok", false }, { "error", "Lease held by " + cur + " for " + curRem + " more seconds." }, { "owner", cur }, { "leaseRemainingSec", curRem } });
                    }
                    return;
                }
                if (req.Path == "/agent/release")
                {
                    string agent = req.Arg("agent");
                    bool ok = ReleaseOwner(agent);
                    WriteJson(res, 200, new Dictionary<string, object> { { "ok", true }, { "released", ok } }, req.QBool("pretty"));
                    return;
                }

                // Mutating route lock check
                string agentId = ctx.Request.Headers["X-Agent-Id"] ?? req.Arg("agent");
                string activeOwner; int remainingSec;
                if (req.Method != "GET" && !CheckOwner(agentId, out activeOwner, out remainingSec))
                {
                    WriteJson(res, 423, new Dictionary<string, object>
                    {
                        { "ok", false },
                        { "error", "Locked: lease held by " + activeOwner + " for " + remainingSec + " more seconds." },
                        { "owner", activeOwner },
                        { "leaseRemainingSec", remainingSec }
                    });
                    return;
                }

                // If game is busy loading or generating world/map, handle immediately
                if (LongEventHandler.AnyEventNowOrWaiting)
                {
                    if (req.Method == "GET" && req.Path == "/status")
                    {
                        var status = new Dictionary<string, object>
                        {
                            { "bridgeVersion", BridgeMod.Version },
                            { "gameVersion", VersionControl.CurrentVersionStringWithRev },
                            { "programState", Current.ProgramState.ToString() },
                            { "playing", Current.Game != null && Current.ProgramState == ProgramState.Playing },
                            { "loading", true },
                            { "uptimeSec", (int)(DateTime.UtcNow - Bridge.StartedAt).TotalSeconds },
                            { "devMode", Prefs.DevMode },
                            { "ok", true }
                        };
                        WriteJson(res, 200, status, req.QBool("pretty"));
                        return;
                    }
                    if (req.Path != "/help" && req.Path != "/")
                    {
                        WriteJson(res, 503, new Dictionary<string, object>
                        {
                            { "ok", false },
                            { "loading", true },
                            { "error", "Game is busy loading or generating world/map. Poll /status until loading=false." }
                        });
                        return;
                    }
                }

                Handler h = Resolve(req);
                if (h == null)
                {
                    WriteJson(res, 404, new Dictionary<string, object> { { "ok", false }, { "error", "No route " + req.Method + " " + req.Path }, { "hint", "GET /help lists every route" } });
                    return;
                }

                object result;
                try { result = MainThread.Run(() => h(req), 60000); }
                catch (Routes.ScreenshotRequest sr)
                {
                    byte[] png = Screenshot.Capture(sr.Width);
                    res.StatusCode = 200; res.ContentType = "image/png"; res.ContentLength64 = png.Length;
                    res.OutputStream.Write(png, 0, png.Length); res.Close();
                    return;
                }
                catch (Routes.WaitRequest wr)
                {
                    // Block this worker thread (never the main thread) until the game reaches the target tick.
                    var deadline = DateTime.UtcNow.AddSeconds(60);
                    int tick = 0; bool forcePaused = false;
                    while (DateTime.UtcNow < deadline)
                    {
                        var st = (int[])MainThread.Run(() => Current.Game == null ? new[] { -1, 0 } : new[] { Find.TickManager.TicksGame, Find.TickManager.ForcePaused ? 1 : 0 });
                        tick = st[0]; forcePaused = st[1] == 1;
                        if (tick < 0 || tick >= wr.Target || forcePaused) break;
                        Thread.Sleep(50);
                    }
                    MainThread.Run(() => { if (Current.Game != null) Find.TickManager.CurTimeSpeed = TimeSpeed.Paused; });
                    long latest = EventLog.LatestSeq;
                    WriteJson(res, 200, new Dictionary<string, object> { { "ok", true }, { "tick", tick }, { "reachedTarget", tick >= wr.Target }, { "forcePaused", forcePaused }, { "latestEventSeq", latest }, { "note", forcePaused ? "A dialog/letter force-paused the game; check /letters and /events." : null } });
                    return;
                }
                catch (BridgeException be)
                {
                    WriteJson(res, be.Status, new Dictionary<string, object> { { "ok", false }, { "error", be.Message }, { "route", req.Method + " " + req.Path } });
                    return;
                }
                catch (TimeoutException te)
                {
                    WriteJson(res, 504, new Dictionary<string, object> { { "ok", false }, { "error", te.Message } });
                    return;
                }
                Interlocked.Increment(ref RequestsServed);

                if (result is RawResponse raw)
                {
                    res.StatusCode = raw.Status;
                    res.ContentType = raw.ContentType;
                    res.ContentLength64 = raw.Bytes.Length;
                    res.OutputStream.Write(raw.Bytes, 0, raw.Bytes.Length);
                    res.Close();
                    return;
                }
                var envelope = result as Dictionary<string, object>;
                if (envelope == null) envelope = new Dictionary<string, object> { { "result", result } };
                if (!envelope.ContainsKey("ok")) envelope["ok"] = true;
                WriteJson(res, 200, envelope, req.QBool("pretty"));
            }
            catch (Exception e)
            {
                LastError = e.ToString();
                Log.Warning("[RimWorldAIBridge] request failed: " + e);
                try { WriteJson(res, 500, new Dictionary<string, object> { { "ok", false }, { "error", e.Message }, { "type", e.GetType().Name } }); } catch { }
            }
        }

        private Handler Resolve(Req req)
        {
            if (routes.TryGetValue(req.Method + " " + req.Path, out Handler h)) return h;
            // Parameterised routes: "/pawn/123" -> "/pawn/*"
            for (int i = req.Segments.Length - 1; i >= 1; i--)
            {
                string prefix = "/" + string.Join("/", req.Segments, 0, i) + "/*";
                if (routes.TryGetValue(req.Method + " " + prefix, out h)) return h;
            }
            return null;
        }

        private bool Authorized(HttpListenerRequest r, Req req)
        {
            if (Token == null) return true;
            string t = r.Headers["X-Token"];
            if (string.IsNullOrEmpty(t))
            {
                string auth = r.Headers["Authorization"];
                if (!string.IsNullOrEmpty(auth) && auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) t = auth.Substring(7).Trim();
            }
            if (string.IsNullOrEmpty(t)) t = req.Q("token");
            return t == Token;
        }

        private static Req Parse(HttpListenerRequest r)
        {
            var req = new Req { Method = r.HttpMethod.ToUpperInvariant() };
            string path = r.Url.AbsolutePath;
            if (path.Length > 1) path = path.TrimEnd('/');
            req.Path = path;
            req.Segments = path.Trim('/').Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries);
            string qs = r.Url.Query;
            if (!string.IsNullOrEmpty(qs))
            {
                foreach (string part in qs.TrimStart('?').Split('&'))
                {
                    if (part.Length == 0) continue;
                    int eq = part.IndexOf('=');
                    string k = Uri.UnescapeDataString(eq < 0 ? part : part.Substring(0, eq)).Replace('+', ' ');
                    string v = eq < 0 ? "" : Uri.UnescapeDataString(part.Substring(eq + 1).Replace('+', ' '));
                    req.Query[k] = v;
                }
            }
            if (r.HasEntityBody)
            {
                using (var sr = new StreamReader(r.InputStream, r.ContentEncoding ?? Encoding.UTF8))
                {
                    string body = sr.ReadToEnd();
                    if (!string.IsNullOrWhiteSpace(body))
                    {
                        try { req.Body = Json.DeserializeObject(body); }
                        catch (Exception e) { throw new BridgeException("Body is not valid JSON: " + e.Message); }
                    }
                }
            }
            return req;
        }

        private static void WriteJson(HttpListenerResponse res, int status, object payload, bool pretty = false)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(Json.Serialize(payload, pretty));
            res.StatusCode = status;
            res.ContentType = "application/json; charset=utf-8";
            res.ContentLength64 = bytes.Length;
            res.OutputStream.Write(bytes, 0, bytes.Length);
            res.Close();
        }
    }
}
