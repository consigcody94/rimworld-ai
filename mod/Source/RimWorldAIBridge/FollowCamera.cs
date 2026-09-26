using System;
using System.Linq;
using UnityEngine;
using Verse;
using RimWorld;

namespace RimWorldAIBridge
{
    /// <summary>
    /// Smooth follow camera inspired by Follow Cam (Steam Workshop #3724388977).
    /// Features:
    /// - Continuous per-frame lerp (butter-smooth 60fps tracking).
    /// - Deadzone radius: prevents jitter when colonist moves within a work area.
    /// - Context-aware zoom: close-up for sleeping/eating/joy, medium for work, wide for combat/threats.
    /// - Player override detection: pauses follow for 3s if player pans manually.
    /// </summary>
    public static class FollowCamera
    {
        public static Pawn Target = null;
        public static bool Enabled = true;
        public static float Deadzone = 6.0f;
        public static float SmoothSpeed = 2.2f;
        public static float ZoomSmoothSpeed = 1.4f;
        public static float DesiredZoom = 21.0f;
        public static DateTime ManualOverrideUntil = DateTime.MinValue;
        private static Vector3 anchor;
        private static bool anchorValid;
        private static int anchorTarget = -1;
        /// <summary>How fast the trailing anchor follows the pawn. Lower is smoother.</summary>
        public static float AnchorSpeed = 3.0f;
        public static DateTime ZoomOverrideUntil = DateTime.MinValue;

        public static void SetTarget(Pawn p, float? zoom = null)
        {
            if (!ReferenceEquals(Target, p)) anchorValid = false;
            Target = p;
            Enabled = true;
            if (zoom.HasValue)
            {
                DesiredZoom = zoom.Value;
                ZoomOverrideUntil = DateTime.UtcNow.AddSeconds(45);
            }
            else ZoomOverrideUntil = DateTime.MinValue;
        }

        public static void Update()
        {
            if (Current.ProgramState != ProgramState.Playing || Find.CurrentMap == null || Find.CameraDriver == null) return;

            // Detect manual player input
            if (Input.GetMouseButton(0) || Input.GetMouseButton(1) || Input.GetMouseButton(2) ||
                Input.GetKey(KeyCode.W) || Input.GetKey(KeyCode.A) || Input.GetKey(KeyCode.S) || Input.GetKey(KeyCode.D) ||
                Input.GetKey(KeyCode.UpArrow) || Input.GetKey(KeyCode.DownArrow) || Input.GetKey(KeyCode.LeftArrow) || Input.GetKey(KeyCode.RightArrow))
            {
                ManualOverrideUntil = DateTime.UtcNow.AddSeconds(3.0);
                anchorValid = false;
            }

            if (DateTime.UtcNow < ManualOverrideUntil) return;
            if (!Enabled) return;

            // Auto-acquire target if none or dead/despawned
            if (Target == null || !Target.Spawned || Target.Dead || Target.Map != Find.CurrentMap)
            {
                var colonists = Find.CurrentMap.mapPawns?.FreeColonistsSpawned;
                if (colonists != null && colonists.Count > 0)
                {
                    Target = colonists.FirstOrDefault(p => !p.Dead && !p.Downed) ?? colonists.FirstOrDefault(p => !p.Dead);
                }
                if (Target == null) return;
            }

            // An explicit zoom from /camera or /camera/follow is honoured for a while instead of
            // being overwritten by the context rule on the very next frame.
            if (DateTime.UtcNow < ZoomOverrideUntil)
            {
                // keep DesiredZoom as set by the caller
            }
            else
            // Context-aware dynamic zoom
            if (Target.Drafted || (Target.CurJob != null && Target.CurJob.def.defName.IndexOf("Attack", StringComparison.OrdinalIgnoreCase) >= 0))
            {
                DesiredZoom = 28f;
            }
            else if (RestUtility.InBed(Target) || (Target.CurJob != null && Target.CurJob.def.defName.IndexOf("LayDown", StringComparison.OrdinalIgnoreCase) >= 0))
            {
                DesiredZoom = 15f;
            }
            else if (Target.CurJob != null && (Target.CurJob.def.defName.IndexOf("Ingest", StringComparison.OrdinalIgnoreCase) >= 0 || Target.CurJob.def.defName.IndexOf("Joy", StringComparison.OrdinalIgnoreCase) >= 0))
            {
                DesiredZoom = 17f;
            }
            else
            {
                DesiredZoom = 21f;
            }

            var cam = Find.CameraDriver;
            Vector3 camPos = cam.MapPosition.ToVector3Shifted();
            Vector3 pawnPos = Target.DrawPos;

            // Stage 1: an anchor that trails the pawn. Seeded on first use and on target change so
            // it never sweeps across the map from a stale position.
            if (!anchorValid || anchorTarget != Target.thingIDNumber)
            {
                anchor = pawnPos;
                anchorTarget = Target.thingIDNumber;
                anchorValid = true;
            }
            anchor = Vector3.Lerp(anchor, pawnPos, Mathf.Clamp01(Time.deltaTime * AnchorSpeed));

            float dist = Vector2.Distance(new Vector2(camPos.x, camPos.z), new Vector2(anchor.x, anchor.z));

            if (dist > Deadzone)
            {
                // Move only partway into the deadzone. Chasing the pawn itself makes a working
                // colonist oscillate around the centre and hides more of the area ahead.
                Vector3 offset = anchor - camPos;
                Vector3 destination = anchor - offset * (Deadzone * 0.45f / dist);
                // A target on the other side of a large map should reframe at once rather than
                // spend the next several seconds showing empty terrain during a long pan.
                Vector3 nextPos = dist > 45f ? anchor :
                    Vector3.Lerp(camPos, destination, Mathf.Clamp01(Time.deltaTime * SmoothSpeed));
                float nextZoom = Mathf.Lerp(cam.RootSize, DesiredZoom, Mathf.Clamp01(Time.deltaTime * ZoomSmoothSpeed));
                cam.SetRootPosAndSize(nextPos, nextZoom);
            }
            else
            {
                if (Mathf.Abs(cam.RootSize - DesiredZoom) > 0.25f)
                    cam.SetRootPosAndSize(camPos, Mathf.Lerp(cam.RootSize, DesiredZoom, Mathf.Clamp01(Time.deltaTime * ZoomSmoothSpeed)));
            }
        }
    }
}
