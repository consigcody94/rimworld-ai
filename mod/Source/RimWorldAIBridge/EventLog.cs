using System;
using System.Collections.Generic;
using System.Reflection;
using RimWorld;
using Verse;

namespace RimWorldAIBridge
{
    /// <summary>
    /// Ring buffer of things that happened: letters, on-screen messages, play log and battle log entries.
    /// Polled once per frame on the main thread (no Harmony needed). Clients read with GET /events?since=N.
    /// </summary>
    public static class EventLog
    {
        public sealed class Entry
        {
            public long Seq;
            public int Tick;
            public string Kind;    // letter | message | log | battle | bridge
            public string Text;
            public string Label;
            public int? LetterId;
            public int? X, Z;
        }

        private const int Capacity = 500;
        private static readonly List<Entry> entries = new List<Entry>();
        private static long seq;
        private static readonly HashSet<int> seenLetters = new HashSet<int>();
        private static readonly HashSet<Message> seenMessages = new HashSet<Message>();
        private static readonly HashSet<LogEntry> seenLog = new HashSet<LogEntry>();
        private static int lastPlayLogCount = -1, lastBattleCount = -1;
        private static FieldInfo liveMessagesField;
        private static Game seenGame;

        public static long LatestSeq => seq;

        public static void Install()
        {
            liveMessagesField = typeof(Messages).GetField("liveMessages", BindingFlags.NonPublic | BindingFlags.Static);
            MainThread.OnEveryFrame(Poll);
        }

        public static void Add(string kind, string text, string label = null, int? x = null, int? z = null, int? letterId = null)
        {
            lock (entries)
            {
                var e = new Entry { Seq = ++seq, Tick = Current.Game != null ? Find.TickManager.TicksGame : 0, Kind = kind, Text = text, Label = label, X = x, Z = z, LetterId = letterId };
                entries.Add(e);
                if (entries.Count > Capacity) entries.RemoveRange(0, entries.Count - Capacity);
            }
        }

        public static List<Dictionary<string, object>> Since(long since, int limit)
        {
            var list = new List<Dictionary<string, object>>();
            lock (entries)
            {
                for (int i = 0; i < entries.Count && list.Count < limit; i++)
                {
                    var e = entries[i];
                    if (e.Seq <= since) continue;
                    var d = new Dictionary<string, object> { { "seq", e.Seq }, { "tick", e.Tick }, { "kind", e.Kind }, { "text", e.Text } };
                    if (e.Label != null) d["label"] = e.Label;
                    if (e.LetterId != null) d["letterId"] = e.LetterId;
                    if (e.X != null) { d["x"] = e.X; d["z"] = e.Z; }
                    list.Add(d);
                }
            }
            return list;
        }

        private static void Poll()
        {
            if (Current.Game == null || Current.ProgramState != ProgramState.Playing) { seenGame = null; return; }
            if (seenGame != Current.Game)
            {
                // New game or loaded save: start fresh so old letters are not re-reported.
                seenGame = Current.Game;
                seenLetters.Clear(); seenMessages.Clear(); seenLog.Clear();
                foreach (var l in Find.LetterStack.LettersListForReading) seenLetters.Add(l.ID);
                var live0 = liveMessagesField?.GetValue(null) as List<Message>;
                if (live0 != null) foreach (var m in live0) seenMessages.Add(m);
                if (Find.PlayLog != null) foreach (var le in Find.PlayLog.AllEntries) seenLog.Add(le);
                if (Find.BattleLog != null) foreach (var b in Find.BattleLog.Battles) foreach (var le in b.Entries) seenLog.Add(le);
                Add("bridge", "Event capture started for game '" + (Find.World?.info?.name ?? "?") + "'");
                return;
            }

            try
            {
                var letters = Find.LetterStack.LettersListForReading;
                for (int i = 0; i < letters.Count; i++)
                {
                    var l = letters[i];
                    if (!seenLetters.Add(l.ID)) continue;
                    string text = (l as ChoiceLetter)?.Text.RawText;
                    var t = Lookup.PrimaryTarget(l.lookTargets);
                    Add("letter", Lookup.Truncate(text ?? l.Label.RawText, 600), l.Label.RawText, t?.x, t?.z, l.ID);
                }
                if (seenLetters.Count > 5000) seenLetters.Clear();

                var live = liveMessagesField?.GetValue(null) as List<Message>;
                if (live != null)
                {
                    for (int i = 0; i < live.Count; i++)
                    {
                        var m = live[i];
                        if (!seenMessages.Add(m)) continue;
                        var t = Lookup.PrimaryTarget(m.lookTargets);
                        Add("message", m.text, m.def?.defName, t?.x, t?.z);
                    }
                    if (seenMessages.Count > 200) { seenMessages.Clear(); foreach (var m in live) seenMessages.Add(m); }
                }

                var playLog = Find.PlayLog?.AllEntries;
                if (playLog != null && playLog.Count != lastPlayLogCount)
                {
                    lastPlayLogCount = playLog.Count;
                    int start = Math.Max(0, playLog.Count - 20);
                    for (int i = start; i < playLog.Count; i++) CaptureLogEntry(playLog[i], "log");
                }
                var battles = Find.BattleLog?.Battles;
                if (battles != null)
                {
                    int total = 0;
                    for (int i = 0; i < battles.Count; i++) total += battles[i].Entries.Count;
                    if (total != lastBattleCount)
                    {
                        lastBattleCount = total;
                        int budget = 20;
                        for (int i = battles.Count - 1; i >= 0 && budget > 0; i--)
                        {
                            var es = battles[i].Entries;
                            for (int j = es.Count - 1; j >= 0 && budget > 0; j--, budget--) CaptureLogEntry(es[j], "battle");
                        }
                    }
                }
                if (seenLog.Count > 4000) seenLog.Clear();
            }
            catch (Exception e)
            {
                Log.ErrorOnce("[RimWorldAIBridge] event poll failed: " + e, 88123);
            }
        }

        private static void CaptureLogEntry(LogEntry le, string kind)
        {
            if (le == null || !seenLog.Add(le)) return;
            string text;
            try { text = le.ToGameStringFromPOV(null); }
            catch { try { text = le.ToString(); } catch { return; } }
            if (string.IsNullOrEmpty(text)) return;
            Add(kind, Lookup.Truncate(text, 300), le.GetType().Name);
        }
    }
}
