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
        public static readonly List<ChatMessageItem> Messages = new List<ChatMessageItem>();
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

        public static void AddMessage(string user, string text, string hexColor = null)
        {
            if (string.IsNullOrEmpty(user) || string.IsNullOrEmpty(text)) return;
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

            float w = 295f;
            float h = 230f;
            float x = Screen.width - w - 8f;
            float y = 8f;
            Rect boxRect = new Rect(x, y, w, h);

            // Translucent glass panel background
            Widgets.DrawBoxSolidWithOutline(boxRect, new Color(0.05f, 0.06f, 0.09f, 0.82f), new Color(0.25f, 0.45f, 0.75f, 0.6f), 1);

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
