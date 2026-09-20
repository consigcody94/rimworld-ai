using System;
using System.Collections.Generic;
using UnityEngine;
using Verse;

namespace RimWorldAIBridge
{
    public class ChatMessageItem
    {
        public string User;
        public string Text;
        public Color UserColor;
        public DateTime Timestamp;
    }

    /// <summary>
    /// In-game Twitch Chat HUD rendered directly on the RimWorld screen (top-right corner),
    /// replacing the yellow learning helper.
    /// </summary>
    public static class TwitchChatHUD
    {
        private static readonly List<ChatMessageItem> Messages = new List<ChatMessageItem>();

        public static void ClearMessages() { lock (syncLock) Messages.Clear(); }
        public static int MessageCount { get { lock (syncLock) return Messages.Count; } }
        private static readonly object syncLock = new object();
        public static bool Enabled = true;

        private static readonly Color[] Palette = new Color[]
        {
            new Color(0.4f, 0.8f, 1.0f),   // Cyan
            new Color(1.0f, 0.5f, 0.7f),   // Pink
            new Color(0.6f, 1.0f, 0.5f),   // Light green
            new Color(1.0f, 0.85f, 0.3f),  // Gold
            new Color(0.8f, 0.6f, 1.0f),   // Purple
            new Color(1.0f, 0.6f, 0.3f)    // Orange
        };

        /// <summary>
        /// Unity rich text is enabled for this label, so viewer text must not be able to carry
        /// markup. A viewer typing &lt;size=200&gt; or the background colour would otherwise blow out
        /// the panel or make their message invisible on the live broadcast.
        /// </summary>
        private static string Sanitize(string s, int max)
        {
            if (string.IsNullOrEmpty(s)) return "";
            var sb = new System.Text.StringBuilder(Math.Min(s.Length, max));
            foreach (char c in s)
            {
                if (sb.Length >= max) break;
                if (c == '<') { sb.Append('('); continue; }
                if (c == '>') { sb.Append(')'); continue; }
                if (c == '\n' || c == '\r' || c == '\t') { sb.Append(' '); continue; }
                if (char.IsControl(c)) continue;
                sb.Append(c);
            }
            return sb.ToString();
        }

        public static void AddMessage(string user, string text, string hexColor = null)
        {
            if (string.IsNullOrEmpty(user) || string.IsNullOrEmpty(text)) return;
            user = Sanitize(user, 25);
            text = Sanitize(text, 160);
            if (user.Length == 0 || text.Length == 0) return;
            Color color;
            if (!string.IsNullOrEmpty(hexColor) && ColorUtility.TryParseHtmlString(hexColor, out var parsed))
            {
                color = parsed;
            }
            else
            {
                int hash = Math.Abs(user.GetHashCode());
                color = Palette[hash % Palette.Length];
            }

            lock (syncLock)
            {
                Messages.Add(new ChatMessageItem
                {
                    User = user,
                    Text = text,
                    UserColor = color,
                    Timestamp = DateTime.UtcNow
                });
                if (Messages.Count > 40)
                {
                    Messages.RemoveAt(0);
                }
            }
        }

        public static void OnGUI()
        {
            if (!Enabled || Current.ProgramState != ProgramState.Playing) return;

            // Ensure learning helper is kept off
            if (Prefs.AdaptiveTrainingEnabled)
            {
                Prefs.AdaptiveTrainingEnabled = false;
                Prefs.Save();
            }

            float w = 330f;
            float h = 250f;
            float x = Screen.width - w - 8f;
            float y = 8f;
            Rect boxRect = new Rect(x, y, w, h);

            // Translucent glass panel background
            Widgets.DrawBoxSolidWithOutline(boxRect, new Color(0.04f, 0.05f, 0.08f, 0.93f), new Color(0.25f, 0.45f, 0.75f, 0.6f), 1);

            // Header banner
            Rect headerRect = new Rect(x, y, w, 22f);
            Widgets.DrawBoxSolid(headerRect, new Color(0.10f, 0.14f, 0.22f, 0.95f));

            Text.Font = GameFont.Tiny;
            GUI.color = new Color(0.4f, 0.85f, 1.0f);
            Widgets.Label(new Rect(x + 8f, y + 3f, w - 16f, 18f), "● TWITCH CHAT (#sonoflilith94)");

            // Message list
            List<ChatMessageItem> display;
            lock (syncLock)
            {
                int take = Math.Min(6, Messages.Count);
                display = Messages.GetRange(Messages.Count - take, take);
            }

            float lineY = y + 26f;
            if (display.Count == 0)
            {
                // Never show an empty box on stream. Tell viewers what they can type instead.
                GUI.color = new Color(0.65f, 0.72f, 0.82f);
                Widgets.Label(new Rect(x + 8f, lineY, w - 16f, 60f), "Chat with the AI:\n!ask <question>  ·  !status  ·  !colonists\n!research  ·  !resources  ·  !vote <choice>");
                GUI.color = Color.white;
                return;
            }
            for (int i = 0; i < display.Count; i++)
            {
                var msg = display[i];
                float availH = 30f;
                Rect lineRect = new Rect(x + 6f, lineY, w - 12f, availH);

                // User prefix
                GUI.color = msg.UserColor;
                string label = $"{msg.User}: <color=#E2E8F0>{msg.Text}</color>";
                Widgets.Label(lineRect, label);

                lineY += 32f;
            }

            GUI.color = Color.white;
        }
    }
}
