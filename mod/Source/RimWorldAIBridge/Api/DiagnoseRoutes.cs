using System;
using System.Collections.Generic;
using System.Linq;
using RimWorld;
using Verse;
using Verse.AI;

namespace RimWorldAIBridge
{
    /// <summary>
    /// Why nothing is happening.
    ///
    /// Every expensive failure in this project has been an absence rather than an error: wood
    /// that was never counted, a blueprint nobody could pay for, a colonist standing drafted, a
    /// game left paused. An absence produces no exception and no log line, so an agent has to
    /// think to look for it, and it never does.
    ///
    /// These routes turn absence into a positive observation. Three sources, none of them a
    /// threshold invented here:
    ///
    /// - RimWorld's own alert system. AlertsReadout.allAlertTypesCached is the list the game uses
    ///   to tell a human player something is wrong, roughly a hundred conditions with written
    ///   explanations. Reading it is strictly better than any hand-maintained list, for the same
    ///   reason RaceProps.Animal is better than a list of animal names: the game enumerates the
    ///   world, and anything enumerated here goes stale silently.
    /// - The blueprints themselves, which know exactly which material they are short of and by
    ///   how much.
    /// - The pawns' own idle state and the reason the job board is empty for them.
    ///
    /// Design credit: the alert-instantiation approach and the idle/bottleneck framing are taken
    /// from Critical-Reynolds/autorim-mcp (MIT), the stuck-blueprint shortfall string from
    /// Sorcerio/Rimworld-Antfarm (AGPL, idea only).
    /// </summary>
    public static class DiagnoseRoutes
    {
        private static List<Alert> alertInstances;

        /// <summary>
        /// Build one instance of every alert type once. Instantiating on every call would be a
        /// hundred allocations a second; several alert types also throw when their DLC is absent,
        /// so each is isolated and a failure drops that one alert rather than the whole route.
        /// </summary>
        private static List<Alert> Alerts()
        {
            if (alertInstances != null) return alertInstances;
            var made = new List<Alert>();
            try
            {
                foreach (var type in typeof(Alert).AllSubclassesNonAbstract())
                {
                    try { made.Add((Alert)Activator.CreateInstance(type)); }
                    catch { }
                }
            }
            catch (Exception e) { Log.ErrorOnce("[RimWorldAIBridge] could not build alert list: " + e, 8831); }
            alertInstances = made;
            return alertInstances;
        }

        public static void Register(HttpServer s)
        {
            var Doc = new Action<HttpServer, string, string, string, HttpServer.Handler>(Routes.Doc);
            Doc(s, "GET", "/diagnose", "Why nothing is happening. Returns the game's own active alerts with their written explanations, every blueprint that cannot be paid for and exactly what it is short of, every idle colonist with the reason its job board is empty, and the quiet stalls: work types nobody is assigned to, suspended bills, benches that cannot take bills, no research selected. Read this when the colony looks busy and is not, which is the failure mode that never raises an error.", r =>
            {
                var map = Lookup.MapFrom(r);
                var result = new Dictionary<string, object>();

                // 1. RimWorld's own alerts, which is the list a human player is shown.
                var active = new List<Dictionary<string, object>>();
                foreach (var alert in Alerts())
                {
                    try
                    {
                        if (!alert.Active) continue;
                        string label = null, explanation = null;
                        try { label = alert.GetLabel(); } catch { }
                        try { explanation = alert.GetExplanation().Resolve(); } catch { }
                        active.Add(new Dictionary<string, object>
                        {
                            { "label", label ?? alert.GetType().Name },
                            { "priority", alert.Priority.ToString() },
                            { "explanation", explanation },
                        });
                    }
                    catch { }
                }
                result["alerts"] = active
                    .OrderByDescending(d => (string)d["priority"] == "Critical" ? 2 : (string)d["priority"] == "High" ? 1 : 0)
                    .Take(25).ToList();

                // 2. Blueprints and frames that cannot be paid for, and the exact shortfall. This
                //    is the cure for being lied to by omission: rather than inferring from a
                //    resource count whether a build can proceed, the build says what it needs.
                var stuck = new List<Dictionary<string, object>>();
                try
                {
                    foreach (var t in map.listerThings.AllThings)
                    {
                        var bp = t as IConstructible;
                        if (bp == null || !t.Spawned) continue;
                        var missing = new List<string>();
                        foreach (var need in bp.TotalMaterialCost())
                        {
                            int have = map.resourceCounter.GetCount(need.thingDef);
                            int loose = map.listerThings.ThingsOfDef(need.thingDef)
                                .Where(x => x.Spawned && !x.IsForbidden(Faction.OfPlayer))
                                .Sum(x => x.stackCount);
                            int already = bp.ThingCountNeeded(need.thingDef);
                            int outstanding = already;
                            int available = Math.Max(have, loose);
                            if (outstanding > available) missing.Add($"{need.thingDef.defName} (need {outstanding}, have {available})");
                        }
                        if (missing.Count == 0) continue;
                        stuck.Add(new Dictionary<string, object>
                        {
                            { "def", t.def.defName.Replace("Blueprint_", "").Replace("Frame_", "") },
                            { "x", t.Position.x }, { "z", t.Position.z },
                            { "missing", missing },
                        });
                        if (stuck.Count >= 20) break;
                    }
                }
                catch (Exception e) { result["stuckError"] = e.Message; }
                result["stuckBuilds"] = stuck;

                // 3. Colonists doing nothing, and why. "Idle" is the game's own judgement.
                var idle = new List<Dictionary<string, object>>();
                foreach (var p in map.mapPawns.FreeColonistsSpawned)
                {
                    try
                    {
                        bool isIdle = p.mindState?.IsIdle ?? false;
                        if (!isIdle && p.CurJobDef != null && p.CurJobDef != JobDefOf.Wait
                            && p.CurJobDef != JobDefOf.Wait_Wander && p.CurJobDef != JobDefOf.GotoWander) continue;

                        string why;
                        if (p.Drafted) why = "drafted, so it will not take any work";
                        else if (p.InMentalState) why = "in a mental break: " + p.MentalStateDef?.defName;
                        else if (p.WorkTagIsDisabled(WorkTags.AllWork)) why = "cannot do any work at all";
                        else
                        {
                            int enabled = DefDatabase<WorkTypeDef>.AllDefsListForReading
                                .Count(w => !p.WorkTypeIsDisabled(w) && (p.workSettings?.GetPriority(w) ?? 0) > 0);
                            if (enabled == 0) why = "every work type is set to zero";
                            else if (p.playerSettings?.AreaRestrictionInPawnCurrentMap != null)
                                why = $"{enabled} work types enabled but nothing available inside area '{p.playerSettings.AreaRestrictionInPawnCurrentMap.Label}'";
                            else why = $"{enabled} work types enabled but no job is available for any of them";
                        }
                        idle.Add(new Dictionary<string, object>
                        {
                            { "pawn", p.LabelShort }, { "id", p.thingIDNumber },
                            { "job", p.CurJobDef?.defName }, { "why", why },
                        });
                    }
                    catch { }
                }
                result["idleColonists"] = idle;

                // 4. The quiet stalls that never raise anything.
                var stalls = new List<Dictionary<string, object>>();
                try
                {
                    foreach (var wt in DefDatabase<WorkTypeDef>.AllDefsListForReading)
                    {
                        var capable = map.mapPawns.FreeColonistsSpawned.Where(p => !p.WorkTypeIsDisabled(wt)).ToList();
                        if (capable.Count == 0) continue;
                        bool anyAssigned = capable.Any(p => (p.workSettings?.GetPriority(wt) ?? 0) > 0);
                        if (!anyAssigned)
                            stalls.Add(new Dictionary<string, object>
                            {
                                { "kind", "workTypeUnassigned" },
                                { "detail", $"nobody is assigned to {wt.defName} and {capable.Count} colonist(s) could do it" },
                                { "hint", $"POST /set_work {{pawn, work: \\\"{wt.defName}\\\", priority: 3}}" },
                            });
                    }

                    foreach (var b in map.listerBuildings.allBuildingsColonist)
                    {
                        var giver = b as IBillGiver;
                        if (giver == null) continue;
                        var bills = giver.BillStack?.Bills;
                        if (bills == null || bills.Count == 0) continue;
                        int suspended = bills.Count(x => x.suspended);
                        if (suspended > 0)
                            stalls.Add(new Dictionary<string, object>
                            {
                                { "kind", "billsSuspended" },
                                { "detail", $"{b.LabelShort} at {b.Position.x},{b.Position.z} has {suspended} suspended bill(s)" },
                                { "hint", "unsuspend the bill or remove it" },
                            });
                        var usable = b as Building_WorkTable;
                        if (usable != null && !usable.CurrentlyUsableForBills())
                            stalls.Add(new Dictionary<string, object>
                            {
                                { "kind", "benchUnusable" },
                                { "detail", $"{b.LabelShort} at {b.Position.x},{b.Position.z} holds bills but cannot currently be used (unpowered, unreachable, or blocked)" },
                                { "hint", "check power, reachability and whether anything is standing on it" },
                            });
                    }

                    if (Find.ResearchManager.GetProject() == null && DefDatabase<ResearchProjectDef>.AllDefsListForReading.Any(d => d.CanStartNow))
                        stalls.Add(new Dictionary<string, object>
                        {
                            { "kind", "noResearch" },
                            { "detail", "no research project is selected and projects are available" },
                            { "hint", "POST /set_research {project}" },
                        });
                }
                catch (Exception e) { result["stallError"] = e.Message; }
                result["stalls"] = stalls;

                result["summary"] = $"{active.Count} alert(s), {stuck.Count} stalled build(s), {idle.Count} idle colonist(s), {stalls.Count} stall(s)";
                return result;
            });

            Doc(s, "GET", "/heartbeat", "Is the game loop actually running? Returns the tick, whether the game is paused, and how many milliseconds since the mod's main-thread pump last ran. A pump older than about a second means the game is not simulating, whatever the reported speed says: this is readable without touching game state, so it answers the question an agent otherwise cannot ask about itself.", r =>
            {
                long age = MainThread.PumpAgeMs;
                bool playing = Current.ProgramState == ProgramState.Playing;
                return new Dictionary<string, object>
                {
                    { "pumpAgeMs", age },
                    { "loopAlive", age >= 0 && age < 1000 },
                    { "playing", playing },
                    { "paused", playing && (Find.TickManager?.Paused ?? false) },
                    { "speed", playing ? (int)(Find.TickManager?.CurTimeSpeed ?? 0) : 0 },
                    { "tick", playing ? (Find.TickManager?.TicksGame ?? 0) : 0 },
                };
            });
        }
    }
}
