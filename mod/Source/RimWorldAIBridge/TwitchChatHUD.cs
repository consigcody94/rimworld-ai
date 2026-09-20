using System;
using System.Collections.Generic;
using UnityEngine;
using Verse;

namespace RimWorldAIBridge
{
    public class ChatPart
    {
        public string Text;      // set for a text run
        public string Url;       // set for an emote
    }

    public class ChatBadge
    {
        public string Mark;
        public Color Color;
    }

    public class ChatMessageItem
    {
        public string User;
        public string Text;                 // plain fallback, still used for width and for logs
        public Color UserColor;
        public DateTime Timestamp;
        public List<ChatPart> Parts;        // null when the message is plain text
        public List<ChatBadge> Badges;
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

        public static void AddMessage(string user, string text, string hexColor = null,
                                      List<ChatPart> parts = null, List<ChatBadge> badges = null)
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
                    Timestamp = DateTime.UtcNow,
                    Parts = parts,
                    Badges = badges,
                });
                if (Messages.Count > 40)
                {
                    Messages.RemoveAt(0);
                }
            }
        }

        private static string BadgePrefix(ChatMessageItem msg)
        {
            if (msg.Badges == null || msg.Badges.Count == 0) return "";
            var sb = new System.Text.StringBuilder();
            foreach (var b in msg.Badges)
            {
                if (string.IsNullOrEmpty(b.Mark)) continue;
                sb.Append("<color=#").Append(ColorUtility.ToHtmlStringRGB(b.Color)).Append(">").Append(b.Mark).Append("</color>");
            }
            if (sb.Length > 0) sb.Append(' ');
            return sb.ToString();
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

            float w = 340f;
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

                // A message with no resolved parts is still plain text: one label, as before.
                if (msg.Parts == null || msg.Parts.Count == 0)
                {
                    GUI.color = msg.UserColor;
                    Widgets.Label(new Rect(x + 6f, lineY, w - 12f, 30f), BadgePrefix(msg) + $"{msg.User}: <color=#E2E8F0>{msg.Text}</color>");
                    lineY += 32f;
                    continue;
                }

                // Emotes are images, so the line is laid out by hand: a cursor walks across the
                // panel placing each run of text and each emote, and wraps when it runs out of
                // width. Emotes are drawn at the line height so they sit on the text baseline.
                float left = x + 6f;
                float right = x + w - 6f;
                float cursorX = left;
                float lineH = 20f;

                GUI.color = msg.UserColor;
                string head = BadgePrefix(msg) + msg.User + ": ";
                float headW = Text.CalcSize(head).x;
                Widgets.Label(new Rect(cursorX, lineY, headW + 4f, lineH), head);
                cursorX += headW;

                foreach (var part in msg.Parts)
                {
                    if (!string.IsNullOrEmpty(part.Url))
                    {
                        var tex = EmoteCache.Get(part.Url);
                        float size = lineH - 2f;
                        if (tex != null)
                        {
                            if (cursorX + size > right) { cursorX = left; lineY += lineH; }
                            GUI.color = Color.white;
                            GUI.DrawTexture(new Rect(cursorX, lineY + 1f, size, size), tex, ScaleMode.ScaleToFit);
                            cursorX += size + 2f;
                        }
                        else
                        {
                            // Not downloaded yet, or the CDN refused. Show the emote's name, which
                            // is what the viewer typed, rather than a gap.
                            GUI.color = new Color(0.55f, 0.70f, 0.95f);
                            string nm = part.Text ?? "";
                            float nw = Text.CalcSize(nm).x;
                            if (cursorX + nw > right) { cursorX = left; lineY += lineH; }
                            Widgets.Label(new Rect(cursorX, lineY, nw + 4f, lineH), nm);
                            cursorX += nw + 2f;
                        }
                        continue;
                    }

                    GUI.color = new Color(0.886f, 0.910f, 0.941f);
                    foreach (var word in (part.Text ?? "").Split(' '))
                    {
                        if (word.Length == 0) { cursorX += 4f; continue; }
                        float ww = Text.CalcSize(word + " ").x;
                        if (cursorX + ww > right) { cursorX = left; lineY += lineH; }
                        Widgets.Label(new Rect(cursorX, lineY, ww + 4f, lineH), word);
                        cursorX += ww;
                    }
                }

                lineY += lineH + 6f;
                if (lineY > y + h - 12f) break;
            }

            GUI.color = Color.white;
        }
    }
}
