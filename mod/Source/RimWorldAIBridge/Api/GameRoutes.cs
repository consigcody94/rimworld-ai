using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using RimWorld;
using RimWorld.Planet;
using UnityEngine;
using Verse;

namespace RimWorldAIBridge
{
    public static partial class Routes
    {
        private static void RegisterGame(HttpServer s)
        {
            Doc(s, "GET", "/game/saves", "List save files (newest first).", r =>
            {
                var saves = GenFilePaths.AllSavedGameFiles.Select(f => new Dictionary<string, object> { { "name", Path.GetFileNameWithoutExtension(f.Name) }, { "modified", f.LastWriteTimeUtc.ToString("o") }, { "sizeKb", f.Length / 1024 } }).ToList();
                return new Dictionary<string, object> { { "saves", saves }, { "folder", GenFilePaths.SavedGamesFolderPath } };
            });

            Doc(s, "ANY", "/game/save", "Save the game. {name:'AI Colony'}. Overwrites.", r =>
            {
                Lookup.RequirePlaying();
                string name = r.Arg("name") ?? "AI Bridge";
                foreach (char ch in Path.GetInvalidFileNameChars()) name = name.Replace(ch, '_');
                LongEventHandler.QueueLongEvent(() => GameDataSaveLoader.SaveGame(name), "SavingLongEvent", false, null);
                return Bridge.Ok("name", name, "queued", true);
            });

            Doc(s, "ANY", "/game/load", "Load a save by name (from /game/saves). Poll GET /status until playing=true and loading=false.", r =>
            {
                string name = r.Arg("name") ?? throw new BridgeException("Missing name.");
                var file = GenFilePaths.AllSavedGameFiles.FirstOrDefault(f => string.Equals(Path.GetFileNameWithoutExtension(f.Name), name, StringComparison.OrdinalIgnoreCase))
                    ?? throw new BridgeException("No save named '" + name + "'.", 404);
                GameDataSaveLoader.LoadGame(Path.GetFileNameWithoutExtension(file.Name));
                return Bridge.Ok("loading", name);
            });

            Doc(s, "ANY", "/game/new", "Start a new game without the UI. {scenario:NakedBrutality, storyteller:Cassandra, difficulty:Rough, mapSize:250, seed:'abc', planetCoverage:0.3, biome:TemperateForest, hilliness:LargeHills, permadeath:true, neolithic:true, curatePawn:true, season:Spring|Summer|Fall|Winter, colonyName}. Takes ~1-2 min; poll /status.", r =>
            {
                if (Current.ProgramState == ProgramState.Playing) throw new BridgeException("A game is running. POST /game/menu first (or /game/save then /game/menu).", 409);
                RestorePlayerTechLevel();
                if (LongEventHandler.AnyEventNowOrWaiting) throw new BridgeException("Game is busy loading; wait and retry.", 409);
                var scen = Lookup.Def<ScenarioDef>(r.Arg("scenario") ?? "NakedBrutality", "ScenarioDef");
                var story = Lookup.Def<StorytellerDef>(r.Arg("storyteller") ?? "Cassandra", "StorytellerDef");
                var diff = Lookup.Def<DifficultyDef>(r.Arg("difficulty") ?? "Rough", "DifficultyDef");
                int mapSize = Mathf.Clamp(r.ArgInt("mapSize", 250), 75, 400);
                float coverage = Mathf.Clamp(r.ArgFloat("planetCoverage", 0.3f), 0.05f, 1f);
                string seed = r.Arg("seed");
                if (string.IsNullOrEmpty(seed)) seed = GenText.RandomSeedString();
                string colonyName = r.Arg("colonyName");
                string biomeArg = r.Arg("biome") ?? "TemperateForest";
                string hillArg = r.Arg("hilliness") ?? "LargeHills";
                bool permadeath = r.ArgBool("permadeath", false);
                bool neolithic = r.ArgBool("neolithic", false);
                bool curatePawn = r.ArgBool("curatePawn", true);
                // Starting season decides whether a colony with no food can find any. A naked
                // start dropped into Decembary has no plant growth and almost no forage, which
                // is a death sentence before the agent makes a single decision. Spring by
                // default; pass season=Winter deliberately if you want that fight.
                string seasonArg = r.Arg("season") ?? "Spring";
                Season startSeason = Season.Spring;
                Enum.TryParse<Season>(seasonArg, true, out startSeason);

                LongEventHandler.QueueLongEvent(() =>
                {
                    Current.ProgramState = ProgramState.Entry;
                    Game.ClearCaches();
                    Current.Game = new Game();
                    Current.Game.InitData = new GameInitData();
                    Current.Game.Scenario = scen.scenario;
                    Find.Scenario.PreConfigure();
                    Current.Game.storyteller = new Storyteller(story, diff);
                    Current.Game.World = WorldGenerator.GenerateWorld(coverage, seed, OverallRainfall.Normal, OverallTemperature.Normal, OverallPopulation.Normal, LandmarkDensity.Normal);

                    // 1. Smart tile selection based on requested biome, hilliness, rock types, and growing period
                    int bestTile = -1;
                    int bestScore = -1;
                    var targetBiome = DefDatabase<BiomeDef>.GetNamedSilentFail(biomeArg) ?? BiomeDefOf.TemperateForest;
                    var targetHill = Hilliness.LargeHills;
                    Enum.TryParse<Hilliness>(hillArg, true, out targetHill);

                    for (int t = 0; t < Find.WorldGrid.TilesCount; t++)
                    {
                        var tile = Find.WorldGrid[t];
                        if (tile.WaterCovered || !tile.OnSurface || tile.PrimaryBiome != targetBiome) continue;
                        if (tile.hilliness != targetHill) continue;

                        int score = 100;
                        var rocks = Find.World.NaturalRockTypesIn(t);
                        if (rocks != null)
                        {
                            if (rocks.Any(k => k.defName == "Granite")) score += 30;
                            if (rocks.Any(k => k.defName == "Marble")) score += 30;
                        }

                        // Temperate forest with mild temperature (12C - 24C) guarantees 40-60 day growing period
                        if (tile.temperature < 8f || tile.temperature > 26f) continue;
                        score += (int)(tile.temperature * 5f);
                        if (tile.rainfall >= 800f) score += 20;

                        if (score > bestScore)
                        {
                            bestScore = score;
                            bestTile = t;
                        }
                    }

                    if (bestTile >= 0) Find.GameInitData.startingTile = bestTile;
                    else Find.GameInitData.ChooseRandomStartingTile();

                    Find.GameInitData.mapSize = mapSize;
                    Find.GameInitData.startingSeason = startSeason;

                    if (permadeath)
                    {
                        Find.GameInitData.permadeath = true;
                        Find.GameInitData.permadeathChosen = true;
                    }

                    Find.Scenario.PostIdeoChosen();
                    Find.GameInitData.PrepForMapGen();

                    // 2. Curate the founder: score hundreds of rolls and keep a top-decile pawn
                    //    (skills, passions, traits, health, age). Nothing is edited on the pawn itself,
                    //    so the start stays a legitimate random roll, just a well chosen one.
                    if (curatePawn && Find.GameInitData.startingAndOptionalPawns != null && Find.GameInitData.startingAndOptionalPawns.Count > 0)
                    {
                        // Two-phase, and deliberately never holds a reference to a pawn:
                        // RandomizePawn discards the previous one, so stashing it and assigning it
                        // back later leaves the slot pointing at a dead object and NOBODY SPAWNS.
                        //
                        // Phase 1 samples the distribution to learn what a good roll looks like.
                        // Phase 2 rolls until the pawn currently in the slot clears that bar, so
                        // whatever is in the slot when the loop exits is always a live, scored pawn.
                        float best = float.MinValue;
                        int rolls = 0;
                        const int calibration = 60, maxRolls = 500;
                        const float floorScore = 45f;

                        for (int i = 0; i < calibration; i++, rolls++)
                        {
                            float sc = FounderScore(Find.GameInitData.startingAndOptionalPawns[0]);
                            if (sc > best) best = sc;
                            StartingPawnUtility.RandomizePawn(0);
                        }

                        float bar = Mathf.Max(floorScore, best * 0.90f);
                        float chosenScore = FounderScore(Find.GameInitData.startingAndOptionalPawns[0]);
                        while (rolls < maxRolls && chosenScore < bar)
                        {
                            StartingPawnUtility.RandomizePawn(0);
                            rolls++;
                            chosenScore = FounderScore(Find.GameInitData.startingAndOptionalPawns[0]);
                            if (chosenScore > best) best = chosenScore;
                        }

                        // Last resort: if the bar was never met, at least make sure the pawn in the
                        // slot is not disqualified outright (negative score).
                        int guard = 0;
                        while (chosenScore < 0f && guard++ < 120)
                        {
                            StartingPawnUtility.RandomizePawn(0);
                            rolls++;
                            chosenScore = FounderScore(Find.GameInitData.startingAndOptionalPawns[0]);
                        }

                        LastFounderScore = chosenScore;
                        LastFounderRolls = rolls;
                        Log.Message("[RimWorldAIBridge] founder chosen after " + rolls + " rolls, score " + chosenScore.ToString("F0") + " (bar " + bar.ToString("F0") + "): " + Find.GameInitData.startingAndOptionalPawns[0]?.LabelShort);
                    }

                    Find.Scenario.PreMapGenerate();
                }, "Play", "GeneratingMap", true, GameAndMapInitExceptionHandlers.ErrorWhileGeneratingMap);

                if (!string.IsNullOrEmpty(colonyName)) PendingColonyName = colonyName;
                if (neolithic) PendingNeolithicTech = true;

                return Bridge.Ok(
                    "starting", true,
                    "scenario", scen.defName,
                    "storyteller", story.defName,
                    "difficulty", diff.defName,
                    "biome", biomeArg,
                    "hilliness", hillArg,
                    "permadeath", permadeath,
                    "neolithic", neolithic,
                    "mapSize", mapSize,
                    "season", startSeason.ToString(),
                    "seed", seed,
                    "curatePawn", curatePawn
                );
            });

            Doc(s, "ANY", "/game/menu", "Quit to the main menu (does not save).", r =>
            {
                RestorePlayerTechLevel();
                if (Current.ProgramState != ProgramState.Playing) return Bridge.Ok("alreadyAtMenu", true);
                GenScene.GoToMainMenu();
                return Bridge.Ok("goingToMenu", true);
            });

            Doc(s, "ANY", "/game/quit", "Quit RimWorld entirely (no save).", r =>
            {
                Root.Shutdown();
                return Bridge.Ok("quitting", true);
            });

            Doc(s, "ANY", "/game/storyteller", "Change storyteller/difficulty mid-game. {storyteller, difficulty}", r =>
            {
                Lookup.RequirePlaying();
                if (r.HasArg("storyteller")) Find.Storyteller.def = Lookup.Def<StorytellerDef>(r.Arg("storyteller"), "StorytellerDef");
                if (r.HasArg("difficulty"))
                {
                    var diff = Lookup.Def<DifficultyDef>(r.Arg("difficulty"), "DifficultyDef");
                    Find.Storyteller.difficultyDef = diff;
                    Find.Storyteller.difficulty = new Difficulty(diff);
                }
                Find.Storyteller.Notify_DefChanged();
                return Bridge.Ok("storyteller", Find.Storyteller.def.defName, "difficulty", Find.Storyteller.difficultyDef.defName);
            });
        }

        public static string PendingColonyName;
        public static bool PendingNeolithicTech;
        public static RimWorld.TechLevel? OriginalPlayerTechLevel;
        public static RimWorld.FactionDef MutatedPlayerFactionDef;

        /// <summary>Undo the neolithic Def mutation. Called when a game ends.</summary>
        public static void RestorePlayerTechLevel()
        {
            if (OriginalPlayerTechLevel == null || MutatedPlayerFactionDef == null) return;
            try { MutatedPlayerFactionDef.techLevel = OriginalPlayerTechLevel.Value; } catch { }
            OriginalPlayerTechLevel = null;
            MutatedPlayerFactionDef = null;
        }

        public static float LastFounderScore;
        public static int LastFounderRolls;

        /// <summary>Fitness of a pawn as a Naked Brutality founder. Negative means disqualified.</summary>
        public static float FounderScore(Pawn p)
        {
            if (p == null || p.skills == null || p.health?.capacities == null) return -1f;
            if (p.CombinedDisabledWorkTags != WorkTags.None) return -1f;
            int age = p.ageTracker?.AgeBiologicalYears ?? 99;
            if (age < 18 || age > 45) return -1f;
            if (p.health.capacities.GetLevel(PawnCapacityDefOf.Sight) < 0.99f) return -1f;
            if (p.health.capacities.GetLevel(PawnCapacityDefOf.Moving) < 0.99f) return -1f;
            if (p.health.capacities.GetLevel(PawnCapacityDefOf.Manipulation) < 0.99f) return -1f;
            if (p.health.hediffSet?.hediffs != null)
            {
                foreach (var h in p.health.hediffSet.hediffs)
                {
                    if (h.def.isBad || h.def.chronic || h is Hediff_MissingPart || h is Hediff_Injury || h is Hediff_Addiction) return -1f;
                    if (h.def.defName.IndexOf("Pregnant", StringComparison.OrdinalIgnoreCase) >= 0) return -1f;
                }
            }

            float s = 0f;
            Func<SkillDef, float, float> sk = (def, w) =>
            {
                var r = p.skills.GetSkill(def);
                if (r == null || r.TotallyDisabled) return -50f;
                float passion = r.passion == Passion.Major ? 6f : r.passion == Passion.Minor ? 3f : 0f;
                return r.Level * w + passion * (w >= 2f ? 1f : 0.5f);
            };
            s += sk(SkillDefOf.Plants, 3f);
            s += sk(SkillDefOf.Construction, 2f);
            s += sk(SkillDefOf.Medicine, 2f);
            s += Mathf.Max(sk(SkillDefOf.Shooting, 2f), sk(SkillDefOf.Melee, 2f));
            s += sk(SkillDefOf.Cooking, 1f);
            s += sk(SkillDefOf.Crafting, 1f);
            s += sk(SkillDefOf.Intellectual, 1f);
            s += sk(SkillDefOf.Mining, 0.5f);
            if ((p.skills.GetSkill(SkillDefOf.Plants)?.Level ?? 0) < 5) s -= 25f;
            if (age >= 20 && age <= 35) s += 5f;

            if (p.story?.traits != null)
            {
                foreach (var t in p.story.traits.allTraits)
                {
                    string n = t.def.defName; int d = t.Degree;
                    switch (n)
                    {
                        case "Tough": s += 14f; break;
                        case "FastLearner": s += 10f; break;
                        case "Nudist": s += 8f; break;
                        case "Ascetic": s += 6f; break;
                        case "QuickSleeper": s += 5f; break;
                        case "TooSmart": s += 4f; break;
                        case "Kind": s += 2f; break;
                        case "Industriousness": s += d == 2 ? 12f : d == 1 ? 7f : d == -1 ? -30f : -60f; break;
                        case "Nerves": s += d == 2 ? 10f : d == 1 ? 6f : d == -1 ? -12f : -40f; break;
                        case "NaturalMood": s += d == 2 ? 10f : d == 1 ? 6f : d == -1 ? -20f : -60f; break;
                        case "SpeedOffset": s += d >= 1 ? 8f : -30f; break;
                        case "Immunity": s += d >= 1 ? 8f : -30f; break;
                        case "DrugDesire": s += d == 2 ? -60f : d == 1 ? -15f : 4f; break;
                        case "Neurotic": s += d == 2 ? 4f : 2f; break;
                        case "Pyromaniac": case "Wimp": case "Gourmand": case "Slowpoke": case "Lazy": case "Slothful": s -= 60f; break;
                        case "Undergrounder": s -= 5f; break;
                        case "NightOwl": case "Abrasive": case "Greedy": case "Jealous": case "Psychopath": case "Bloodlust": s -= 3f; break;
                    }
                }
            }
            return s;
        }
    }
}
