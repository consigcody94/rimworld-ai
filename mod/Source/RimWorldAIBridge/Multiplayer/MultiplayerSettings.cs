using System;
using Verse;

namespace RimWorldAIBridge.Multiplayer
{
    /// <summary>Multiplayer-specific settings, stored alongside BridgeSettings.</summary>
    public class MultiplayerSettings : ModSettings
    {
        public bool enabled = false;
        public int port = 18801;
        public int maxPlayers = 4;
        public int tickRate = 20;              // State broadcasts per second (1-60)
        public bool allowClientControl = true; // Clients can control assigned pawns
        public bool requirePassword = false;
        public string password = "";
        public bool broadcastAllMaps = false;  // Sync non-player-home maps (caravans, etc.)

        public override void ExposeData()
        {
            base.ExposeData();
            Scribe_Values.Look(ref enabled, "mpEnabled", false);
            Scribe_Values.Look(ref port, "mpPort", 18801);
            Scribe_Values.Look(ref maxPlayers, "mpMaxPlayers", 4);
            Scribe_Values.Look(ref tickRate, "mpTickRate", 20);
            Scribe_Values.Look(ref allowClientControl, "mpAllowClientControl", true);
            Scribe_Values.Look(ref requirePassword, "mpRequirePassword", false);
            Scribe_Values.Look(ref password, "mpPassword", "");
            Scribe_Values.Look(ref broadcastAllMaps, "mpBroadcastAllMaps", false);
        }
    }
}
