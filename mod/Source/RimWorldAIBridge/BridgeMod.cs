using System;
using System.Collections.Generic;
using UnityEngine;
using Verse;

namespace RimWorldAIBridge
{
    public class BridgeSettings : ModSettings
    {
        public int port = 18800;
        public string token = "";
        public bool enabled = true;
        public bool allowDevActions = true;   // god mode, incident firing, etc.

        public override void ExposeData()
        {
            base.ExposeData();
            Scribe_Values.Look(ref port, "port", 18800);
            Scribe_Values.Look(ref token, "token", "");
            Scribe_Values.Look(ref enabled, "enabled", true);
            Scribe_Values.Look(ref allowDevActions, "allowDevActions", true);
        }
    }

    public class BridgeMod : Mod
    {
        public static BridgeSettings Settings;
        public const string Version = "0.1.0";
        private string portBuffer;

        public BridgeMod(ModContentPack content) : base(content)
        {
            Settings = GetSettings<BridgeSettings>();
        }

        public override string SettingsCategory() => "RimWorld AI Bridge";

        public override void DoSettingsWindowContents(Rect inRect)
        {
            var listing = new Listing_Standard();
            listing.Begin(inRect);
            listing.CheckboxLabeled("Enable HTTP API (restart the game to apply)", ref Settings.enabled);
            listing.Label("Port (loopback only, 127.0.0.1):");
            if (portBuffer == null) portBuffer = Settings.port.ToString();
            portBuffer = listing.TextEntry(portBuffer);
            if (int.TryParse(portBuffer, out int p) && p > 1024 && p < 65536) Settings.port = p;
            listing.Label("Token (optional; clients send X-Token header). Leave blank for none:");
            Settings.token = listing.TextEntry(Settings.token ?? "");
            listing.CheckboxLabeled("Allow dev actions over the API (god mode, fire incidents)", ref Settings.allowDevActions);
            listing.Gap();
            listing.Label("Status: " + (Bridge.Server != null && Bridge.Server.IsRunning ? "listening on http://127.0.0.1:" + Bridge.Server.Port + "/" : "stopped"));
            listing.Label("Requests served: " + (Bridge.Server?.RequestsServed ?? 0));
            if (listing.ButtonText("Restart server now")) Bridge.Start(force: true);
            listing.End();
            base.DoSettingsWindowContents(inRect);
        }
    }

    /// <summary>Boots the HTTP server once all Defs are loaded. Runs on the main thread.</summary>
    [StaticConstructorOnStartup]
    public static class Bridge
    {
        public static HttpServer Server;
        public static readonly DateTime StartedAt = DateTime.UtcNow;

        static Bridge()
        {
            try
            {
                Application.runInBackground = true;
                Prefs.RunInBackground = true;
                Prefs.AdaptiveTrainingEnabled = false;
                Prefs.SmoothCameraJumps = true;
                try { Prefs.Save(); } catch { }
                MainThread.EnsurePump();
                EventLog.Install();
                MainThread.OnEveryFrame(ApplyPendingColonyName);
                MainThread.OnEveryFrame(FollowCamera.Update);
                Start(force: false);
            }
            catch (Exception e)
            {
                Log.Error("[RimWorldAIBridge] failed to start: " + e);
            }
        }

        public static void Start(bool force)
        {
            var s = BridgeMod.Settings ?? new BridgeSettings();
            if (!s.enabled && !force) { Log.Message("[RimWorldAIBridge] disabled in settings"); return; }
            int port = s.port;
            string envPort = Environment.GetEnvironmentVariable("RIMWORLD_AI_PORT");
            if (!string.IsNullOrEmpty(envPort) && int.TryParse(envPort, out int ep)) port = ep;
            string token = s.token;
            string envToken = Environment.GetEnvironmentVariable("RIMWORLD_AI_TOKEN");
            if (!string.IsNullOrEmpty(envToken)) token = envToken;

            Server?.Stop();
            Server = new HttpServer();
            Routes.Register(Server);
            try
            {
                Server.Start(port, token);
            }
            catch (Exception e)
            {
                Log.Error("[RimWorldAIBridge] could not bind port " + port + ": " + e.Message);
            }
        }

        private static void ApplyPendingColonyName()
        {
            if (Current.Game == null || Current.ProgramState != ProgramState.Playing || Find.World == null || RimWorld.Faction.OfPlayer == null) return;

            if (Routes.PendingNeolithicTech)
            {
                try
                {
                    // FactionDef is process-global and is not saved with the game, so remember the
                    // original and put it back when this game ends. Without that, a later
                    // non-neolithic game in the same session silently starts neolithic too.
                    var def = RimWorld.Faction.OfPlayer.def;
                    if (Routes.OriginalPlayerTechLevel == null)
                    {
                        Routes.OriginalPlayerTechLevel = def.techLevel;
                        Routes.MutatedPlayerFactionDef = def;
                    }
                    def.techLevel = RimWorld.TechLevel.Neolithic;
                }
                catch {}
                Routes.PendingNeolithicTech = false;
            }

            string name = Routes.PendingColonyName;
            if (name == null) return;
            try
            {
                RimWorld.Faction.OfPlayer.Name = name;
                var settlement = Find.WorldObjects?.Settlements?.Find(x => x.Faction == RimWorld.Faction.OfPlayer);
                if (settlement != null)
                {
                    settlement.Name = name;
                }
            }
            catch (Exception e) { Log.Warning("[RimWorldAIBridge] could not apply colony name: " + e.Message); }
            Routes.PendingColonyName = null;
        }

        public static Dictionary<string, object> Ok(params object[] kv)
        {
            var d = new Dictionary<string, object> { { "ok", true } };
            for (int i = 0; i + 1 < kv.Length; i += 2) d[kv[i].ToString()] = kv[i + 1];
            return d;
        }
    }
}
