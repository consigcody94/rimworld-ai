using System;
using System.Collections.Generic;
using UnityEngine;
using Verse;

namespace RimWorldAIBridge
{
    public class PlanTask
    {
        public string Label;
        public string State;      // done | doing | blocked | queued
        public string Note;       // why it is blocked, or what it is waiting on
    }

    /// <summary>
    /// The agent's plan, on screen, where the stream can read it.
    ///
    /// Two problems, one panel. The first is the agent's: it had no plan at all. It re-derived
    /// every decision from scratch on a four second loop, which is why it designated trees and
    /// cancelled them seconds later, and why it chose the farm site three times over. Writing the
    /// plan down forces it to be a plan.
    ///
    /// The second is the viewer's. A colony run by a machine is unreadable from outside: a
    /// colonist walks somewhere, and nothing says whether that was the point or a mistake. The
    /// board says what the AI is trying to do, what it has finished, and what it is stuck on, so
    /// the run can be followed rather than just watched.
    ///
    /// Fed by POST /hud/tasks. Everything drawn here comes from the agent, so it is treated as
    /// untrusted text and stripped of markup exactly as viewer chat is.
    /// </summary>
    public static class TaskBoardHUD
    {
        private static readonly object syncLock = new object();
        private static readonly List<PlanTask> Tasks = new List<PlanTask>();
        private static string goal = "";
        private static string blocker = "";
        private static string day = "";
        public static bool Enabled = true;

        public static void Set(string newGoal, string newDay, string newBlocker, List<PlanTask> tasks)
        {
            lock (syncLock)
            {
                goal = Sanitize(newGoal, 70);
                day = Sanitize(newDay, 30);
                blocker = Sanitize(newBlocker, 90);
                Tasks.Clear();
                if (tasks != null)
                {
                    foreach (var t in tasks)
                    {
                        if (Tasks.Count >= 9) break;
                        Tasks.Add(new PlanTask
                        {
                            Label = Sanitize(t.Label, 46),
                            State = (t.State ?? "queued").ToLowerInvariant(),
                            Note = Sanitize(t.Note, 40),
                        });
                    }
                }
            }
        }

        public static int Count { get { lock (syncLock) return Tasks.Count; } }

        /// <summary>Unity rich text is on for these labels, so no caller can inject markup.</summary>
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

        private static Color StateColor(string state)
        {
            switch (state)
            {
                case "done":    return new Color(0.45f, 0.85f, 0.50f);
                case "doing":   return new Color(1.00f, 0.82f, 0.30f);
                case "blocked": return new Color(1.00f, 0.45f, 0.35f);
                default:        return new Color(0.60f, 0.68f, 0.78f);
            }
        }

        private static string StateMark(string state)
        {
            switch (state)
            {
                case "done":    return "✓";
                case "doing":   return "▸";
                case "blocked": return "✕";
                default:        return "·";
            }
        }

        public static void OnGUI()
        {
            if (!Enabled || Current.ProgramState != ProgramState.Playing) return;

            List<PlanTask> display;
            string g, d, b;
            lock (syncLock)
            {
                if (Tasks.Count == 0 && string.IsNullOrEmpty(goal)) return;
                display = new List<PlanTask>(Tasks);
                g = goal; d = day; b = blocker;
            }

            float w = 300f;
            float headerH = 22f;
            float goalH = string.IsNullOrEmpty(g) ? 0f : 20f;
            float blockerH = string.IsNullOrEmpty(b) ? 0f : 18f;
            float h = headerH + goalH + display.Count * 19f + blockerH + 12f;

            // Left edge, below the top bar, clear of the chat panel on the right.
            float x = 8f;
            float y = 72f;
            Rect box = new Rect(x, y, w, h);

            Widgets.DrawBoxSolidWithOutline(box, new Color(0.04f, 0.06f, 0.05f, 0.93f), new Color(0.30f, 0.55f, 0.38f, 0.6f), 1);
            Widgets.DrawBoxSolid(new Rect(x, y, w, headerH), new Color(0.08f, 0.14f, 0.10f, 0.95f));

            Text.Font = GameFont.Tiny;
            GUI.color = new Color(0.50f, 0.90f, 0.62f);
            Widgets.Label(new Rect(x + 8f, y + 3f, w - 16f, 18f), string.IsNullOrEmpty(d) ? "◆ AI PLAN" : "◆ AI PLAN  ·  " + d);

            float lineY = y + headerH + 2f;
            if (goalH > 0f)
            {
                GUI.color = new Color(0.82f, 0.88f, 0.80f);
                Widgets.Label(new Rect(x + 8f, lineY, w - 16f, 18f), g);
                lineY += goalH;
            }

            foreach (var t in display)
            {
                GUI.color = StateColor(t.State);
                string line = StateMark(t.State) + " " + t.Label;
                if (!string.IsNullOrEmpty(t.Note)) line += "  <color=#8A9A8C>" + t.Note + "</color>";
                Widgets.Label(new Rect(x + 8f, lineY, w - 16f, 18f), line);
                lineY += 19f;
            }

            if (blockerH > 0f)
            {
                GUI.color = new Color(1.00f, 0.55f, 0.40f);
                Widgets.Label(new Rect(x + 8f, lineY, w - 16f, 18f), "waiting on: " + b);
            }

            GUI.color = Color.white;
        }
    }
}
