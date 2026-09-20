using System;
using System.Collections.Generic;
using System.Linq;
using RimWorld;
using RimWorld.Planet;
using Verse;
using Verse.AI;

namespace RimWorldAIBridge
{
    /// <summary>Game objects to plain dictionaries. Keep output compact: tokens are the AI's scarcest resource.</summary>
    public static class Serializers
    {
        // ------------------------------------------------------------------ pawns

        public static string Role(Pawn p)
        {
            if (p.IsPrisonerOfColony) return "prisoner";
            if (p.IsSlaveOfColony) return "slave";
            if (p.IsColonist) return "colonist";
            if (p.IsColonyMech) return "colony_mech";
            if (p.RaceProps.Animal && p.Faction == Faction.OfPlayer) return "colony_animal";
            if (p.HostileTo(Faction.OfPlayer)) return p.RaceProps.Animal ? "hostile_animal" : "enemy";
            if (p.RaceProps.Animal) return "wild_animal";
            if (p.RaceProps.IsMechanoid) return "mech";
            if (p.Faction == null) return "neutral";
            return "visitor";
        }

        public static Dictionary<string, object> Pawn(Pawn p, bool detail)
        {
            var d = new Dictionary<string, object>
            {
                { "id", p.thingIDNumber },
                { "name", p.Name?.ToStringShort ?? p.LabelShort },
                { "role", Role(p) },
                { "kind", p.kindDef?.label ?? p.def.label },
            };
            if (p.RaceProps.Humanlike) d["gender"] = p.gender.ToString();
            d["age"] = p.ageTracker?.AgeBiologicalYears ?? 0;
            if (p.Faction != null && p.Faction != Faction.OfPlayer) d["faction"] = p.Faction.Name;
            if (p.Spawned) { d["x"] = p.Position.x; d["z"] = p.Position.z; d["map"] = p.Map.uniqueID; }
            else if (p.GetCaravan() != null) d["caravan"] = p.GetCaravan().Label;
            else d["spawned"] = false;
            if (p.Dead) { d["dead"] = true; return d; }
            if (p.Downed) d["downed"] = true;
            if (p.drafter != null) d["drafted"] = p.Drafted;
            if (p.InBed()) d["inBed"] = true;
            if (p.jobs?.curDriver != null && p.jobs.curDriver.asleep) d["asleep"] = true;

            var health = new Dictionary<string, object> { { "pct", Math.Round(p.health.summaryHealth.SummaryHealthPercent, 2) } };
            float bleed = p.health.hediffSet.BleedRateTotal;
            if (bleed > 0) health["bleedRate"] = Math.Round(bleed, 2);
            float pain = p.health.hediffSet.PainTotal;
            if (pain > 0.05f) health["pain"] = Math.Round(pain, 2);
            if (p.health.HasHediffsNeedingTend()) health["needsTending"] = true;
            var hediffs = new List<string>();
            foreach (var h in p.health.hediffSet.hediffs)
            {
                if (!h.Visible) continue;
                string s = h.LabelCap;
                if (h.Part != null) s += " (" + h.Part.Label + ")";
                hediffs.Add(s);
            }
            if (hediffs.Count > 0) health["hediffs"] = detail ? hediffs : hediffs.Take(6).ToList();
            if (detail)
            {
                health["capacities"] = new Dictionary<string, object>
                {
                    { "moving", Cap(p, PawnCapacityDefOf.Moving) }, { "manipulation", Cap(p, PawnCapacityDefOf.Manipulation) },
                    { "consciousness", Cap(p, PawnCapacityDefOf.Consciousness) }, { "sight", Cap(p, PawnCapacityDefOf.Sight) },
                };
            }
            d["health"] = health;

            if (p.needs != null)
            {
                var needs = new Dictionary<string, object>();
                if (p.needs.food != null) needs["food"] = Pct(p.needs.food);
                if (p.needs.rest != null) needs["rest"] = Pct(p.needs.rest);
                if (p.needs.mood != null) needs["mood"] = Pct(p.needs.mood);
                if (p.needs.joy != null) needs["joy"] = Pct(p.needs.joy);
                if (needs.Count > 0) d["needs"] = needs;
            }
            if (p.MentalStateDef != null) d["mentalState"] = p.MentalStateDef.label;
            if (p.mindState?.mentalBreaker != null && p.needs?.mood != null)
                d["moodBreakThreshold"] = Math.Round(p.mindState.mentalBreaker.BreakThresholdMinor, 2);

            var job = p.CurJob;
            if (job != null)
            {
                var jd = new Dictionary<string, object> { { "def", job.def.defName } };
                try { jd["report"] = p.jobs.curDriver?.GetReport(); } catch { }
                if (job.targetA.IsValid) jd["target"] = TargetLabel(job.targetA);
                if (job.playerForced) jd["forced"] = true;
                d["job"] = jd;
            }
            if (p.jobs != null && p.jobs.jobQueue.Count > 0) d["queuedJobs"] = p.jobs.jobQueue.Count;

            if (p.equipment?.Primary != null) d["weapon"] = p.equipment.Primary.LabelCap;
            if (p.carryTracker?.CarriedThing != null) d["carrying"] = p.carryTracker.CarriedThing.LabelCap;

            if (detail)
            {
                if (p.skills != null)
                {
                    var sk = new Dictionary<string, object>();
                    foreach (var s in p.skills.skills)
                    {
                        if (s.TotallyDisabled) { sk[s.def.defName] = "disabled"; continue; }
                        sk[s.def.defName] = s.passion == Passion.None ? (object)s.Level : s.Level + " " + (s.passion == Passion.Major ? "**" : "*");
                    }
                    d["skills"] = sk;
                }
                if (p.workSettings != null && p.workSettings.EverWork)
                {
                    var wk = new Dictionary<string, object>();
                    foreach (var wt in DefDatabase<WorkTypeDef>.AllDefsListForReading.OrderBy(w => w.naturalPriority))
                    {
                        if (p.WorkTypeIsDisabled(wt)) continue;
                        wk[wt.defName] = p.workSettings.GetPriority(wt);
                    }
                    d["work"] = wk;
                }
                if (p.story?.traits != null) d["traits"] = p.story.traits.allTraits.Select(t => t.LabelCap).ToList();
                if (p.apparel != null) d["apparel"] = p.apparel.WornApparel.Select(a => a.LabelCap).ToList();
                if (p.playerSettings != null)
                {
                    d["hostilityResponse"] = p.playerSettings.hostilityResponse.ToString();
                    d["medicalCare"] = p.playerSettings.medCare.ToString();
                    var area = p.playerSettings.AreaRestrictionInPawnCurrentMap;
                    if (area != null) d["allowedArea"] = area.Label;
                }
                if (p.needs?.mood?.thoughts != null)
                {
                    try
                    {
                        var thoughts = new List<Thought>();
                        p.needs.mood.thoughts.GetAllMoodThoughts(thoughts);
                        var grouped = thoughts.GroupBy(t => t.LabelCap).Select(g => new { label = g.Key, effect = g.Sum(t => t.MoodOffset()) })
                            .Where(t => Math.Abs(t.effect) >= 1f).OrderBy(t => t.effect).Take(12)
                            .Select(t => t.label + " " + (t.effect > 0 ? "+" : "") + Math.Round(t.effect)).ToList();
                        d["thoughts"] = grouped;
                    }
                    catch { }
                }
                if (p.guest != null && p.IsPrisonerOfColony) d["prisonerMode"] = p.guest.ExclusiveInteractionMode?.label;
                if (p.training != null && p.RaceProps.Animal) d["trainable"] = true;
                try { d["inspect"] = Lookup.Truncate(p.GetInspectString(), 500); } catch { }
            }
            return d;
        }

        private static object Cap(Pawn p, PawnCapacityDef c) => Math.Round(p.health.capacities.GetLevel(c), 2);
        private static object Pct(Need n) => Math.Round(n.CurLevelPercentage, 2);

        public static string TargetLabel(LocalTargetInfo t)
        {
            if (t.HasThing) return t.Thing.LabelShort + "#" + t.Thing.thingIDNumber;
            return t.Cell.x + "," + t.Cell.z;
        }

        // ------------------------------------------------------------------ things

        public static Dictionary<string, object> Thing(Thing t, bool detail)
        {
            var d = new Dictionary<string, object>
            {
                { "id", t.thingIDNumber },
                { "def", t.def.defName },
                { "label", t.LabelCap },
                { "cat", t.def.category.ToString() },
            };
            if (t.Spawned) { d["x"] = t.Position.x; d["z"] = t.Position.z; }
            if (t.stackCount > 1) d["count"] = t.stackCount;
            if (t.def.useHitPoints && t.HitPoints < t.MaxHitPoints) d["hp"] = t.HitPoints + "/" + t.MaxHitPoints;
            if (t.Faction != null && t.Faction != Faction.OfPlayer) d["faction"] = t.Faction.Name;
            if (t.IsForbidden(Faction.OfPlayer)) d["forbidden"] = true;
            if (t.Rotation != Rot4.North && t.def.rotatable) d["rot"] = t.Rotation.AsInt;
            if (t is Plant plant)
            {
                d["growth"] = Math.Round(plant.Growth, 2);
                if (plant.HarvestableNow) d["harvestable"] = true;
                if (plant.def.plant.IsTree) d["tree"] = true;
            }
            if (t is Building_Bed bed) { d["bed"] = true; if (bed.ForPrisoners) d["forPrisoners"] = true; d["occupants"] = bed.CurOccupants.Count(); }
            var power = t.TryGetComp<CompPowerTrader>();
            if (power != null) d["powerOn"] = power.PowerOn;
            var flick = t.TryGetComp<CompFlickable>();
            if (flick != null) d["switchedOn"] = flick.SwitchIsOn;
            var quality = t.TryGetComp<CompQuality>();
            if (quality != null) d["quality"] = quality.Quality.ToString();
            if (t is Frame frame) d["workLeft"] = Math.Round(frame.WorkLeft);
            if (t is IBillGiver bg && bg.BillStack != null)
            {
                d["bills"] = bg.BillStack.Bills.Select(b => b.LabelCap + (b.suspended ? " (suspended)" : "")).ToList();
            }
            if (t.def.IsCorpse) d["corpse"] = true;
            // Edibility, so an agent can find something for a starving pawn to eat without
            // hardcoding a list of food defNames. Cheap: both are def flags, not stat lookups.
            if (t.def.IsNutritionGivingIngestible)
            {
                d["nutrition"] = Math.Round(t.GetStatValue(StatDefOf.Nutrition), 2);
                try { d["humanEdible"] = t.def.ingestible.HumanEdible; } catch { }
            }
            if (detail)
            {
                if (t.def.designationCategory != null) d["buildCategory"] = t.def.designationCategory.defName;
                if (t.Stuff != null) d["stuff"] = t.Stuff.defName;
                try { d["inspect"] = Lookup.Truncate(t.GetInspectString(), 400); } catch { }
                var storage = t as IStoreSettingsParent;
                if (storage != null && storage.StorageTabVisible) d["storagePriority"] = storage.GetStoreSettings().Priority.ToString();
            }
            return d;
        }

        // ------------------------------------------------------------------ map / colony

        public static Dictionary<string, object> MapSummary(Map map, bool detail)
        {
            var d = new Dictionary<string, object>
            {
                { "id", map.uniqueID },
                { "index", map.Index },
                { "tile", map.Tile.ToString() },
                { "biome", map.Biome.label },
                { "size", new Dictionary<string, object> { { "x", map.Size.x }, { "z", map.Size.z } } },
                { "isPlayerHome", map.IsPlayerHome },
                { "current", map == Find.CurrentMap },
                { "date", DateString(map) },
                { "hour", GenLocalDate.HourInteger(map) },
                { "season", GenLocalDate.Season(map).ToString() },
                { "outdoorTempC", Math.Round(map.mapTemperature.OutdoorTemp, 1) },
                { "weather", map.weatherManager.curWeather.label },
            };
            var conds = map.gameConditionManager.ActiveConditions.Select(c => c.LabelCap.ToString()).ToList();
            if (conds.Count > 0) d["conditions"] = conds;
            d["colonists"] = map.mapPawns.FreeColonistsSpawnedCount;
            d["prisoners"] = map.mapPawns.PrisonersOfColonyCount;
            d["colonyAnimals"] = map.mapPawns.SpawnedColonyAnimals.Count();
            var hostiles = map.mapPawns.AllPawnsSpawned.Where(p => !p.Dead && !p.Downed && p.HostileTo(Faction.OfPlayer)).ToList();
            d["hostiles"] = hostiles.Count;
            d["threatActive"] = GenHostility.AnyHostileActiveThreatToPlayer(map);
            d["homeAreaCells"] = map.areaManager.Home.TrueCount;
            d["buildings"] = map.listerBuildings.allBuildingsColonist.Count;
            d["wealth"] = Math.Round(map.wealthWatcher.WealthTotal);
            d["foodNutrition"] = Math.Round(map.resourceCounter.TotalHumanEdibleNutrition, 1);
            if (detail)
            {
                d["zones"] = map.zoneManager.AllZones.Select(z => Zone(z)).ToList();
                d["areas"] = map.areaManager.AllAreas.Where(a => a.Mutable).Select(a => new Dictionary<string, object> { { "id", a.ID }, { "label", a.Label }, { "cells", a.TrueCount } }).ToList();
                d["resources"] = Resources(map, 0);
                d["designations"] = map.designationManager.AllDesignations.GroupBy(x => x.def.defName).ToDictionary(g => g.Key, g => (object)g.Count());
                d["camera"] = Lookup.Cell(Find.CameraDriver.MapPosition);
            }
            return d;
        }

        public static string DateString(Map map)
        {
            try { return GenDate.DateFullStringWithHourAt(Find.TickManager.TicksAbs, Find.WorldGrid.LongLatOf(map.Tile)); }
            catch { return GenLocalDate.Year(map) + " day " + GenLocalDate.DayOfYear(map); }
        }

        public static Dictionary<string, object> Zone(Zone z)
        {
            var cells = z.Cells.ToList();
            var d = new Dictionary<string, object> { { "id", z.ID }, { "label", z.label }, { "type", z.GetType().Name.Replace("Zone_", "") }, { "cells", cells.Count } };
            if (cells.Count > 0)
            {
                d["minX"] = cells.Min(c => c.x); d["minZ"] = cells.Min(c => c.z); d["maxX"] = cells.Max(c => c.x); d["maxZ"] = cells.Max(c => c.z);
            }
            if (z is Zone_Growing g) { d["plant"] = g.GetPlantDefToGrow()?.defName; d["allowSow"] = g.allowSow; }
            if (z is Zone_Stockpile s) { d["priority"] = s.settings.Priority.ToString(); d["items"] = s.HeldThingsCount; }
            return d;
        }

        public static Dictionary<string, object> Resources(Map map, int minCount)
        {
            var d = new Dictionary<string, object>();
            foreach (var kv in map.resourceCounter.AllCountedAmounts.OrderByDescending(kv => kv.Value))
                if (kv.Value > minCount) d[kv.Key.defName] = kv.Value;
            return d;
        }

        public static Dictionary<string, object> Letter(Letter l, bool includeText)
        {
            var d = new Dictionary<string, object> { { "id", l.ID }, { "label", l.Label.RawText }, { "type", l.def.defName }, { "tick", l.arrivalTick } };
            var c = Lookup.PrimaryTarget(l.lookTargets);
            if (c != null) { d["x"] = c.Value.x; d["z"] = c.Value.z; }
            if (l is ChoiceLetter cl)
            {
                if (includeText) d["text"] = Lookup.Truncate(cl.Text.RawText, 2000);
                try
                {
                    d["choices"] = cl.Choices.Select((o, i) => (object)new Dictionary<string, object> { { "index", i }, { "label", Lookup.OptionText(o) }, { "disabled", o.disabled } }).ToList();
                }
                catch { }
                if (cl.quest != null) d["questId"] = cl.quest.id;
            }
            return d;
        }

        public static Dictionary<string, object> Quest(Quest q, bool includeText)
        {
            var d = new Dictionary<string, object> { { "id", q.id }, { "name", q.name }, { "state", q.State.ToString() } };
            if (q.EverAccepted) d["ticksSinceAccepted"] = q.TicksSinceAccepted;
            else if (q.State == QuestState.NotYetAccepted) { try { d["ticksUntilExpiry"] = q.TicksUntilExpiry; } catch { } }
            if (includeText) d["description"] = Lookup.Truncate(q.description.RawText, 1500);
            return d;
        }
    }
}
