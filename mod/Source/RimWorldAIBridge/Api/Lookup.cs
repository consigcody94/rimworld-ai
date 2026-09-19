using System;
using System.Collections.Generic;
using System.Linq;
using RimWorld;
using RimWorld.Planet;
using Verse;

namespace RimWorldAIBridge
{
    /// <summary>Resolution helpers shared by every route: maps, pawns, things, cells, defs.</summary>
    public static class Lookup
    {
        public static void RequirePlaying()
        {
            if (Current.Game == null || Current.ProgramState != ProgramState.Playing)
                throw new BridgeException("No game is running. Use POST /game/new or POST /game/load first (GET /game/saves lists saves).", 409);
        }

        public static Map MapFrom(Req req)
        {
            RequirePlaying();
            string m = req.Arg("map");
            if (!string.IsNullOrEmpty(m))
            {
                if (int.TryParse(m, out int id))
                {
                    var byId = Find.Maps.FirstOrDefault(x => x.uniqueID == id || x.Index == id);
                    if (byId != null) return byId;
                }
                throw new BridgeException("Unknown map '" + m + "'. GET /maps lists them.", 404);
            }
            Map map = Find.CurrentMap;
            if (map == null || !map.IsPlayerHome) map = Find.AnyPlayerHomeMap ?? Find.CurrentMap ?? Find.Maps.FirstOrDefault();
            if (map == null) throw new BridgeException("No map exists yet.", 409);
            return map;
        }

        public static Pawn PawnFrom(Req req, Map map, string key = "pawn")
        {
            string v = req.Arg(key);
            if (string.IsNullOrEmpty(v)) throw new BridgeException("Missing '" + key + "' (pawn id or name).");
            var p = FindPawn(map, v);
            if (p == null) throw new BridgeException("No pawn matches '" + v + "'. GET /pawns lists ids and names.", 404);
            return p;
        }

        public static Pawn FindPawn(Map map, string idOrName)
        {
            IEnumerable<Pawn> pool = map != null ? map.mapPawns.AllPawns : Find.Maps.SelectMany(m => m.mapPawns.AllPawns);
            if (int.TryParse(idOrName, out int id))
            {
                var byId = pool.FirstOrDefault(p => p.thingIDNumber == id);
                if (byId != null) return byId;
                // Caravans / world pawns
                var wp = Find.WorldPawns?.AllPawnsAlive.FirstOrDefault(p => p.thingIDNumber == id);
                if (wp != null) return wp;
            }
            string n = idOrName.Trim();
            return pool.FirstOrDefault(p => Eq(p.Name?.ToStringShort, n))
                ?? pool.FirstOrDefault(p => Eq(p.LabelShort, n))
                ?? pool.FirstOrDefault(p => Eq(p.Name?.ToStringFull, n))
                ?? pool.FirstOrDefault(p => p.Name != null && p.Name.ToStringFull.IndexOf(n, StringComparison.OrdinalIgnoreCase) >= 0)
                ?? pool.FirstOrDefault(p => Eq(p.ThingID, n));
        }

        private static bool Eq(string a, string b) => a != null && string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

        public static Thing ThingFrom(Req req, Map map, string key = "thing")
        {
            string v = req.Arg(key);
            if (string.IsNullOrEmpty(v)) throw new BridgeException("Missing '" + key + "' (thing id).");
            var t = FindThing(map, v);
            if (t == null) throw new BridgeException("No thing with id '" + v + "' on this map. GET /things to list.", 404);
            return t;
        }

        public static Thing FindThing(Map map, string idOrThingId)
        {
            if (int.TryParse(idOrThingId, out int id))
            {
                var pawn = map.mapPawns.AllPawns.FirstOrDefault(p => p.thingIDNumber == id);
                if (pawn != null) return pawn;
                var all = map.listerThings.AllThings;
                for (int i = 0; i < all.Count; i++) if (all[i].thingIDNumber == id) return all[i];
                return null;
            }
            return map.listerThings.AllThings.FirstOrDefault(t => string.Equals(t.ThingID, idOrThingId, StringComparison.OrdinalIgnoreCase));
        }

        public static IntVec3 CellFrom(Req req, Map map, string xKey = "x", string zKey = "z")
        {
            if (!req.HasArg(xKey) || !req.HasArg(zKey)) throw new BridgeException("Missing '" + xKey + "'/'" + zKey + "' cell coordinates.");
            var c = new IntVec3(req.ArgInt(xKey), 0, req.ArgInt(zKey));
            if (!c.InBounds(map)) throw new BridgeException("Cell " + c.x + "," + c.z + " is outside the map (" + map.Size.x + "x" + map.Size.z + ").");
            return c;
        }

        /// <summary>Cells from body: "cells": [[x,z],...] and/or "rect": {"x":..,"z":..,"w":..,"h":..}.</summary>
        public static List<IntVec3> CellsFrom(Req req, Map map, bool required = true)
        {
            var cells = new List<IntVec3>();
            var arr = Json.List(req.Body, "cells");
            if (arr != null)
            {
                foreach (var item in arr)
                {
                    if (item is List<object> pair && pair.Count >= 2)
                        cells.Add(new IntVec3(Convert.ToInt32(pair[0]), 0, Convert.ToInt32(pair[1])));
                    else if (item is Dictionary<string, object> d)
                        cells.Add(new IntVec3(Json.Int(d, "x"), 0, Json.Int(d, "z")));
                }
            }
            var rect = Json.Obj(req.Body, "rect");
            if (rect != null)
            {
                var r = new CellRect(Json.Int(rect, "x"), Json.Int(rect, "z"), Math.Max(1, Json.Int(rect, "w", 1)), Math.Max(1, Json.Int(rect, "h", 1)));
                foreach (var c in r) cells.Add(c);
            }
            else if (req.HasArg("x") && req.HasArg("z") && (req.HasArg("w") || req.HasArg("h")))
            {
                var r = new CellRect(req.ArgInt("x"), req.ArgInt("z"), Math.Max(1, req.ArgInt("w", 1)), Math.Max(1, req.ArgInt("h", 1)));
                foreach (var c in r) cells.Add(c);
            }
            else if (arr == null && req.HasArg("x") && req.HasArg("z"))
            {
                cells.Add(new IntVec3(req.ArgInt("x"), 0, req.ArgInt("z")));
            }
            cells = cells.Where(c => c.InBounds(map)).Distinct().ToList();
            if (required && cells.Count == 0) throw new BridgeException("Provide cells as \"cells\":[[x,z],...] or \"rect\":{\"x\",\"z\",\"w\",\"h\"} (or x,z,w,h query params).");
            return cells;
        }

        public static List<Thing> ThingsFrom(Req req, Map map, bool required = true)
        {
            var list = new List<Thing>();
            var arr = Json.List(req.Body, "things");
            if (arr != null) foreach (var o in arr) { var t = FindThing(map, o.ToString()); if (t != null) list.Add(t); }
            string single = req.Arg("thing");
            if (!string.IsNullOrEmpty(single)) { var t = FindThing(map, single); if (t != null) list.Add(t); }
            if (required && list.Count == 0) throw new BridgeException("Provide \"things\":[id,...] or \"thing\":id.");
            return list;
        }

        public static T Def<T>(string name, string what) where T : Def
        {
            if (string.IsNullOrEmpty(name)) throw new BridgeException("Missing " + what + " defName.");
            var d = DefDatabase<T>.GetNamedSilentFail(name);
            if (d == null)
            {
                // Try label match as a courtesy
                d = DefDatabase<T>.AllDefsListForReading.FirstOrDefault(x => string.Equals(x.label, name, StringComparison.OrdinalIgnoreCase))
                    ?? DefDatabase<T>.AllDefsListForReading.FirstOrDefault(x => string.Equals(x.defName, name, StringComparison.OrdinalIgnoreCase));
            }
            if (d == null) throw new BridgeException("Unknown " + what + " '" + name + "'. Search with GET /defs?type=" + what.ToLowerInvariant() + "&q=" + name, 404);
            return d;
        }

        public static Rot4 RotFrom(Req req)
        {
            string r = req.Arg("rot", "0");
            switch (r.ToLowerInvariant())
            {
                case "north": case "n": case "0": return Rot4.North;
                case "east": case "e": case "1": return Rot4.East;
                case "south": case "s": case "2": return Rot4.South;
                case "west": case "w": case "3": return Rot4.West;
                default: throw new BridgeException("rot must be 0-3 or north/east/south/west.");
            }
        }

        public static IntVec3? PrimaryTarget(LookTargets lt)
        {
            try
            {
                if (lt == null || !lt.IsValid) return null;
                var t = lt.TryGetPrimaryTarget();
                if (!t.IsValid) return null;
                if (t.HasThing && t.Thing.Spawned) return t.Thing.Position;
                if (t.Cell.IsValid) return t.Cell;
            }
            catch { }
            return null;
        }

        public static string Truncate(string s, int max)
        {
            if (s == null) return null;
            s = s.Replace("\r", "");
            return s.Length <= max ? s : s.Substring(0, max) + "…";
        }

        private static readonly System.Reflection.FieldInfo diaOptionText = typeof(DiaOption).GetField("text", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public);
        public static string OptionText(DiaOption o) => o == null ? null : (diaOptionText?.GetValue(o) as string) ?? o.ToString();

        public static Dictionary<string, object> Cell(IntVec3 c) => new Dictionary<string, object> { { "x", c.x }, { "z", c.z } };
    }
}
