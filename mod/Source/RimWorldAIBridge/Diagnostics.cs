using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using RimWorld;
using Verse;

namespace RimWorldAIBridge
{
    /// <summary>
    /// Why an agent could not tell what the game was doing, and the fix.
    ///
    /// Two whole classes of feedback were invisible over the bridge:
    ///
    /// 1. Floating text over a pawn ("Construction failed", "Harvest failed") is a MoteText, not
    ///    a Messages entry and not a log line. It never reached /events, so an agent watching a
    ///    colonist fail the same build twenty times in a row saw nothing at all.
    /// 2. Stats that decide whether an action can succeed, like ConstructSuccessChance, were
    ///    never exposed, so the agent guessed at odds instead of reading them.
    ///
    /// This module polls once per frame on the main thread, so it needs no Harmony. It watches
    /// construction frames and infers a failure from the game's own state: a frame whose
    /// accumulated work jumps backwards, or one that vanishes without the building appearing,
    /// is a botch. Everything it records is a fact taken from the live game rather than a guess.
    /// </summary>
    public static class Diagnostics
    {
        public sealed class FailureRecord
        {
            public int Tick;
            public string Kind;        // construction | vanished
            public string Def;
            public int X, Z;
            public string Pawn;
            public float WorkBefore;
            public string Note;
        }

        private const int Capacity = 300;
        private static readonly List<FailureRecord> failures = new List<FailureRecord>();
        private static readonly Dictionary<int, FrameSnapshot> watched = new Dictionary<int, FrameSnapshot>();
        private static readonly object sync = new object();
        private static int lastPollTick = -1;

        private sealed class FrameSnapshot
        {
            public string Def;
            public int X, Z;
            public float WorkDone;
            public int LastSeenTick;
        }

        public static void Install()
        {
            MainThread.OnEveryFrame(Poll);
        }

        /// <summary>
        /// Watch every construction frame on the map. A frame's workDone only ever rises while a
        /// build is progressing, so a drop means the game reset it, which is what a failed
        /// construction does. A frame that disappears without the finished building taking its
        /// place is the same event seen from the other side.
        /// </summary>
        private static void Poll()
        {
            try
            {
                if (Current.ProgramState != ProgramState.Playing) return;
                var map = Find.CurrentMap;
                if (map == null) return;

                // Once every 30 ticks is plenty: a frame cannot fail and be rebuilt faster.
                int tick = Find.TickManager.TicksGame;
                if (tick == lastPollTick || tick % 30 != 0) return;
                lastPollTick = tick;

                var live = new HashSet<int>();
                foreach (var t in map.listerThings.AllThings)
                {
                    var frame = t as Frame;
                    if (frame == null) continue;
                    live.Add(frame.thingIDNumber);

                    float work = 0f;
                    try { work = frame.workDone; } catch { }

                    FrameSnapshot prev;
                    lock (sync)
                    {
                        if (watched.TryGetValue(frame.thingIDNumber, out prev))
                        {
                            // Work going backwards is the game discarding progress: a botch.
                            if (work < prev.WorkDone - 0.01f)
                            {
                                Record(new FailureRecord
                                {
                                    Tick = tick,
                                    Kind = "construction",
                                    Def = CleanDef(frame),
                                    X = frame.Position.x,
                                    Z = frame.Position.z,
                                    Pawn = NearestWorker(map, frame),
                                    WorkBefore = prev.WorkDone,
                                    Note = "work reset from " + prev.WorkDone.ToString("F0") + " to " + work.ToString("F0"),
                                });
                            }
                            prev.WorkDone = work;
                            prev.LastSeenTick = tick;
                        }
                        else
                        {
                            watched[frame.thingIDNumber] = new FrameSnapshot
                            {
                                Def = CleanDef(frame),
                                X = frame.Position.x,
                                Z = frame.Position.z,
                                WorkDone = work,
                                LastSeenTick = tick,
                            };
                        }
                    }
                }

                // Frames that are gone: either finished (the building is there) or destroyed.
                lock (sync)
                {
                    var gone = watched.Keys.Where(id => !live.Contains(id)).ToList();
                    foreach (var id in gone)
                    {
                        var snap = watched[id];
                        watched.Remove(id);
                        if (tick - snap.LastSeenTick > 120) continue;   // stale, do not guess
                        bool finished = BuildingAt(map, snap);
                        if (!finished)
                        {
                            Record(new FailureRecord
                            {
                                Tick = tick,
                                Kind = "vanished",
                                Def = snap.Def,
                                X = snap.X,
                                Z = snap.Z,
                                Pawn = null,
                                WorkBefore = snap.WorkDone,
                                Note = "frame disappeared with no finished building in its cell",
                            });
                        }
                    }
                }
            }
            catch (Exception e)
            {
                Log.ErrorOnce("[RimWorldAIBridge] diagnostics poll failed: " + e, 88213);
            }
        }

        private static bool BuildingAt(Map map, FrameSnapshot snap)
        {
            try
            {
                var cell = new IntVec3(snap.X, 0, snap.Z);
                if (!cell.InBounds(map)) return false;
                foreach (var t in map.thingGrid.ThingsListAtFast(cell))
                {
                    if (t is Frame || t is Blueprint) continue;
                    if (t.def.category == ThingCategory.Building) return true;
                }
            }
            catch { }
            return false;
        }

        private static string NearestWorker(Map map, Frame frame)
        {
            try
            {
                Pawn best = null;
                float bestDist = 9f;
                foreach (var p in map.mapPawns.FreeColonistsSpawned)
                {
                    float d = p.Position.DistanceTo(frame.Position);
                    if (d < bestDist) { bestDist = d; best = p; }
                }
                return best?.LabelShort;
            }
            catch { return null; }
        }

        private static string CleanDef(Frame f)
        {
            string s = f.def?.defName ?? "Frame";
            return s.EndsWith("_Frame", StringComparison.Ordinal) ? s.Substring(0, s.Length - 6) : s;
        }

        private static void Record(FailureRecord r)
        {
            failures.Add(r);
            if (failures.Count > Capacity) failures.RemoveRange(0, failures.Count - Capacity);
            EventLog.Add("failure", (r.Kind == "construction" ? "Construction failed: " : "Build lost: ") + r.Def + " at " + r.X + "," + r.Z + (r.Pawn != null ? " (" + r.Pawn + ")" : ""), r.Def, r.X, r.Z);
        }

        public static List<Dictionary<string, object>> Recent(int limit)
        {
            lock (sync)
            {
                return failures.Skip(Math.Max(0, failures.Count - limit)).Select(r => new Dictionary<string, object>
                {
                    { "tick", r.Tick },
                    { "kind", r.Kind },
                    { "def", r.Def },
                    { "x", r.X },
                    { "z", r.Z },
                    { "pawn", r.Pawn },
                    { "workBefore", Math.Round(r.WorkBefore, 1) },
                    { "note", r.Note },
                }).ToList();
            }
        }

        public static Dictionary<string, object> Summary()
        {
            lock (sync)
            {
                var byDef = failures.GroupBy(f => f.Def)
                    .Select(g => new Dictionary<string, object> { { "def", g.Key }, { "failures", g.Count() } })
                    .OrderByDescending(d => (int)d["failures"]).Take(10).ToList();
                return new Dictionary<string, object>
                {
                    { "totalFailures", failures.Count },
                    { "watchedFrames", watched.Count },
                    { "byDef", byDef },
                };
            }
        }

        /// <summary>
        /// The stats that decide whether a pawn's actions succeed, read from the live game.
        /// ConstructSuccessChance is the one that matters here: at Construction 0 it is 0.75, so
        /// one build in four fails, and a zero cost building simply retries immediately, which
        /// is what produced a stack of failure motes over a colonist and no log entry anywhere.
        /// </summary>
        public static Dictionary<string, object> PawnDiagnostics(Pawn p)
        {
            var d = new Dictionary<string, object>
            {
                { "name", p.Name?.ToStringShort ?? p.LabelShort },
                { "id", p.thingIDNumber },
            };

            var stats = new Dictionary<string, object>();
            foreach (var name in new[] { "ConstructSuccessChance", "ConstructionSpeed", "WorkSpeedGlobal",
                                          "MoveSpeed", "PlantWorkSpeed", "HuntingStealth", "MiningSpeed",
                                          "GeneralLaborSpeed", "MeleeHitChance", "MeleeDPS" })
            {
                try
                {
                    var sd = DefDatabase<StatDef>.GetNamedSilentFail(name);
                    if (sd != null) stats[name] = Math.Round(p.GetStatValue(sd), 3);
                }
                catch { }
            }
            d["stats"] = stats;

            try
            {
                var job = p.CurJob;
                d["job"] = job == null ? null : new Dictionary<string, object>
                {
                    { "def", job.def.defName },
                    { "report", SafeReport(p) },
                    { "playerForced", job.playerForced },
                    { "targetA", job.targetA.IsValid ? job.targetA.ToString() : null },
                    { "queued", p.jobs?.jobQueue?.Count ?? 0 },
                    { "tag", p.mindState?.lastJobTag.ToString() },
                };
            }
            catch { }

            if (p.mindState?.mentalStateHandler?.CurState != null)
                d["mentalState"] = p.mindState.mentalStateHandler.CurState.def.defName;

            // Which work types are actually available to this pawn, and which are switched off.
            try
            {
                var disabled = new List<string>();
                var enabled = new Dictionary<string, object>();
                foreach (var wt in DefDatabase<WorkTypeDef>.AllDefsListForReading)
                {
                    if (p.WorkTypeIsDisabled(wt)) { disabled.Add(wt.defName); continue; }
                    int pri = p.workSettings?.GetPriority(wt) ?? 0;
                    if (pri > 0) enabled[wt.defName] = pri;
                }
                d["workEnabled"] = enabled;
                d["workDisabled"] = disabled;
            }
            catch { }

            try
            {
                d["reservations"] = Find.CurrentMap?.reservationManager?.AllReservedThings()
                    ?.Where(t => t != null).Select(t => t.LabelCap).Take(10).ToList();
            }
            catch { }

            return d;
        }

        private static string SafeReport(Pawn p)
        {
            try { return p.jobs?.curDriver?.GetReport(); } catch { return null; }
        }
    }
}
