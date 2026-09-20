using System;
using System.Collections.Generic;
using System.Linq;
using RimWorld;
using RimWorld.Planet;
using UnityEngine;
using Verse;
using Verse.AI;

namespace RimWorldAIBridge
{
    public static partial class Routes
    {
        private static void RegisterActions(HttpServer s)
        {
            // ---------------------------------------------------------- time
            Doc(s, "ANY", "/speed", "Set game speed. {speed:0..4} 0=pause 1=normal 2=fast 3=superfast 4=ultra. Omit speed to toggle pause.", r =>
            {
                Lookup.RequirePlaying();
                var tm = Find.TickManager;
                if (r.HasArg("speed"))
                {
                    int sp = Mathf.Clamp(r.ArgInt("speed", 1), 0, 4);
                    tm.CurTimeSpeed = (TimeSpeed)sp;
                }
                else tm.TogglePaused();
                return Bridge.Ok("speed", (int)tm.CurTimeSpeed, "paused", tm.Paused, "forcePaused", tm.ForcePaused, "note", tm.ForcePaused ? "A dialog is force-pausing the game; close it via /letter/dismiss or /dialog/close." : null);
            });

            Doc(s, "ANY", "/wait", "Advance the game by N ticks then pause (simulation step for turn-based agents). {ticks:600, speed:3}. Returns when done or after 60 s.", r =>
            {
                Lookup.RequirePlaying();
                int ticks = Mathf.Clamp(r.ArgInt("ticks", 600), 1, 60000);
                int speed = Mathf.Clamp(r.ArgInt("speed", 3), 1, 4);
                var tm = Find.TickManager;
                int target = tm.TicksGame + ticks;
                tm.CurTimeSpeed = (TimeSpeed)speed;
                WaitUntilTick = target;
                throw new WaitRequest(target);
            });

            // ---------------------------------------------------------- pawn orders
            Doc(s, "ANY", "/draft", "Draft or undraft. {pawn, drafted:true}", r =>
            {
                var map = Lookup.MapFrom(r); var p = Lookup.PawnFrom(r, map);
                if (p.drafter == null) throw new BridgeException(p.LabelShort + " cannot be drafted (not a controllable colonist).");
                bool v = r.ArgBool("drafted", true);
                p.drafter.Drafted = v;
                return Bridge.Ok("pawn", p.thingIDNumber, "drafted", p.Drafted);
            });

            Doc(s, "ANY", "/move", "Order a pawn to walk to a cell. {pawn, x, z, draft:false}. Drafts first if draft=true (needed for combat positioning).", r =>
            {
                var map = Lookup.MapFrom(r); var p = Lookup.PawnFrom(r, map); var c = Lookup.CellFrom(r, map);
                if (!p.CanReach(c, PathEndMode.OnCell, Danger.Deadly)) throw new BridgeException(p.LabelShort + " cannot reach " + c.x + "," + c.z + " (unreachable or not walkable).");
                if (r.ArgBool("draft") && p.drafter != null) p.drafter.Drafted = true;
                var job = JobMaker.MakeJob(JobDefOf.Goto, c);
                job.playerForced = true;
                bool ok = p.jobs.TryTakeOrderedJob(job, JobTag.Misc);
                return Bridge.Ok("pawn", p.thingIDNumber, "accepted", ok, "drafted", p.Drafted);
            });

            Doc(s, "ANY", "/attack", "Order a pawn to attack a target thing/pawn (uses ranged if it has a gun). {pawn, target, draft:true}", r =>
            {
                var map = Lookup.MapFrom(r); var p = Lookup.PawnFrom(r, map);
                var target = Lookup.ThingFrom(r, map, "target");
                if (p.drafter != null && r.ArgBool("draft", true)) p.drafter.Drafted = true;
                var action = FloatMenuUtility.GetAttackAction(p, new LocalTargetInfo(target), out string failStr);
                if (action == null) throw new BridgeException("Cannot attack: " + (string.IsNullOrEmpty(failStr) ? "no valid attack" : failStr));
                action();
                return Bridge.Ok("pawn", p.thingIDNumber, "target", target.thingIDNumber, "job", p.CurJob?.def.defName);
            });

            Doc(s, "ANY", "/job", "Generic ordered job. {pawn, job:JobDef, targetA: thingId|[x,z], targetB, targetC, count, queue:false}. e.g. job=Rescue targetA=downedPawnId targetB=bedId; job=Ingest; job=Equip; job=Wear; job=HaulToCell targetA=item targetB=[x,z].", r =>
            {
                var map = Lookup.MapFrom(r); var p = Lookup.PawnFrom(r, map);
                var def = Lookup.Def<JobDef>(r.Arg("job"), "JobDef");
                LocalTargetInfo a = Target(r, map, "targetA"), b = Target(r, map, "targetB"), c = Target(r, map, "targetC");
                var job = JobMaker.MakeJob(def, a, b, c);
                if (r.HasArg("count")) job.count = r.ArgInt("count", -1);
                job.playerForced = true;
                bool ok = p.jobs.TryTakeOrderedJob(job, JobTag.Misc, r.ArgBool("queue"));
                if (!ok) throw new BridgeException("Job was rejected by the pawn (check reachability, drafted state, and that targets are valid for " + def.defName + ").");
                return Bridge.Ok("pawn", p.thingIDNumber, "job", def.defName, "report", SafeReport(p));
            });

            Doc(s, "ANY", "/job/cancel", "Stop the pawn's current job and clear its queue. {pawn}", r =>
            {
                var map = Lookup.MapFrom(r); var p = Lookup.PawnFrom(r, map);
                p.jobs.ClearQueuedJobs();
                p.jobs.EndCurrentJob(JobCondition.InterruptForced);
                return Bridge.Ok("pawn", p.thingIDNumber);
            });

            Doc(s, "ANY", "/equip", "Equip a weapon or wear apparel lying on the map. {pawn, thing}", r =>
            {
                var map = Lookup.MapFrom(r); var p = Lookup.PawnFrom(r, map); var t = Lookup.ThingFrom(r, map);
                JobDef def = t.def.IsWeapon ? JobDefOf.Equip : t.def.IsApparel ? JobDefOf.Wear : throw new BridgeException(t.LabelCap + " is neither a weapon nor apparel.");
                if (!p.CanReserveAndReach(t, PathEndMode.ClosestTouch, Danger.Deadly)) throw new BridgeException(p.LabelShort + " cannot reach or reserve " + t.LabelCap + ".");
                var job = JobMaker.MakeJob(def, t); job.playerForced = true;
                bool ok = p.jobs.TryTakeOrderedJob(job, JobTag.Misc);
                return Bridge.Ok("pawn", p.thingIDNumber, "accepted", ok, "job", def.defName);
            });

            Doc(s, "ANY", "/work", "Set a work priority. {pawn, work:WorkTypeDef (e.g. Doctor, Cooking, Hauling), priority:0..4} 0=disabled 1=highest. Enables manual priorities.", r =>
            {
                var map = Lookup.MapFrom(r); var p = Lookup.PawnFrom(r, map);
                if (p.workSettings == null || !p.workSettings.EverWork) throw new BridgeException(p.LabelShort + " has no work settings.");
                var wt = Lookup.Def<WorkTypeDef>(r.Arg("work"), "WorkTypeDef");
                if (p.WorkTypeIsDisabled(wt)) throw new BridgeException(p.LabelShort + " is incapable of " + wt.labelShort + ".");
                int pr = Mathf.Clamp(r.ArgInt("priority", 3), 0, 4);
                Current.Game.playSettings.useWorkPriorities = true;
                p.workSettings.SetPriority(wt, pr);
                return Bridge.Ok("pawn", p.thingIDNumber, "work", wt.defName, "priority", p.workSettings.GetPriority(wt));
            });

            Doc(s, "ANY", "/work/bulk", "Set many priorities at once. {pawn, priorities:{Doctor:1, Cooking:2, ...}}", r =>
            {
                var map = Lookup.MapFrom(r); var p = Lookup.PawnFrom(r, map);
                var pri = Json.Obj(r.Body, "priorities") ?? throw new BridgeException("Missing 'priorities' object.");
                Current.Game.playSettings.useWorkPriorities = true;
                var applied = new Dictionary<string, object>(); var errors = new List<string>();
                foreach (var kv in pri)
                {
                    var wt = DefDatabase<WorkTypeDef>.GetNamedSilentFail(kv.Key);
                    if (wt == null) { errors.Add("unknown work type " + kv.Key); continue; }
                    if (p.WorkTypeIsDisabled(wt)) { errors.Add(p.LabelShort + " incapable of " + wt.defName); continue; }
                    p.workSettings.SetPriority(wt, Mathf.Clamp(Convert.ToInt32(kv.Value), 0, 4));
                    applied[wt.defName] = p.workSettings.GetPriority(wt);
                }
                return Bridge.Ok("pawn", p.thingIDNumber, "applied", applied, "errors", errors);
            });

            Doc(s, "ANY", "/pawn/settings", "Per-pawn settings. {pawn, hostility:Flee|Attack|Ignore, medicalCare:NoCare|NoMeds|HerbalOrWorse|NormalOrWorse|Best, area:areaLabel|none, selfTend:bool}", r =>
            {
                var map = Lookup.MapFrom(r); var p = Lookup.PawnFrom(r, map);
                if (p.playerSettings == null) throw new BridgeException("Pawn has no player settings.");
                if (r.HasArg("hostility")) p.playerSettings.hostilityResponse = (HostilityResponseMode)Enum.Parse(typeof(HostilityResponseMode), r.Arg("hostility"), true);
                if (r.HasArg("medicalCare")) p.playerSettings.medCare = (MedicalCareCategory)Enum.Parse(typeof(MedicalCareCategory), r.Arg("medicalCare"), true);
                if (r.HasArg("selfTend")) p.playerSettings.selfTend = r.ArgBool("selfTend");
                if (r.HasArg("area"))
                {
                    string a = r.Arg("area");
                    Area area = a == "none" || a == "" ? null : map.areaManager.AllAreas.FirstOrDefault(x => string.Equals(x.Label, a, StringComparison.OrdinalIgnoreCase) || x.ID.ToString() == a);
                    if (area == null && a != "none" && a != "") throw new BridgeException("No area '" + a + "'.");
                    p.playerSettings.AreaRestrictionInPawnCurrentMap = area;
                }
                if (r.HasArg("prisonerMode") && p.guest != null)
                {
                    string pm = r.Arg("prisonerMode");
                    var mode = DefDatabase<PrisonerInteractionModeDef>.AllDefsListForReading.FirstOrDefault(x => string.Equals(x.defName, pm, StringComparison.OrdinalIgnoreCase) || string.Equals(x.label, pm, StringComparison.OrdinalIgnoreCase));
                    if (mode != null) p.guest.SetExclusiveInteraction(mode);
                }
                return Bridge.Ok("pawn", Serializers.Pawn(p, true));
            });

            Doc(s, "ANY", "/pawn/schedule", "Configure colonist 24h timetable. {pawn, preset:'optimal'|'work'|'joy'|'anything' | hours:['Sleep', ...]}. optimal: sleep 0-5, work 7-19, joy 20-21. work: crisis timetable, sleep 0-3 and 23, work 4-22. joy: all recreation. anything: unassigned.", r =>
            {
                var map = Lookup.MapFrom(r); var p = Lookup.PawnFrom(r, map);
                if (p.timetable == null) throw new BridgeException(p.LabelShort + " has no timetable.");

                string preset = r.Arg("preset");
                if (!string.IsNullOrEmpty(preset))
                {
                    if (preset.Equals("optimal", StringComparison.OrdinalIgnoreCase))
                    {
                        for (int h = 0; h <= 5; h++) p.timetable.SetAssignment(h, TimeAssignmentDefOf.Sleep);
                        p.timetable.SetAssignment(6, TimeAssignmentDefOf.Anything);
                        for (int h = 7; h <= 19; h++) p.timetable.SetAssignment(h, TimeAssignmentDefOf.Work);
                        p.timetable.SetAssignment(20, TimeAssignmentDefOf.Joy);
                        p.timetable.SetAssignment(21, TimeAssignmentDefOf.Joy);
                        p.timetable.SetAssignment(22, TimeAssignmentDefOf.Sleep);
                        p.timetable.SetAssignment(23, TimeAssignmentDefOf.Sleep);
                    }
                    else if (preset.Equals("joy", StringComparison.OrdinalIgnoreCase))
                    {
                        for (int h = 0; h < 24; h++) p.timetable.SetAssignment(h, TimeAssignmentDefOf.Joy);
                    }
                    else if (preset.Equals("work", StringComparison.OrdinalIgnoreCase))
                    {
                        // Crisis timetable: the minimum sleep a pawn can take without collapsing,
                        // everything else on work. Use while starving or racing a deadline.
                        for (int h = 0; h <= 3; h++) p.timetable.SetAssignment(h, TimeAssignmentDefOf.Sleep);
                        for (int h = 4; h <= 22; h++) p.timetable.SetAssignment(h, TimeAssignmentDefOf.Work);
                        p.timetable.SetAssignment(23, TimeAssignmentDefOf.Sleep);
                    }
                    else if (preset.Equals("anything", StringComparison.OrdinalIgnoreCase))
                    {
                        for (int h = 0; h < 24; h++) p.timetable.SetAssignment(h, TimeAssignmentDefOf.Anything);
                    }
                    else
                    {
                        throw new BridgeException("Unknown preset '" + preset + "'. Use optimal, work, joy or anything.");
                    }
                }
                else if (r.HasArg("hours"))
                {
                    var hrs = Json.List(r.Body, "hours");
                    if (hrs != null)
                    {
                        for (int h = 0; h < Math.Min(24, hrs.Count); h++)
                        {
                            string defName = hrs[h]?.ToString();
                            var def = DefDatabase<TimeAssignmentDef>.GetNamedSilentFail(defName);
                            if (def != null) p.timetable.SetAssignment(h, def);
                        }
                    }
                }

                var current = new List<string>();
                for (int h = 0; h < 24; h++) current.Add(p.timetable.GetAssignment(h)?.defName);
                return Bridge.Ok("pawn", p.thingIDNumber, "timetable", current);
            });

            Doc(s, "ANY", "/bed/settings", "Configure a bed. {thing: bedId, forPrisoners: bool, medical: bool}", r =>
            {
                var map = Lookup.MapFrom(r);
                var t = Lookup.FindThing(map, r.Arg("thing"));
                if (!(t is Building_Bed bed)) throw new BridgeException("Thing is not a bed.");
                if (r.HasArg("forPrisoners")) bed.ForPrisoners = r.ArgBool("forPrisoners");
                if (r.HasArg("medical")) bed.Medical = r.ArgBool("medical");
                return Bridge.Ok("bed", t.thingIDNumber, "forPrisoners", bed.ForPrisoners, "medical", bed.Medical);
            });

            // ---------------------------------------------------------- designations
            Doc(s, "ANY", "/designate", "Designate cells/things for work. {type: mine|cancel|harvest|cut|chop|hunt|tame|haul|deconstruct|uninstall|slaughter|strip|open|claim|smooth|removeFloor, cells:[[x,z]] | rect:{x,z,w,h} | things:[id]}", r =>
            {
                var map = Lookup.MapFrom(r);
                string type = (r.Arg("type") ?? "").ToLowerInvariant();
                Designator d = MakeDesignator(type);
                var cells = Lookup.CellsFrom(r, map, false);
                var things = Lookup.ThingsFrom(r, map, false);
                if (cells.Count == 0 && things.Count == 0) throw new BridgeException("Provide cells, rect, or things.");
                int ok = 0; var rejected = new List<string>();
                var accepted = new List<IntVec3>();
                foreach (var c in cells)
                {
                    var rep = d.CanDesignateCell(c);
                    if (rep.Accepted) accepted.Add(c); else if (rejected.Count < 10) rejected.Add(c.x + "," + c.z + ": " + rep.Reason);
                }
                if (accepted.Count > 0) { d.DesignateMultiCell(accepted); ok += accepted.Count; }
                foreach (var t in things)
                {
                    var rep = d.CanDesignateThing(t);
                    if (rep.Accepted) { d.DesignateThing(t); ok++; } else if (rejected.Count < 10) rejected.Add(t.LabelShort + "#" + t.thingIDNumber + ": " + rep.Reason);
                }
                return Bridge.Ok("type", type, "designated", ok, "rejected", rejected);
            });

            Doc(s, "ANY", "/build", "Place a blueprint. {def:ThingDef|TerrainDef, x, z, rot:0-3, stuff:ThingDef (e.g. WoodLog, BlocksGranite, Steel)}. Colonists with Construction will build it.", r =>
            {
                var map = Lookup.MapFrom(r);
                string name = r.Arg("def");
                BuildableDef def = DefDatabase<ThingDef>.GetNamedSilentFail(name) ?? (BuildableDef)DefDatabase<TerrainDef>.GetNamedSilentFail(name);
                if (def == null) throw new BridgeException("Unknown buildable '" + name + "'. Try GET /defs?type=building&buildable=1&q=" + name, 404);
                if (!def.BuildableByPlayer) throw new BridgeException(def.defName + " is not buildable by the player.");
                if (!def.IsResearchFinished && !DebugSettings.godMode) throw new BridgeException(def.defName + " requires research: " + string.Join(", ", def.researchPrerequisites?.Select(x => x.defName) ?? new string[0]));
                var c = Lookup.CellFrom(r, map);
                var rot = Lookup.RotFrom(r);
                ThingDef stuff = null;
                if (def.MadeFromStuff)
                {
                    string st = r.Arg("stuff");
                    stuff = string.IsNullOrEmpty(st) ? GenStuff.DefaultStuffFor(def) : Lookup.Def<ThingDef>(st, "stuff ThingDef");
                    if (!stuff.IsStuff || !def.stuffCategories.Any(sc => stuff.stuffProps.categories.Contains(sc))) throw new BridgeException(stuff.defName + " is not a valid material for " + def.defName + ".");
                }
                var report = GenConstruct.CanPlaceBlueprintAt(def, c, rot, map, DebugSettings.godMode, null, null, stuff);
                if (!report.Accepted) throw new BridgeException("Cannot place " + def.defName + " at " + c.x + "," + c.z + ": " + report.Reason);
                Thing placed;
                if (DebugSettings.godMode && def is ThingDef td)
                {
                    var t = ThingMaker.MakeThing(td, stuff); t.SetFactionDirect(Faction.OfPlayer);
                    placed = GenSpawn.Spawn(t, c, map, rot);
                }
                else placed = GenConstruct.PlaceBlueprintForBuild(def, c, map, rot, Faction.OfPlayer, stuff);
                return Bridge.Ok("placed", placed?.thingIDNumber, "def", def.defName, "x", c.x, "z", c.z, "rot", rot.AsInt, "stuff", stuff?.defName);
            });

            Doc(s, "ANY", "/build/bulk", "Place many blueprints. {items:[{def,x,z,rot,stuff},...]} Returns per-item results.", r =>
            {
                var items = Json.List(r.Body, "items") ?? throw new BridgeException("Missing 'items' array.");
                var results = new List<object>();
                foreach (var o in items)
                {
                    var sub = new Req { Method = "POST", Path = "/build", Segments = new[] { "build" }, Body = o as Dictionary<string, object> ?? new Dictionary<string, object>(), Query = r.Query };
                    try { results.Add(Bridge.Server.RouteNames.Contains("POST /build") ? Invoke("POST /build", sub) : null); }
                    catch (BridgeException e) { results.Add(new Dictionary<string, object> { { "ok", false }, { "error", e.Message } }); }
                }
                return Bridge.Ok("results", results);
            });

            Doc(s, "ANY", "/zone", "Create a zone. {type: stockpile|dumping|growing, cells|rect, plant:ThingDef (growing), priority:Low|Normal|Preferred|Important|Critical (stockpile), label}", r =>
            {
                var map = Lookup.MapFrom(r);
                string type = (r.Arg("type") ?? "stockpile").ToLowerInvariant();
                var cells = Lookup.CellsFrom(r, map);
                Designator_ZoneAdd d;
                switch (type)
                {
                    case "stockpile": d = new Designator_ZoneAddStockpile_Resources(); break;
                    case "dumping": d = new Designator_ZoneAddStockpile_Dumping(); break;
                    case "growing": d = new Designator_ZoneAdd_Growing(); break;
                    default: throw new BridgeException("type must be stockpile, dumping or growing.");
                }
                var before = new HashSet<Zone>(map.zoneManager.AllZones);
                var accepted = cells.Where(c => d.CanDesignateCell(c).Accepted).ToList();
                if (accepted.Count == 0) throw new BridgeException("No cell is valid for a " + type + " zone (already zoned, not standable, or fogged).");
                d.DesignateMultiCell(accepted);
                var zone = map.zoneManager.AllZones.FirstOrDefault(z => !before.Contains(z)) ?? map.zoneManager.ZoneAt(accepted[0]);
                if (zone == null) throw new BridgeException("Zone creation failed.", 500);
                if (zone is Zone_Growing g && r.HasArg("plant")) g.SetPlantDefToGrow(Lookup.Def<ThingDef>(r.Arg("plant"), "plant ThingDef"));
                if (zone is Zone_Stockpile sp && r.HasArg("priority")) sp.settings.Priority = (StoragePriority)Enum.Parse(typeof(StoragePriority), r.Arg("priority"), true);
                if (r.HasArg("label")) zone.label = r.Arg("label");
                return Bridge.Ok("zone", Serializers.Zone(zone), "rejectedCells", cells.Count - accepted.Count);
            });

            Doc(s, "ANY", "/zone/update", "Modify a zone. {id, plant, allowSow, priority, label, addCells|removeCells:[[x,z]], delete:true}", r =>
            {
                var map = Lookup.MapFrom(r);
                int id = r.ArgInt("id", -1);
                var zone = map.zoneManager.AllZones.FirstOrDefault(z => z.ID == id) ?? throw new BridgeException("No zone with id " + id + ". GET /map lists zones.", 404);
                if (r.ArgBool("delete")) { zone.Delete(); return Bridge.Ok("deleted", id); }
                if (zone is Zone_Growing g)
                {
                    if (r.HasArg("plant")) g.SetPlantDefToGrow(Lookup.Def<ThingDef>(r.Arg("plant"), "plant ThingDef"));
                    if (r.HasArg("allowSow")) g.allowSow = r.ArgBool("allowSow");
                }
                if (zone is Zone_Stockpile sp && r.HasArg("priority")) sp.settings.Priority = (StoragePriority)Enum.Parse(typeof(StoragePriority), r.Arg("priority"), true);
                if (r.HasArg("label")) zone.label = r.Arg("label");
                var add = Json.List(r.Body, "addCells"); var rem = Json.List(r.Body, "removeCells");
                if (add != null) foreach (var o in add) if (o is List<object> pr && pr.Count >= 2) { var c = new IntVec3(Convert.ToInt32(pr[0]), 0, Convert.ToInt32(pr[1])); if (c.InBounds(map) && c.GetZone(map) == null) zone.AddCell(c); }
                if (rem != null) foreach (var o in rem) if (o is List<object> pr && pr.Count >= 2) { var c = new IntVec3(Convert.ToInt32(pr[0]), 0, Convert.ToInt32(pr[1])); if (zone.ContainsCell(c)) zone.RemoveCell(c); }
                return Bridge.Ok("zone", Serializers.Zone(zone));
            });

            Doc(s, "ANY", "/area/home", "Add or remove cells from the Home area. {cells|rect, add:true}", r =>
            {
                var map = Lookup.MapFrom(r);
                var cells = Lookup.CellsFrom(r, map);
                bool add = r.ArgBool("add", true);
                var home = map.areaManager.Home;
                foreach (var c in cells) home[c] = add;
                return Bridge.Ok("changed", cells.Count, "homeCells", home.TrueCount);
            });

            Doc(s, "ANY", "/forbid", "Forbid/allow items (Allow Tool). {forbidden:bool (default true), all:bool, home:bool, cells|rect, def:string, things:[id]}. 'all:true' targets entire map.", r =>
            {
                return ForbidHandler(r, true);
            });

            Doc(s, "ANY", "/allow", "Allow (unforbid) items. Shorthand for /forbid with forbidden=false. {all:bool, home:bool, cells|rect, def:string, things:[id]}.", r =>
            {
                return ForbidHandler(r, false);
            });

            Doc(s, "ANY", "/bill", "Add a production bill to a workbench. {thing: benchId, recipe:RecipeDef, mode:forever|count|target, count:10, suspended:false}", r =>
            {
                var map = Lookup.MapFrom(r);
                var bench = Lookup.ThingFrom(r, map);
                var giver = bench as IBillGiver ?? throw new BridgeException(bench.LabelCap + " does not take bills.");
                var recipe = Lookup.Def<RecipeDef>(r.Arg("recipe"), "RecipeDef");
                if (!bench.def.AllRecipes.Contains(recipe)) throw new BridgeException(recipe.defName + " cannot be made at " + bench.def.defName + ". Valid: " + string.Join(", ", bench.def.AllRecipes.Select(x => x.defName).Take(30)));
                if (!recipe.AvailableNow) throw new BridgeException(recipe.defName + " is not available yet (research).");
                var bill = recipe.MakeNewBill();
                if (bill is Bill_Production bp)
                {
                    string mode = (r.Arg("mode") ?? "count").ToLowerInvariant();
                    int count = r.ArgInt("count", 10);
                    if (mode == "forever") bp.repeatMode = BillRepeatModeDefOf.Forever;
                    else if (mode == "target") { bp.repeatMode = BillRepeatModeDefOf.TargetCount; bp.targetCount = count; }
                    else { bp.repeatMode = BillRepeatModeDefOf.RepeatCount; bp.repeatCount = count; }
                }
                bill.suspended = r.ArgBool("suspended");
                giver.BillStack.AddBill(bill);
                return Bridge.Ok("bench", bench.thingIDNumber, "bill", bill.LabelCap, "bills", giver.BillStack.Bills.Select(b => b.LabelCap).ToList());
            });

            Doc(s, "ANY", "/bill/remove", "Remove bills from a workbench. {thing: benchId, index:0 | all:true}", r =>
            {
                var map = Lookup.MapFrom(r);
                var bench = Lookup.ThingFrom(r, map);
                var giver = bench as IBillGiver ?? throw new BridgeException("Not a bill giver.");
                if (r.ArgBool("all")) { giver.BillStack.Clear(); return Bridge.Ok("bills", 0); }
                int idx = r.ArgInt("index", -1);
                if (idx < 0 || idx >= giver.BillStack.Count) throw new BridgeException("index out of range (0.." + (giver.BillStack.Count - 1) + ")");
                giver.BillStack.Delete(giver.BillStack[idx]);
                return Bridge.Ok("bills", giver.BillStack.Bills.Select(b => b.LabelCap).ToList());
            });

            Doc(s, "POST", "/research", "Set the current research project. {project:ResearchProjectDef}", r =>
            {
                Lookup.RequirePlaying();
                var proj = Lookup.Def<ResearchProjectDef>(r.Arg("project"), "ResearchProjectDef");
                if (proj.IsFinished) throw new BridgeException(proj.defName + " is already finished.");
                if (!proj.CanStartNow) throw new BridgeException(proj.defName + " cannot start now (prerequisites: " + string.Join(", ", proj.prerequisites?.Where(p => !p.IsFinished).Select(p => p.defName) ?? new string[0]) + ").");
                Find.ResearchManager.SetCurrentProject(proj);
                return Bridge.Ok("project", proj.defName, "progress", Math.Round(proj.ProgressPercent, 2));
            });

            Doc(s, "ANY", "/letter/choose", "Pick an option on a choice letter (accept quest, etc.). {id: letterId, choice: index|label}", r =>
            {
                Lookup.RequirePlaying();
                int id = r.ArgInt("id", -1);
                var letter = Find.LetterStack.LettersListForReading.FirstOrDefault(l => l.ID == id) ?? throw new BridgeException("No open letter with id " + id, 404);
                var cl = letter as ChoiceLetter ?? throw new BridgeException("Letter " + id + " has no choices; use /letter/dismiss.");
                var choices = cl.Choices.ToList();
                string ch = r.Arg("choice") ?? "0";
                DiaOption opt = int.TryParse(ch, out int idx) && idx >= 0 && idx < choices.Count ? choices[idx] : choices.FirstOrDefault(o => string.Equals(Lookup.OptionText(o), ch, StringComparison.OrdinalIgnoreCase));
                if (opt == null) throw new BridgeException("No choice '" + ch + "'. Options: " + string.Join(" | ", choices.Select((o, i) => i + "=" + Lookup.OptionText(o))));
                if (opt.disabled) throw new BridgeException("Choice '" + Lookup.OptionText(opt) + "' is disabled: " + opt.disabledReason);
                opt.action?.Invoke();
                if (opt.resolveTree && Find.LetterStack.LettersListForReading.Contains(letter) && !(letter is ChoiceLetter c2 && c2.quest != null && c2.quest.State == QuestState.NotYetAccepted)) { }
                return Bridge.Ok("letter", id, "chose", Lookup.OptionText(opt), "stillOpen", Find.LetterStack.LettersListForReading.Contains(letter));
            });

            Doc(s, "ANY", "/letter/dismiss", "Remove a letter from the stack. {id} or {all:true}", r =>
            {
                Lookup.RequirePlaying();
                if (r.ArgBool("all")) { foreach (var l in Find.LetterStack.LettersListForReading.ToList()) Find.LetterStack.RemoveLetter(l); return Bridge.Ok("remaining", 0); }
                int id = r.ArgInt("id", -1);
                var letter = Find.LetterStack.LettersListForReading.FirstOrDefault(l => l.ID == id) ?? throw new BridgeException("No open letter with id " + id, 404);
                Find.LetterStack.RemoveLetter(letter);
                return Bridge.Ok("remaining", Find.LetterStack.LettersListForReading.Count);
            });

            Doc(s, "ANY", "/quest/accept", "Accept a quest by id (from /quests).", r =>
            {
                Lookup.RequirePlaying();
                int id = r.ArgInt("id", -1);
                var q = Find.QuestManager.QuestsListForReading.FirstOrDefault(x => x.id == id) ?? throw new BridgeException("No quest " + id, 404);
                if (q.State != QuestState.NotYetAccepted) throw new BridgeException("Quest is " + q.State);
                q.Accept(null);
                return Bridge.Ok("quest", Serializers.Quest(q, false));
            });

            Doc(s, "ANY", "/dialog/close", "Close the topmost dialog window (e.g. a pause-forcing popup). {all:true} closes all closable dialogs.", r =>
            {
                Lookup.RequirePlaying();
                var ws = Find.WindowStack;
                int n = 0;
                foreach (var w in ws.Windows.ToList())
                {
                    if (w is RimWorld.Dialog_GiveName gn)
                    {
                        string colonyName = Faction.OfPlayer?.Name ?? "Caveman Empire";
                        try
                        {
                            var mNamed = typeof(RimWorld.Dialog_GiveName).GetMethod("Named", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
                            mNamed?.Invoke(gn, new object[] { colonyName });
                            var mSecond = typeof(RimWorld.Dialog_GiveName).GetMethod("NamedSecond", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
                            mSecond?.Invoke(gn, new object[] { colonyName });
                        }
                        catch {}
                        gn.Close(false);
                        ws.TryRemove(gn);
                        n++;
                        if (!r.ArgBool("all")) break;
                        continue;
                    }
                    if (w.GetType().Name.StartsWith("Dialog") || w.GetType().Name.StartsWith("Page"))
                    {
                        ws.TryRemove(w); n++;
                        if (!r.ArgBool("all")) break;
                    }
                }
                return Bridge.Ok("closed", n);
            });

            Doc(s, "ANY", "/camera", "Move the camera. {x, z, zoom:10..60, pawn, follow:bool}. Smoothly positions camera and optionally follows pawn.", r =>
            {
                var map = Lookup.MapFrom(r);
                if (Find.CurrentMap != map) Current.Game.CurrentMap = map;
                float zoom = r.HasArg("zoom") ? Mathf.Clamp(r.ArgFloat("zoom", 24f), 8f, 80f) : Find.CameraDriver.RootSize;

                if (r.HasArg("pawn"))
                {
                    var p = Lookup.PawnFrom(r, map);
                    if (p != null)
                    {
                        FollowCamera.SetTarget(p, zoom);
                        if (r.ArgBool("select", true))
                        {
                            Find.Selector.ClearSelection();
                            Find.Selector.Select(p, playSound: false);
                        }
                        return Bridge.Ok("camera", Lookup.Cell(p.Position), "zoom", Math.Round(zoom, 1), "pawn", p.LabelShort, "following", true);
                    }
                }

                if (r.HasArg("x") && r.HasArg("z"))
                {
                    var cell = Lookup.CellFrom(r, map);
                    FollowCamera.Enabled = false;
                    Find.CameraDriver.SetRootPosAndSize(cell.ToVector3Shifted(), zoom);
                    Find.CameraDriver.JumpToCurrentMapLoc(cell);
                    return Bridge.Ok("camera", Lookup.Cell(cell), "zoom", Math.Round(zoom, 1));
                }

                if (r.HasArg("zoom"))
                {
                    FollowCamera.DesiredZoom = zoom;
                    Find.CameraDriver.SetRootPosAndSize(Find.CameraDriver.MapPosition.ToVector3Shifted(), zoom);
                }
                return Bridge.Ok("camera", Lookup.Cell(Find.CameraDriver.MapPosition), "zoom", Math.Round(Find.CameraDriver.RootSize, 1));
            });

            Doc(s, "ANY", "/camera/follow", "Configure smooth follow camera. {pawn, enabled:bool, deadzone:float, zoom:float, speed:float}", r =>
            {
                var map = Lookup.MapFrom(r);
                if (r.HasArg("enabled")) FollowCamera.Enabled = r.ArgBool("enabled");
                if (r.HasArg("deadzone")) FollowCamera.Deadzone = Mathf.Clamp(r.ArgFloat("deadzone", 3.2f), 0.5f, 15f);
                if (r.HasArg("zoom")) FollowCamera.DesiredZoom = Mathf.Clamp(r.ArgFloat("zoom", 21f), 8f, 60f);
                if (r.HasArg("speed")) FollowCamera.SmoothSpeed = Mathf.Clamp(r.ArgFloat("speed", 4.2f), 1f, 20f);
                if (r.HasArg("pawn"))
                {
                    var p = Lookup.PawnFrom(r, map);
                    if (p != null) FollowCamera.SetTarget(p, r.HasArg("zoom") ? (float?)FollowCamera.DesiredZoom : null);
                }
                return Bridge.Ok("enabled", FollowCamera.Enabled, "target", FollowCamera.Target?.LabelShort, "deadzone", FollowCamera.Deadzone, "zoom", FollowCamera.DesiredZoom, "speed", FollowCamera.SmoothSpeed);
            });

            Doc(s, "ANY", "/chat/push", "Push a live Twitch chat message to the in-game HUD overlay. {user, text, color}", r =>
            {
                string user = r.Arg("user");
                string text = r.Arg("text");
                string color = r.Arg("color");
                if (string.IsNullOrEmpty(user) || string.IsNullOrEmpty(text)) throw new BridgeException("Must provide user and text.");
                TwitchChatHUD.AddMessage(user, text, color);
                return Bridge.Ok("pushed", true, "user", user, "text", text);
            });

            Doc(s, "ANY", "/chat/clear", "Clear in-game Twitch chat HUD messages.", r =>
            {
                TwitchChatHUD.ClearMessages();
                return Bridge.Ok("cleared", true);
            });

            Doc(s, "ANY", "/select", "Select things in the UI (so a human watching sees what the AI is acting on). {things:[id]} or {pawn}", r =>
            {
                var map = Lookup.MapFrom(r);
                Find.Selector.ClearSelection();
                var things = Lookup.ThingsFrom(r, map, false);
                if (r.HasArg("pawn")) things.Add(Lookup.PawnFrom(r, map));
                foreach (var t in things) Find.Selector.Select(t, playSound: false);
                return Bridge.Ok("selected", things.Count);
            });

            Doc(s, "ANY", "/notify", "Show an in-game message to the human player. {text, type:neutral|positive|negative|threat}. Also logged to /events.", r =>
            {
                Lookup.RequirePlaying();
                string text = r.Arg("text") ?? throw new BridgeException("Missing text.");
                MessageTypeDef def;
                switch ((r.Arg("type") ?? "neutral").ToLowerInvariant())
                {
                    case "positive": def = MessageTypeDefOf.PositiveEvent; break;
                    case "negative": def = MessageTypeDefOf.NegativeEvent; break;
                    case "threat": def = MessageTypeDefOf.ThreatBig; break;
                    default: def = MessageTypeDefOf.NeutralEvent; break;
                }
                Messages.Message("[AI] " + text, def, false);
                EventLog.Add("bridge", text, "ai-note");
                return Bridge.Ok();
            });

            Doc(s, "ANY", "/dev", "Dev toggles (require 'allow dev actions' in mod settings). {godMode:bool, devMode:bool}", r =>
            {
                RequireDev();
                if (r.HasArg("devMode")) Prefs.DevMode = r.ArgBool("devMode");
                if (r.HasArg("godMode")) DebugSettings.godMode = r.ArgBool("godMode");
                return Bridge.Ok("devMode", Prefs.DevMode, "godMode", DebugSettings.godMode);
            });

            Doc(s, "ANY", "/dev/incident", "Fire an incident now (raid, trader, etc.). {def:IncidentDef, points:0}. GET /defs?type=incident to search.", r =>
            {
                RequireDev();
                var map = Lookup.MapFrom(r);
                var def = Lookup.Def<IncidentDef>(r.Arg("def"), "IncidentDef");
                var parms = StorytellerUtility.DefaultParmsNow(def.category, map);
                parms.forced = true;
                if (r.ArgFloat("points") > 0) parms.points = r.ArgFloat("points");
                bool ok = def.Worker.TryExecute(parms);
                return Bridge.Ok("fired", ok, "def", def.defName, "points", Math.Round(parms.points));
            });

            Doc(s, "ANY", "/dev/spawn", "Spawn things (god mode helper). {def, x, z, count:1, stuff}", r =>
            {
                RequireDev();
                var map = Lookup.MapFrom(r);
                var def = Lookup.Def<ThingDef>(r.Arg("def"), "ThingDef");
                var c = Lookup.CellFrom(r, map);
                ThingDef stuff = def.MadeFromStuff ? (r.HasArg("stuff") ? Lookup.Def<ThingDef>(r.Arg("stuff"), "stuff") : GenStuff.DefaultStuffFor(def)) : null;
                var t = ThingMaker.MakeThing(def, stuff);
                t.stackCount = Mathf.Clamp(r.ArgInt("count", 1), 1, def.stackLimit);
                GenPlace.TryPlaceThing(t, c, map, ThingPlaceMode.Near);
                return Bridge.Ok("spawned", t.thingIDNumber, "label", t.LabelCap);
            });
        }

        private static void RequireDev()
        {
            if (BridgeMod.Settings != null && !BridgeMod.Settings.allowDevActions) throw new BridgeException("Dev actions are disabled in mod settings.", 403);
        }

        private static object ForbidHandler(Req r, bool defaultForbidden)
        {
            var map = Lookup.MapFrom(r);
            bool forbidden = defaultForbidden;
            if (r.HasArg("forbidden")) forbidden = r.ArgBool("forbidden");
            else if (r.HasArg("unforbid")) forbidden = !r.ArgBool("unforbid");

            bool all = r.ArgBool("all", false);
            bool homeOnly = r.ArgBool("home", false);
            string defFilter = r.Arg("def");

            List<Thing> candidates = null;

            if (all || homeOnly)
            {
                var items = map.listerThings.AllThings.Where(t => t.def.category == ThingCategory.Item || t is Building);
                if (homeOnly)
                {
                    var home = map.areaManager.Home;
                    items = items.Where(t => home[t.Position]);
                }
                candidates = items.ToList();
            }
            else
            {
                var cells = Lookup.CellsFrom(r, map, required: false);
                if (cells != null && cells.Count > 0)
                {
                    var set = new HashSet<IntVec3>(cells);
                    candidates = map.listerThings.AllThings.Where(t => set.Contains(t.Position) && (t.def.category == ThingCategory.Item || t is Building)).ToList();
                }
                else
                {
                    candidates = Lookup.ThingsFrom(r, map, required: false);
                }
            }

            if (candidates == null) candidates = new List<Thing>();

            if (!string.IsNullOrEmpty(defFilter))
            {
                candidates = candidates.Where(t =>
                    string.Equals(t.def.defName, defFilter, StringComparison.OrdinalIgnoreCase) ||
                    (t.def.label != null && string.Equals(t.def.label, defFilter, StringComparison.OrdinalIgnoreCase)) ||
                    (t.LabelShort != null && t.LabelShort.IndexOf(defFilter, StringComparison.OrdinalIgnoreCase) >= 0)
                ).ToList();
            }

            int changed = 0;
            foreach (var t in candidates)
            {
                if (t.def.category != ThingCategory.Item && !(t is Building)) continue;
                if (t is Building && t.Faction != null && t.Faction != Faction.OfPlayer) continue;

                try
                {
                    if (t.IsForbidden(Faction.OfPlayer) != forbidden)
                    {
                        t.SetForbidden(forbidden, false);
                        if (t.IsForbidden(Faction.OfPlayer) == forbidden)
                        {
                            changed++;
                        }
                    }
                }
                catch { }
            }

            return Bridge.Ok("changed", changed, "forbidden", forbidden, "matched", candidates.Count);
        }

        private static string SafeReport(Pawn p) { try { return p.jobs?.curDriver?.GetReport(); } catch { return null; } }

        private static LocalTargetInfo Target(Req r, Map map, string key)
        {
            if (!Json.Has(r.Body, key) && r.Q(key) == null) return LocalTargetInfo.Invalid;
            object v = Json.Has(r.Body, key) ? r.Body[key] : r.Q(key);
            if (v is List<object> pair && pair.Count >= 2) return new LocalTargetInfo(new IntVec3(Convert.ToInt32(pair[0]), 0, Convert.ToInt32(pair[1])));
            if (v is Dictionary<string, object> d && d.ContainsKey("x")) return new LocalTargetInfo(new IntVec3(Json.Int(d, "x"), 0, Json.Int(d, "z")));
            string sv = v.ToString();
            if (sv.Contains(","))
            {
                var parts = sv.Split(',');
                return new LocalTargetInfo(new IntVec3(int.Parse(parts[0]), 0, int.Parse(parts[1])));
            }
            var t = Lookup.FindThing(map, sv) ?? throw new BridgeException("No thing '" + sv + "' for " + key + ".", 404);
            return new LocalTargetInfo(t);
        }

        private static Designator MakeDesignator(string type)
        {
            switch (type)
            {
                case "mine": return new Designator_Mine();
                case "cancel": return new Designator_Cancel();
                case "harvest": return new Designator_PlantsHarvest();
                case "cut": return new Designator_PlantsCut();
                case "chop": case "harvestwood": return new Designator_PlantsHarvestWood();
                case "hunt": return new Designator_Hunt();
                case "tame": return new Designator_Tame();
                case "haul": return new Designator_Haul();
                case "deconstruct": return new Designator_Deconstruct();
                case "uninstall": return new Designator_Uninstall();
                case "slaughter": return new Designator_Slaughter();
                case "strip": return new Designator_Strip();
                case "open": return new Designator_Open();
                case "claim": return new Designator_Claim();
                case "smooth": return new Designator_SmoothSurface();
                case "removefloor": return new Designator_RemoveFloor();
                case "release": return new Designator_ReleaseAnimalToWild();
                default: throw new BridgeException("Unknown designation type '" + type + "'. Use mine|cancel|harvest|cut|chop|hunt|tame|haul|deconstruct|uninstall|slaughter|strip|open|claim|smooth|removeFloor|release.");
            }
        }

        // ---- wait support (handled by HttpServer: returns once TicksGame >= target or timeout)
        public static volatile int WaitUntilTick = -1;
        public sealed class WaitRequest : BridgeException { public int Target; public WaitRequest(int t) : base("wait") { Target = t; } }

        private static object Invoke(string routeKey, Req sub) => Bridge.Server.Invoke(routeKey, sub);
    }
}
