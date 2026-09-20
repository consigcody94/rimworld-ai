using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using RimWorld;
using RimWorld.Planet;
using UnityEngine;
using UnityEngine.SceneManagement;
using Verse;
using Verse.AI;

namespace RimWorldAIBridge
{
    /// <summary>Every HTTP route. Handlers run on the main thread; throw BridgeException for client errors.</summary>
    public static partial class Routes
    {
        private static readonly List<Dictionary<string, object>> help = new List<Dictionary<string, object>>();

        internal static void Doc(HttpServer s, string method, string path, string desc, HttpServer.Handler h)
        {
            help.Add(new Dictionary<string, object> { { "method", method }, { "path", path }, { "desc", desc } });
            // The help text keeps the readable "{idOrName}" form, but the router only ever looks up
            // the wildcard form, so a parameterised path must be registered as "/pawn/*" or it 404s.
            string route = System.Text.RegularExpressions.Regex.Replace(path, @"\{[^}]+\}", "*");
            if (method == "ANY") s.Any(route, h); else s.Route(method, route, h);
        }

        public static void Register(HttpServer s)
        {
            help.Clear();
            DiagnoseRoutes.Register(s);
            s.Get("/", r => new RawResponse { Bytes = Dashboard.Html(), ContentType = "text/html; charset=utf-8" });
            Doc(s, "GET", "/help", "List every route with a one-line description.", r => new Dictionary<string, object> { { "version", BridgeMod.Version }, { "routes", help } });
            Doc(s, "GET", "/health", "Quick server health check (uptime, requests served, loading state).", r => new Dictionary<string, object>
            {
                { "status", "healthy" },
                { "uptimeSec", (int)(DateTime.UtcNow - Bridge.StartedAt).TotalSeconds },
                { "requestsServed", Interlocked.Read(ref s.RequestsServed) },
                { "bridgeVersion", BridgeMod.Version },
                { "loading", LongEventHandler.AnyEventNowOrWaiting },
                { "programState", Current.ProgramState.ToString() },
                { "playing", Current.Game != null && Current.ProgramState == ProgramState.Playing }
            });
            Doc(s, "POST", "/agent/claim", "Acquire exclusive agent control lease on the colony. {agent, leaseSec:30}", r =>
            {
                string agent = r.Arg("agent");
                int lease = Mathf.Clamp(r.ArgInt("leaseSec", 30), 5, 300);
                bool ok = HttpServer.ClaimOwner(agent, lease);
                return Bridge.Ok("claimed", ok, "agent", agent, "leaseSec", lease);
            });
            Doc(s, "POST", "/agent/release", "Release agent control lease. {agent}", r =>
            {
                string agent = r.Arg("agent");
                bool ok = HttpServer.ReleaseOwner(agent);
                return Bridge.Ok("released", ok);
            });
            Doc(s, "GET", "/agent/owner", "Check current agent lease holder and remaining duration.", r =>
            {
                string owner; int rem;
                HttpServer.CheckOwner(null, out owner, out rem);
                return Bridge.Ok("owner", owner, "leaseRemainingSec", rem, "isLocked", owner != null);
            });
            RegisterObserve(s);
            RegisterActions(s);
            RegisterGame(s);
            RegisterTrade(s);
        }

        // ================================================================== OBSERVE

        private static void RegisterObserve(HttpServer s)
        {
            Doc(s, "GET", "/status", "Program state, version, tick, speed, date, loaded maps. Works on the main menu.", r =>
            {
                bool playing = Current.Game != null && Current.ProgramState == ProgramState.Playing;
                var d = new Dictionary<string, object>
                {
                    { "bridgeVersion", BridgeMod.Version },
                    { "gameVersion", VersionControl.CurrentVersionStringWithRev },
                    { "programState", Current.ProgramState.ToString() },
                    { "scene", SceneManager.GetActiveScene().name },
                    { "playing", playing },
                    { "loading", LongEventHandler.AnyEventNowOrWaiting },
                    { "uptimeSec", (int)(DateTime.UtcNow - Bridge.StartedAt).TotalSeconds },
                    { "activeMods", LoadedModManager.RunningModsListForReading.Select(m => m.PackageId).ToList() },
                    { "devMode", Prefs.DevMode },
                };
                if (playing)
                {
                    var tm = Find.TickManager;
                    d["tick"] = tm.TicksGame;
                    d["speed"] = (int)tm.CurTimeSpeed;
                    d["paused"] = tm.Paused;
                    d["forcePaused"] = tm.ForcePaused;
                    var map = Find.CurrentMap ?? Find.AnyPlayerHomeMap;
                    if (map != null) { d["date"] = Serializers.DateString(map); d["currentMap"] = map.uniqueID; }
                    d["maps"] = Find.Maps.Select(m => new Dictionary<string, object> { { "id", m.uniqueID }, { "index", m.Index }, { "biome", m.Biome.label }, { "isPlayerHome", m.IsPlayerHome }, { "pawns", m.mapPawns.AllPawnsSpawnedCount } }).ToList();
                    d["colonyName"] = Faction.OfPlayer?.Name;
                    d["storyteller"] = Find.Storyteller?.def?.label;
                    d["difficulty"] = Find.Storyteller?.difficultyDef?.label;
                    d["godMode"] = DebugSettings.godMode;
                    d["windowsOpen"] = Find.WindowStack?.Windows.Where(w => w.IsDebug == false && w.GetType().Name.StartsWith("Dialog")).Select(w => w.GetType().Name).ToList();
                }
                return d;
            });

            Doc(s, "GET", "/maps", "List all maps (player home, encounter maps, caravans excluded).", r =>
            {
                Lookup.RequirePlaying();
                return new Dictionary<string, object> { { "maps", Find.Maps.Select(m => Serializers.MapSummary(m, false)).ToList() } };
            });

            Doc(s, "GET", "/map", "Detailed summary of one map (?map=id, default: current/home): weather, date, zones, areas, resources, designations.", r =>
            {
                var map = Lookup.MapFrom(r);
                return Serializers.MapSummary(map, true);
            });

            Doc(s, "GET", "/colony", "One-call situational overview: map summary, resources, alerts, colonist one-liners, threats, research. Start here.", r =>
            {
                var map = Lookup.MapFrom(r);
                var d = new Dictionary<string, object>
                {
                    { "colonyName", Faction.OfPlayer?.Name },
                    { "storyteller", Find.Storyteller?.def?.label + " / " + Find.Storyteller?.difficultyDef?.label },
                    { "map", Serializers.MapSummary(map, false) },
                    { "resources", Serializers.Resources(map, 0) },
                    { "alerts", Alerts() },
                };
                d["colonists"] = map.mapPawns.FreeColonistsSpawned.Select(p => PawnOneLiner(p)).ToList();
                var hostiles = map.mapPawns.AllPawnsSpawned.Where(p => !p.Dead && p.HostileTo(Faction.OfPlayer)).ToList();
                if (hostiles.Count > 0) d["hostiles"] = hostiles.Take(30).Select(p => PawnOneLiner(p)).ToList();
                var proj = Find.ResearchManager.GetProject();
                d["research"] = proj == null ? null : new Dictionary<string, object> { { "project", proj.defName }, { "label", proj.label }, { "progress", Math.Round(proj.ProgressPercent, 2) } };
                d["letters"] = Find.LetterStack.LettersListForReading.Select(l => Serializers.Letter(l, false)).ToList();
                d["quests"] = Find.QuestManager.QuestsListForReading.Where(q => !q.hidden && !q.Historical).Select(q => Serializers.Quest(q, false)).ToList();
                d["speed"] = (int)Find.TickManager.CurTimeSpeed;
                d["paused"] = Find.TickManager.Paused;
                return d;
            });

            Doc(s, "GET", "/snapshot", "Full atomic colony snapshot: status, colonists (health, mood, job), hostiles, alerts, resources, research, letters, and recent events. Perfect for agent decision loops.", r =>
            {
                var map = Lookup.MapFrom(r);
                var d = new Dictionary<string, object>
                {
                    { "tick", Find.TickManager.TicksGame },
                    { "speed", (int)Find.TickManager.CurTimeSpeed },
                    { "paused", Find.TickManager.Paused },
                    { "colonyName", Faction.OfPlayer?.Name },
                    { "date", Serializers.DateString(map) },
                    { "weather", map.weatherManager.curWeather.label },
                    { "temperatureC", Math.Round(map.mapTemperature.OutdoorTemp, 1) },
                    { "colonists", map.mapPawns.FreeColonistsSpawned.Select(p => Serializers.Pawn(p, false)).ToList() },
                    { "alerts", Alerts() },
                    { "resources", Serializers.Resources(map, 0) },
                    { "foodNutrition", Math.Round(map.resourceCounter.TotalHumanEdibleNutrition, 1) },
                    { "events", EventLog.Since(EventLog.LatestSeq > 10 ? EventLog.LatestSeq - 10 : 0, 10) },
                    { "latestEventSeq", EventLog.LatestSeq },
                };
                var hostiles = map.mapPawns.AllPawnsSpawned.Where(p => !p.Dead && p.HostileTo(Faction.OfPlayer)).ToList();
                if (hostiles.Count > 0) d["hostiles"] = hostiles.Take(20).Select(p => Serializers.Pawn(p, false)).ToList();
                var proj = Find.ResearchManager.GetProject();
                d["research"] = proj == null ? null : new Dictionary<string, object> { { "project", proj.defName }, { "label", proj.label }, { "progress", Math.Round(proj.ProgressPercent, 2) } };
                d["letters"] = Find.LetterStack.LettersListForReading.Select(l => Serializers.Letter(l, false)).ToList();
                d["quests"] = Find.QuestManager.QuestsListForReading.Where(q => !q.hidden && !q.Historical).Select(q => Serializers.Quest(q, false)).ToList();
                return d;
            });

            Doc(s, "GET", "/pawns", "List pawns. ?role=colonist|prisoner|slave|colony_animal|enemy|wild_animal|all (default colonist+prisoner+slave+colony_animal) &detail=1 &map=id", r =>
            {
                var map = Lookup.MapFrom(r);
                string role = r.Q("role", "colony");
                bool detail = r.QBool("detail");
                IEnumerable<Pawn> pool = map.mapPawns.AllPawns;
                if (role == "colony") pool = pool.Where(p => p.IsColonist || p.IsPrisonerOfColony || p.IsSlaveOfColony || p.IsColonyMech || (p.RaceProps.Animal && p.Faction == Faction.OfPlayer));
                else if (role != "all") pool = pool.Where(p => Serializers.Role(p) == role);
                var list = pool.Where(p => !p.Dead).OrderBy(p => Serializers.Role(p)).ThenBy(p => p.thingIDNumber).Select(p => Serializers.Pawn(p, detail)).ToList();
                return new Dictionary<string, object> { { "count", list.Count }, { "pawns", list } };
            });

            Doc(s, "GET", "/pawn/{idOrName}", "Full detail for one pawn: skills, work priorities, traits, apparel, thoughts, inspect text.", r =>
            {
                var map = Lookup.MapFrom(r);
                var p = Lookup.FindPawn(map, r.Segments[1]) ?? throw new BridgeException("No pawn '" + r.Segments[1] + "'", 404);
                return Serializers.Pawn(p, true);
            });

            Doc(s, "GET", "/things", "List things on the map. ?cat=Item|Building|Plant|Filth|Ethereal &def=substring &label=substring &rect=x,z,w,h &forbidden=1 &player=1 &limit=100 &offset=0 &detail=1. Blueprints and frames are category Ethereal and are left out of an unfiltered listing; ask for cat=Ethereal, or for a def containing Blueprint or Frame, to see pending builds.", r =>
            {
                var map = Lookup.MapFrom(r);
                string cat = r.Q("cat"); string def = r.Q("def"); string label = r.Q("label");
                int limit = Math.Min(500, r.QInt("limit", 100)); int offset = r.QInt("offset", 0);
                bool detail = r.QBool("detail");
                CellRect? rect = null;
                string rs = r.Q("rect");
                if (rs != null) { var parts = rs.Split(','); if (parts.Length == 4) rect = new CellRect(int.Parse(parts[0]), int.Parse(parts[1]), int.Parse(parts[2]), int.Parse(parts[3])); }
                // Ethereal is where blueprints and frames live, and excluding it unconditionally
                // made every pending build invisible to every query except /cell. The agent
                // therefore believed no room had been ordered, re-ordered rooms it had already
                // paid for, and reported "0 walls already shared" for rooms standing against
                // three finished neighbours. It is still excluded from an unfiltered listing,
                // because a bare /things should not be a wall of blueprint entries, but asking
                // for it by category or by a Blueprint_/Frame_ def name now returns it.
                bool wantsEthereal = string.Equals(cat, "Ethereal", StringComparison.OrdinalIgnoreCase)
                    || (!string.IsNullOrEmpty(def) && (def.IndexOf("Blueprint", StringComparison.OrdinalIgnoreCase) >= 0
                                                    || def.IndexOf("Frame", StringComparison.OrdinalIgnoreCase) >= 0));
                IEnumerable<Thing> pool = map.listerThings.AllThings.Where(t => !(t is Pawn) && t.def.category != ThingCategory.Mote && t.def.category != ThingCategory.Projectile && t.def.category != ThingCategory.Gas && (wantsEthereal || t.def.category != ThingCategory.Ethereal));
                if (!string.IsNullOrEmpty(cat)) pool = pool.Where(t => string.Equals(t.def.category.ToString(), cat, StringComparison.OrdinalIgnoreCase));
                if (!string.IsNullOrEmpty(def)) pool = pool.Where(t => t.def.defName.IndexOf(def, StringComparison.OrdinalIgnoreCase) >= 0);
                if (!string.IsNullOrEmpty(label)) pool = pool.Where(t => t.Label.IndexOf(label, StringComparison.OrdinalIgnoreCase) >= 0);
                if (rect != null) pool = pool.Where(t => rect.Value.Contains(t.Position));
                if (r.QBool("forbidden")) pool = pool.Where(t => t.IsForbidden(Faction.OfPlayer));
                if (r.QBool("player")) pool = pool.Where(t => t.Faction == Faction.OfPlayer);
                if (r.Q("cat") == null && r.Q("def") == null && r.Q("label") == null) pool = pool.Where(t => t.def.category != ThingCategory.Filth && !(t is Plant pl && !pl.def.plant.IsTree && !pl.HarvestableNow && pl.def.plant.harvestedThingDef == null));
                var all = pool.ToList();
                var page = all.Skip(offset).Take(limit).Select(t => Serializers.Thing(t, detail)).ToList();
                return new Dictionary<string, object> { { "total", all.Count }, { "count", page.Count }, { "offset", offset }, { "hasMore", all.Count > offset + page.Count }, { "things", page } };
            });

            Doc(s, "GET", "/thing/{id}", "Detail for one thing (building, item, plant).", r =>
            {
                var map = Lookup.MapFrom(r);
                var t = Lookup.FindThing(map, r.Segments[1]) ?? throw new BridgeException("No thing '" + r.Segments[1] + "'", 404);
                return t is Pawn p ? Serializers.Pawn(p, true) : Serializers.Thing(t, true);
            });

            Doc(s, "GET", "/things/summary", "Counts of things grouped by def (?cat=Building|Item|Plant &player=1). Cheap way to know what the colony has.", r =>
            {
                var map = Lookup.MapFrom(r);
                string cat = r.Q("cat");
                IEnumerable<Thing> pool = map.listerThings.AllThings.Where(t => !(t is Pawn));
                if (!string.IsNullOrEmpty(cat)) pool = pool.Where(t => string.Equals(t.def.category.ToString(), cat, StringComparison.OrdinalIgnoreCase));
                if (r.QBool("player")) pool = pool.Where(t => t.Faction == Faction.OfPlayer);
                var groups = pool.GroupBy(t => t.def.defName).Select(g => new { def = g.Key, label = g.First().def.label, n = g.Sum(t => t.stackCount) }).OrderByDescending(g => g.n).Take(r.QInt("limit", 200));
                return new Dictionary<string, object> { { "groups", groups.Select(g => new Dictionary<string, object> { { "def", g.def }, { "label", g.label }, { "count", g.n } }).ToList() } };
            });

            Doc(s, "GET", "/resources", "Counted stockpiled resources by defName (only items in stockpiles/home count, like the top bar).", r =>
            {
                var map = Lookup.MapFrom(r);
                return new Dictionary<string, object> { { "resources", Serializers.Resources(map, 0) }, { "foodNutrition", Math.Round(map.resourceCounter.TotalHumanEdibleNutrition, 1) } };
            });

            Doc(s, "GET", "/alerts", "Active alerts (the right-edge warnings) with explanations.", r => { Lookup.RequirePlaying(); return new Dictionary<string, object> { { "alerts", Alerts() } }; });

            Doc(s, "GET", "/events", "Event feed: letters, messages, social/battle log. ?since=seq &limit=100. Poll this every turn.", r =>
            {
                long since = long.TryParse(r.Q("since"), out long v) ? v : 0;
                var list = EventLog.Since(since, Math.Min(500, r.QInt("limit", 100)));
                return new Dictionary<string, object> { { "latest", EventLog.LatestSeq }, { "count", list.Count }, { "events", list } };
            });

            Doc(s, "GET", "/letters", "Open letters (envelopes on the right). Choice letters list their options.", r =>
            {
                Lookup.RequirePlaying();
                return new Dictionary<string, object> { { "letters", Find.LetterStack.LettersListForReading.Select(l => Serializers.Letter(l, true)).ToList() } };
            });

            Doc(s, "GET", "/quests", "Quests (available, ongoing). ?all=1 includes historical.", r =>
            {
                Lookup.RequirePlaying();
                bool all = r.QBool("all");
                return new Dictionary<string, object> { { "quests", Find.QuestManager.QuestsListForReading.Where(q => !q.hidden && (all || !q.Historical)).Select(q => Serializers.Quest(q, true)).ToList() } };
            });

            Doc(s, "GET", "/research", "Current project plus projects available to start (?all=1 lists finished too).", r =>
            {
                Lookup.RequirePlaying();
                var cur = Find.ResearchManager.GetProject();
                var avail = DefDatabase<ResearchProjectDef>.AllDefsListForReading.Where(p => p.CanStartNow && !p.IsFinished)
                    .Select(p => new Dictionary<string, object> { { "def", p.defName }, { "label", p.label }, { "cost", p.baseCost }, { "progress", Math.Round(p.ProgressPercent, 2) }, { "techLevel", p.techLevel.ToString() } }).ToList();
                var d = new Dictionary<string, object> { { "current", cur == null ? null : new Dictionary<string, object> { { "def", cur.defName }, { "label", cur.label }, { "progress", Math.Round(cur.ProgressPercent, 2) } } }, { "available", avail } };
                if (r.QBool("all")) d["finished"] = DefDatabase<ResearchProjectDef>.AllDefsListForReading.Where(p => p.IsFinished).Select(p => p.defName).ToList();
                return d;
            });

            Doc(s, "GET", "/grid", "ASCII map for spatial reasoning. ?x=&z=&w=60&h=40 (default: around camera) &scale=1. Legend included.", r =>
            {
                var map = Lookup.MapFrom(r);
                int w = Math.Min(200, r.QInt("w", 60)), h = Math.Min(200, r.QInt("h", 40));
                int scale = Math.Max(1, Math.Min(8, r.QInt("scale", 1)));
                IntVec3 center = Find.CameraDriver != null && Find.CurrentMap == map ? Find.CameraDriver.MapPosition : map.Center;
                int x0 = r.Q("x") != null ? r.QInt("x", 0) : center.x - (w * scale) / 2;
                int z0 = r.Q("z") != null ? r.QInt("z", 0) : center.z - (h * scale) / 2;
                x0 = Mathf.Clamp(x0, 0, Math.Max(0, map.Size.x - w * scale)); z0 = Mathf.Clamp(z0, 0, Math.Max(0, map.Size.z - h * scale));
                var rows = new List<string>();
                var sb = new System.Text.StringBuilder(w);
                for (int rz = h - 1; rz >= 0; rz--)
                {
                    sb.Clear();
                    for (int rx = 0; rx < w; rx++)
                    {
                        char best = ' '; int bestRank = -1;
                        for (int dz = 0; dz < scale; dz++) for (int dx = 0; dx < scale; dx++)
                        {
                            var c = new IntVec3(x0 + rx * scale + dx, 0, z0 + rz * scale + dz);
                            if (!c.InBounds(map)) continue;
                            char ch = GridChar(map, c, out int rank);
                            if (rank > bestRank) { bestRank = rank; best = ch; }
                        }
                        sb.Append(best);
                    }
                    rows.Add(sb.ToString());
                }
                return new Dictionary<string, object>
                {
                    { "x0", x0 }, { "z0", z0 }, { "w", w }, { "h", h }, { "scale", scale },
                    { "note", "rows[0] is the TOP (highest z); row index i => z = z0 + (h-1-i)*scale; column j => x = x0 + j*scale" },
                    { "legend", "C colonist, P prisoner, a colony animal, E enemy, w wild animal, n neutral pawn, # wall/rock, O ore, D door, B player building, b blueprint/frame, T tree, c crop, , wild plant, i item, \" growing zone, : stockpile, ~ water, % marsh, _ built floor, . ground, ? fogged" },
                    { "rows", rows },
                };
            });

            Doc(s, "GET", "/cell", "Everything at one cell: terrain, things, zone, area, roof, fog. ?x=&z=", r =>
            {
                var map = Lookup.MapFrom(r);
                var c = Lookup.CellFrom(r, map);
                var d = new Dictionary<string, object>
                {
                    { "x", c.x }, { "z", c.z },
                    { "terrain", map.terrainGrid.TerrainAt(c).defName },
                    { "fertility", Math.Round(map.terrainGrid.TerrainAt(c).fertility, 2) },
                    { "fogged", map.fogGrid.IsFogged(c) },
                    { "roof", c.GetRoof(map)?.defName },
                    { "standable", c.Standable(map) },
                    { "walkable", c.Walkable(map) },
                    { "home", map.areaManager.Home[c] },
                    { "zone", c.GetZone(map) == null ? null : Serializers.Zone(c.GetZone(map)) },
                    { "things", c.GetThingList(map).Select(t => t is Pawn p ? Serializers.Pawn(p, false) : Serializers.Thing(t, false)).ToList() },
                    { "designations", map.designationManager.AllDesignationsAt(c).Select(x => x.def.defName).ToList() },
                };
                try { d["temperature"] = Math.Round(GenTemperature.GetTemperatureForCell(c, map), 1); } catch { }
                return d;
            });

            Doc(s, "GET", "/defs", "Search definitions. ?type=thing|building|item|plant|recipe|research|work|incident|terrain|storyteller|scenario|difficulty|biome|pawnkind &q=text &limit=50 &buildable=1. Also type=category (ThingCategoryDef, for storage filters) and type=filter (SpecialThingFilterDef, e.g. rotten and fresh toggles).", r =>
            {
                string type = (r.Q("type") ?? "thing").ToLowerInvariant();
                string q = r.Q("q") ?? "";
                int limit = Math.Min(300, r.QInt("limit", 50));
                bool Match(Def d) => q.Length == 0 || d.defName.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0 || (d.label != null && d.label.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0);
                List<Dictionary<string, object>> results;
                switch (type)
                {
                    case "thing": case "building": case "item": case "plant":
                        {
                            IEnumerable<ThingDef> pool = DefDatabase<ThingDef>.AllDefsListForReading.Where(Match);
                            if (type == "building") pool = pool.Where(t => t.category == ThingCategory.Building);
                            if (type == "item") pool = pool.Where(t => t.category == ThingCategory.Item);
                            if (type == "plant") pool = pool.Where(t => t.category == ThingCategory.Plant);
                            if (r.QBool("buildable")) pool = pool.Where(t => t.BuildableByPlayer);
                            results = pool.Take(limit).Select(t =>
                            {
                                var d = new Dictionary<string, object> { { "def", t.defName }, { "label", t.label }, { "cat", t.category.ToString() } };
                                if (t.BuildableByPlayer)
                                {
                                    d["buildable"] = true; d["researched"] = t.IsResearchFinished;
                                    if (t.MadeFromStuff) d["stuffCategories"] = t.stuffCategories?.Select(x => x.defName).ToList();
                                    if (t.costList != null) d["cost"] = t.costList.ToDictionary(x => x.thingDef.defName, x => (object)x.count);
                                    if (t.costStuffCount > 0) d["stuffCount"] = t.costStuffCount;
                                    d["size"] = t.size.x + "x" + t.size.z;
                                    if (t.designationCategory != null) d["buildCategory"] = t.designationCategory.defName;
                                }
                                if (t.plant != null) { d["sowable"] = t.plant.Sowable; d["growDays"] = t.plant.growDays; d["harvest"] = t.plant.harvestedThingDef?.defName; d["minSkill"] = t.plant.sowMinSkill; }
                                if (t.IsStuff) d["isStuff"] = true;
                                if (t.IsWeapon) d["weapon"] = true;
                                if (t.IsApparel) d["apparel"] = true;
                                if (t.IsNutritionGivingIngestible) d["nutrition"] = Math.Round(t.GetStatValueAbstract(StatDefOf.Nutrition), 2);
                                return d;
                            }).ToList();
                            break;
                        }
                    case "category":
                        results = DefDatabase<ThingCategoryDef>.AllDefsListForReading.Where(Match).Take(limit).Select(x => new Dictionary<string, object>
                        {
                            { "def", x.defName }, { "label", x.label },
                            { "parent", x.parent?.defName },
                            { "children", x.childCategories?.Select(c => c.defName).ToList() },
                            { "things", x.childThingDefs?.Select(t => t.defName).Take(25).ToList() },
                        }).ToList();
                        break;
                    case "filter":
                        results = DefDatabase<SpecialThingFilterDef>.AllDefsListForReading.Where(Match).Take(limit).Select(x => new Dictionary<string, object>
                        {
                            { "def", x.defName }, { "label", x.label },
                            { "allowedByDefault", x.allowedByDefault },
                            { "parentCategory", x.parentCategory?.defName },
                        }).ToList();
                        break;
                    case "recipe":
                        results = DefDatabase<RecipeDef>.AllDefsListForReading.Where(Match).Take(limit).Select(x => new Dictionary<string, object> { { "def", x.defName }, { "label", x.label }, { "workbenches", x.AllRecipeUsers.Select(u => u.defName).Take(5).ToList() }, { "researched", x.AvailableNow }, { "products", x.products?.Select(p => p.thingDef.defName + "x" + p.count).ToList() }, { "ingredients", x.ingredients?.Select(i => i.Summary).ToList() } }).ToList();
                        break;
                    case "research":
                        results = DefDatabase<ResearchProjectDef>.AllDefsListForReading.Where(Match).Take(limit).Select(x => new Dictionary<string, object> { { "def", x.defName }, { "label", x.label }, { "cost", x.baseCost }, { "finished", x.IsFinished }, { "canStart", x.CanStartNow }, { "prereqs", x.prerequisites?.Select(p => p.defName).ToList() }, { "unlocks", x.UnlockedDefs.Take(8).Select(u => u.defName).ToList() } }).ToList();
                        break;
                    case "work":
                        results = DefDatabase<WorkTypeDef>.AllDefsListForReading.Where(Match).OrderBy(x => x.naturalPriority).Take(limit).Select(x => new Dictionary<string, object> { { "def", x.defName }, { "label", x.labelShort }, { "description", x.description } }).ToList();
                        break;
                    case "incident":
                        results = DefDatabase<IncidentDef>.AllDefsListForReading.Where(Match).Take(limit).Select(x => new Dictionary<string, object> { { "def", x.defName }, { "label", x.label }, { "category", x.category?.defName } }).ToList();
                        break;
                    case "terrain":
                        results = DefDatabase<TerrainDef>.AllDefsListForReading.Where(Match).Take(limit).Select(x => new Dictionary<string, object> { { "def", x.defName }, { "label", x.label }, { "buildable", x.BuildableByPlayer }, { "fertility", x.fertility } }).ToList();
                        break;
                    case "storyteller":
                        results = DefDatabase<StorytellerDef>.AllDefsListForReading.Where(Match).Select(x => new Dictionary<string, object> { { "def", x.defName }, { "label", x.label } }).ToList();
                        break;
                    case "scenario":
                        results = DefDatabase<ScenarioDef>.AllDefsListForReading.Where(Match).Select(x => new Dictionary<string, object> { { "def", x.defName }, { "label", x.label } }).ToList();
                        break;
                    case "difficulty":
                        results = DefDatabase<DifficultyDef>.AllDefsListForReading.Where(Match).Select(x => new Dictionary<string, object> { { "def", x.defName }, { "label", x.label } }).ToList();
                        break;
                    case "biome":
                        results = DefDatabase<BiomeDef>.AllDefsListForReading.Where(Match).Select(x => new Dictionary<string, object> { { "def", x.defName }, { "label", x.label } }).ToList();
                        break;
                    case "pawnkind":
                        results = DefDatabase<PawnKindDef>.AllDefsListForReading.Where(Match).Take(limit).Select(x => new Dictionary<string, object> { { "def", x.defName }, { "label", x.label }, { "race", x.race?.defName } }).ToList();
                        break;
                    default: throw new BridgeException("Unknown def type '" + type + "'.");
                }
                return new Dictionary<string, object> { { "type", type }, { "count", results.Count }, { "defs", results } };
            });

            Doc(s, "GET", "/survey", "What is actually within reach, counted from the world rather than from the stockpile ledger. ?x=&z=&r=45 (defaults to the first colonist). Returns materials with their true totals including loose stacks, food, corpses by kind, huntable animals with distance and body size, grown trees, growing crops, threats, and unclaimed items. This is the route to read before deciding anything: /resources counts only what has been hauled into a stockpile, so a colony with three hundred wood lying where the trees fell reads as having none.", r =>
            {
                var map = Lookup.MapFrom(r);
                IntVec3 origin;
                var firstColonist = map.mapPawns.FreeColonistsSpawned.FirstOrDefault();
                if (r.HasArg("x") || r.HasArg("z")) origin = new IntVec3(r.QInt("x", map.Center.x), 0, r.QInt("z", map.Center.z));
                else origin = firstColonist?.Position ?? map.Center;
                int radius = Math.Max(5, Math.Min(120, r.QInt("r", 45)));
                float r2 = radius * radius;
                bool Near(IntVec3 c) => (c - origin).LengthHorizontalSquared <= r2;

                var materials = new Dictionary<string, int>();
                var food = new Dictionary<string, int>();
                var corpses = new Dictionary<string, int>();
                var weapons = new List<Dictionary<string, object>>();
                var apparel = 0;
                int forbidden = 0, unhauled = 0;

                foreach (var t in map.listerThings.AllThings)
                {
                    if (t == null || !t.Spawned || !Near(t.Position)) continue;
                    try
                    {
                        if (t is Corpse corpse)
                        {
                            string kind = corpse.InnerPawn?.RaceProps?.Humanlike == true ? "humanlike"
                                : corpse.InnerPawn?.RaceProps?.Insect == true ? "insect"
                                : corpse.InnerPawn?.RaceProps?.IsMechanoid == true ? "mechanoid" : "animal";
                            corpses[kind] = corpses.TryGetValue(kind, out int n) ? n + 1 : 1;
                            continue;
                        }
                        if (t.def.category != ThingCategory.Item) continue;
                        int stack = t.stackCount;
                        if (t.IsForbidden(Faction.OfPlayer)) forbidden++;

                        // Order matters, and one predicate here is a trap. ThingDef.IsWeapon is
                        // true for WoodLog: a log counts as an improvised melee weapon, so asking
                        // "is this a weapon" before "is this a building material" filed two
                        // hundred and sixty four logs under weapons and reported the colony as
                        // having no wood. Something a colonist can pick up and swing is only a
                        // weapon here if it is actually equipment; stuff is stuff.
                        bool isStuff = t.def.IsStuff;
                        bool isEquipment = t.def.equipmentType != EquipmentType.None && !isStuff;
                        if (t.def.IsNutritionGivingIngestible) food[t.def.defName] = (food.TryGetValue(t.def.defName, out int f) ? f : 0) + stack;
                        else if (isEquipment) weapons.Add(new Dictionary<string, object> { { "def", t.def.defName }, { "label", t.LabelShort }, { "x", t.Position.x }, { "z", t.Position.z } });
                        else if (t.def.IsApparel) apparel++;
                        else materials[t.def.defName] = (materials.TryGetValue(t.def.defName, out int m) ? m : 0) + stack;
                        // Sitting outside any stockpile is exactly what /resources cannot see.
                        if (t.Position.GetZone(map) == null && t.def.EverHaulable) unhauled += stack;
                    }
                    catch { }
                }

                // Plants worth work: trees with wood in them, and wild food that is grown enough
                // to be worth the walk. Ungrown plants are noise, and the agent used to designate
                // ornamental bushes because it could not tell the difference.
                int treesGrown = 0, wildFoodGrown = 0, cropsSown = 0, cropsRipe = 0;
                foreach (var t in map.listerThings.AllThings)
                {
                    var plant = t as Plant;
                    if (plant == null || !Near(plant.Position)) continue;
                    try
                    {
                        bool grown = plant.Growth >= 0.55f;
                        if (plant.def.plant?.IsTree == true) { if (grown) treesGrown++; }
                        else if (plant.def.plant?.harvestedThingDef?.IsNutritionGivingIngestible == true)
                        {
                            if (plant.def.plant.Sowable && plant.Position.GetZone(map) is Zone_Growing)
                            { cropsSown++; if (plant.HarvestableNow) cropsRipe++; }
                            else if (plant.Growth >= 0.32f) wildFoodGrown++;
                        }
                    }
                    catch { }
                }

                var game = new List<Dictionary<string, object>>();
                var threats = new List<Dictionary<string, object>>();
                foreach (var p in map.mapPawns.AllPawnsSpawned)
                {
                    if (p == null || p.Dead || !Near(p.Position)) continue;
                    try
                    {
                        if (p.HostileTo(Faction.OfPlayer) && !p.Downed)
                        {
                            threats.Add(new Dictionary<string, object>
                            {
                                { "id", p.thingIDNumber }, { "label", p.LabelShortCap },
                                { "humanlike", p.RaceProps?.Humanlike == true },
                                { "distance", (int)p.Position.DistanceTo(origin) },
                            });
                            continue;
                        }
                        if (p.RaceProps?.Animal != true || p.Faction != null) continue;
                        // Everything the colony could eat, described so the agent never needs a
                        // hardcoded list of animal names to recognise a meal.
                        game.Add(new Dictionary<string, object>
                        {
                            { "id", p.thingIDNumber }, { "kind", p.kindDef?.defName }, { "label", p.LabelShortCap },
                            { "distance", (int)p.Position.DistanceTo(origin) },
                            { "bodySize", Math.Round(p.BodySize, 2) },
                            { "meat", (int)p.GetStatValue(StatDefOf.MeatAmount) },
                            { "predator", p.RaceProps.predator },
                            { "manhunterChance", Math.Round(p.RaceProps.manhunterOnDamageChance, 2) },
                            { "safeToHuntBarehanded", !p.RaceProps.predator && p.BodySize <= 0.5f && p.RaceProps.manhunterOnDamageChance <= 0.15f },
                        });
                    }
                    catch { }
                }
                game = game.OrderBy(d => (int)d["distance"]).Take(12).ToList();

                return new Dictionary<string, object>
                {
                    { "origin", new Dictionary<string, object> { { "x", origin.x }, { "z", origin.z } } },
                    { "radius", radius },
                    { "materials", materials },
                    { "food", food },
                    { "unhauledItems", unhauled },
                    { "forbiddenItems", forbidden },
                    { "corpses", corpses },
                    { "weaponsOnGround", weapons.Take(8).ToList() },
                    { "apparelOnGround", apparel },
                    { "treesGrown", treesGrown },
                    { "wildFoodGrown", wildFoodGrown },
                    { "cropsSown", cropsSown },
                    { "cropsRipe", cropsRipe },
                    { "game", game },
                    { "threats", threats },
                };
            });

            Doc(s, "GET", "/fertility", "Find ground worth farming. Scans a rect and returns the best blocks of sowable soil, ranked by average fertility, so crops go on rich soil rather than gravel. ?x=&z=&w=60&h=60&block=6&min=0.9&limit=8. Rich soil is 1.4, ordinary soil 1.0, gravel 0.7; below about 0.7 nothing worth eating will grow.", r =>
            {
                var map = Lookup.MapFrom(r);
                int cx = r.QInt("x", map.Center.x), cz = r.QInt("z", map.Center.z);
                int w = Math.Min(120, r.QInt("w", 60)), h = Math.Min(120, r.QInt("h", 60));
                int block = Math.Max(2, Math.Min(12, r.QInt("block", 6)));
                float min = r.ArgFloat("min", 0.9f);
                int limit = Math.Min(30, r.QInt("limit", 8));

                var results = new List<Dictionary<string, object>>();
                int x0 = cx - w / 2, z0 = cz - h / 2;
                for (int bx = x0; bx + block <= x0 + w; bx += Math.Max(1, block / 2))
                {
                    for (int bz = z0; bz + block <= z0 + h; bz += Math.Max(1, block / 2))
                    {
                        float sum = 0f; int cells = 0; bool blocked = false;
                        for (int x = bx; x < bx + block && !blocked; x++)
                        {
                            for (int z = bz; z < bz + block; z++)
                            {
                                var c = new IntVec3(x, 0, z);
                                if (!c.InBounds(map) || map.fogGrid.IsFogged(c)) { blocked = true; break; }
                                var ter = map.terrainGrid.TerrainAt(c);
                                // A growing zone cannot sit on a constructed floor or under a roof.
                                if (ter.fertility <= 0f || c.GetRoof(map) != null) { blocked = true; break; }
                                if (c.GetEdifice(map) != null) { blocked = true; break; }
                                sum += ter.fertility; cells++;
                            }
                        }
                        if (blocked || cells == 0) continue;
                        float avg = sum / cells;
                        if (avg < min) continue;
                        results.Add(new Dictionary<string, object>
                        {
                            { "x", bx }, { "z", bz }, { "w", block }, { "h", block },
                            { "fertility", Math.Round(avg, 2) },
                            { "distanceFromCentre", (int)new IntVec3(bx + block / 2, 0, bz + block / 2).DistanceTo(new IntVec3(cx, 0, cz)) },
                        });
                    }
                }
                var best = results
                    .OrderByDescending(d => (double)d["fertility"])
                    .ThenBy(d => (int)d["distanceFromCentre"])
                    .Take(limit).ToList();
                return new Dictionary<string, object> { { "scanned", results.Count }, { "best", best } };
            });

            Doc(s, "GET", "/debug/failures", "Construction and build failures the bridge detected, which never appear in /events because the game shows them as floating text over the pawn rather than as messages. ?limit=50", r =>
            {
                Lookup.RequirePlaying();
                return new Dictionary<string, object> { { "summary", Diagnostics.Summary() }, { "failures", Diagnostics.Recent(r.QInt("limit", 50)) } };
            });

            Doc(s, "GET", "/debug/pawn/{idOrName}", "Why a pawn can or cannot do something: the stats that decide success (ConstructSuccessChance and friends), current job and who assigned it, mental state, and every work type with its priority or why it is disabled.", r =>
            {
                var map = Lookup.MapFrom(r);
                var p = Lookup.FindPawn(map, r.Segments[2]) ?? throw new BridgeException("No pawn '" + r.Segments[2] + "'", 404);
                return Diagnostics.PawnDiagnostics(p);
            });

            Doc(s, "GET", "/screenshot", "PNG of the current frame. ?width=1024 downscales. Returns image/png (not JSON).", r =>
            {
                int width = r.QInt("width", 1024);
                // Runs a coroutine; must not block the main thread here, so hand off to the capture helper from the worker thread.
                throw new ScreenshotRequest(width);
            });
        }

        /// <summary>Marker exception so the HTTP layer can run the coroutine-based capture off the main thread.</summary>
        public sealed class ScreenshotRequest : BridgeException { public int Width; public ScreenshotRequest(int w) : base("screenshot") { Width = w; } }

        private static Dictionary<string, object> PawnOneLiner(Pawn p)
        {
            var d = new Dictionary<string, object> { { "id", p.thingIDNumber }, { "name", p.Name?.ToStringShort ?? p.LabelShort }, { "role", Serializers.Role(p) } };
            if (p.Spawned) { d["x"] = p.Position.x; d["z"] = p.Position.z; }
            d["hp"] = Math.Round(p.health.summaryHealth.SummaryHealthPercent, 2);
            if (p.needs?.mood != null) d["mood"] = Math.Round(p.needs.mood.CurLevelPercentage, 2);
            if (p.needs?.food != null) d["food"] = Math.Round(p.needs.food.CurLevelPercentage, 2);
            if (p.Downed) d["downed"] = true;
            if (p.Drafted) d["drafted"] = true;
            if (p.MentalStateDef != null) d["mentalState"] = p.MentalStateDef.label;
            if (p.health.hediffSet.BleedRateTotal > 0) d["bleeding"] = true;
            try { d["doing"] = p.jobs?.curDriver?.GetReport(); } catch { }
            if (p.equipment?.Primary != null) d["weapon"] = p.equipment.Primary.LabelCap;
            return d;
        }

        private static List<Dictionary<string, object>> Alerts()
        {
            var list = new List<Dictionary<string, object>>();
            var readout = Find.Alerts;
            if (readout == null) return list;
            var field = typeof(AlertsReadout).GetField("activeAlerts", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
            var active = field?.GetValue(readout) as List<Alert>;
            if (active == null) return list;
            foreach (var a in active)
            {
                var d = new Dictionary<string, object> { { "label", a.Label }, { "priority", a.Priority.ToString() } };
                try { d["explanation"] = Lookup.Truncate(a.GetExplanation().RawText, 400); } catch { }
                try
                {
                    var rep = a.GetReport();
                    var culprits = rep.AllCulprits.Where(c => c.IsValid).Take(5).Select(c => c.HasThing ? c.Thing.LabelShort + "#" + c.Thing.thingIDNumber : c.Cell.x + "," + c.Cell.z).ToList();
                    if (culprits.Count > 0) d["culprits"] = culprits;
                }
                catch { }
                list.Add(d);
            }
            return list;
        }

        private static char GridChar(Map map, IntVec3 c, out int rank)
        {
            if (map.fogGrid.IsFogged(c)) { rank = 0; return '?'; }
            var things = c.GetThingList(map);
            Thing building = null, plant = null, item = null; Pawn pawn = null; bool blueprint = false;
            for (int i = 0; i < things.Count; i++)
            {
                var t = things[i];
                if (t is Pawn p) { if (pawn == null || p.IsColonist) pawn = p; }
                else if (t.def.category == ThingCategory.Building) building = t;
                else if (t.def.category == ThingCategory.Plant) plant = t;
                else if (t.def.category == ThingCategory.Item) item = t;
                else if (t.def.IsBlueprint || t.def.IsFrame) blueprint = true;
            }
            if (pawn != null)
            {
                rank = 10;
                switch (Serializers.Role(pawn))
                {
                    case "colonist": case "slave": case "colony_mech": return 'C';
                    case "prisoner": return 'P';
                    case "colony_animal": return 'a';
                    case "enemy": case "hostile_animal": case "mech": return 'E';
                    case "wild_animal": return 'w';
                    default: return 'n';
                }
            }
            if (building != null)
            {
                rank = 8;
                var bd = building.def;
                if (building is Building_Door) return 'D';
                if (bd.mineable) return bd.building != null && bd.building.isResourceRock ? 'O' : '#';
                if (bd.IsEdifice() && bd.passability == Traversability.Impassable && building.Faction == Faction.OfPlayer && bd.fillPercent >= 1f) return '#';
                if (bd.IsEdifice() && bd.passability == Traversability.Impassable && building.Faction != Faction.OfPlayer && bd.building != null && bd.building.isNaturalRock) return '#';
                return building.Faction == Faction.OfPlayer ? 'B' : (bd.passability == Traversability.Impassable ? '#' : 'B');
            }
            if (blueprint) { rank = 7; return 'b'; }
            if (plant != null)
            {
                rank = 6;
                var pd = plant.def.plant;
                if (pd.IsTree) return 'T';
                if (pd.Sowable && c.GetZone(map) is Zone_Growing) return 'c';
                if (pd.harvestedThingDef != null) return 'c';
                return ',';
            }
            if (item != null) { rank = 5; return 'i'; }
            var zone = c.GetZone(map);
            if (zone is Zone_Growing) { rank = 3; return '"'; }
            if (zone is Zone_Stockpile) { rank = 3; return ':'; }
            var terrain = map.terrainGrid.TerrainAt(c);
            rank = 1;
            if (terrain.IsWater) return '~';
            if (terrain.defName.IndexOf("Marsh", StringComparison.OrdinalIgnoreCase) >= 0 || terrain.defName.IndexOf("Mud", StringComparison.OrdinalIgnoreCase) >= 0) return '%';
            if (terrain.BuildableByPlayer || terrain.layerable) return '_';
            return '.';
        }
    }
}
