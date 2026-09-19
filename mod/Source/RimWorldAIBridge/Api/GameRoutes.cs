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

            Doc(s, "ANY", "/game/new", "Start a new game without the UI. {scenario:Crashlanded, storyteller:Cassandra, difficulty:Rough, mapSize:250, seed:'abc', planetCoverage:0.3, colonyName}. Takes ~1-2 min; poll /status.", r =>
            {
                if (Current.ProgramState == ProgramState.Playing) throw new BridgeException("A game is running. POST /game/menu first (or /game/save then /game/menu).", 409);
                if (LongEventHandler.AnyEventNowOrWaiting) throw new BridgeException("Game is busy loading; wait and retry.", 409);
                var scen = Lookup.Def<ScenarioDef>(r.Arg("scenario") ?? "Crashlanded", "ScenarioDef");
                var story = Lookup.Def<StorytellerDef>(r.Arg("storyteller") ?? "Cassandra", "StorytellerDef");
                var diff = Lookup.Def<DifficultyDef>(r.Arg("difficulty") ?? "Rough", "DifficultyDef");
                int mapSize = Mathf.Clamp(r.ArgInt("mapSize", 250), 75, 400);
                float coverage = Mathf.Clamp(r.ArgFloat("planetCoverage", 0.3f), 0.05f, 1f);
                string seed = r.Arg("seed");
                if (string.IsNullOrEmpty(seed)) seed = GenText.RandomSeedString();
                string colonyName = r.Arg("colonyName");
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
                    Find.GameInitData.ChooseRandomStartingTile();
                    Find.GameInitData.mapSize = mapSize;
                    Find.Scenario.PostIdeoChosen();
                    Find.GameInitData.PrepForMapGen();
                    Find.Scenario.PreMapGenerate();
                }, "Play", "GeneratingMap", true, GameAndMapInitExceptionHandlers.ErrorWhileGeneratingMap);
                if (!string.IsNullOrEmpty(colonyName)) PendingColonyName = colonyName;
                return Bridge.Ok("starting", true, "scenario", scen.defName, "storyteller", story.defName, "difficulty", diff.defName, "mapSize", mapSize, "seed", seed);
            });

            Doc(s, "ANY", "/game/menu", "Quit to the main menu (does not save).", r =>
            {
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
    }
}
