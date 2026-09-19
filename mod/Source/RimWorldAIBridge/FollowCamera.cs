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
        public static float Deadzone = 3.2f;
        public static float SmoothSpeed = 4.2f;
        public static float ZoomSmoothSpeed = 2.8f;
        public static float DesiredZoom = 21.0f;
        public static DateTime ManualOverrideUntil = DateTime.MinValue;

        public static void SetTarget(Pawn p, float? zoom = null)
        {
            Target = p;
            Enabled = true;
            if (zoom.HasValue) DesiredZoom = zoom.Value;
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
            float dist = Vector2.Distance(new Vector2(camPos.x, camPos.z), new Vector2(pawnPos.x, pawnPos.z));

            if (dist > Deadzone)
            {
                Vector3 nextPos = Vector3.Lerp(camPos, pawnPos, Time.deltaTime * SmoothSpeed);
                float nextZoom = Mathf.Lerp(cam.RootSize, DesiredZoom, Time.deltaTime * ZoomSmoothSpeed);
                cam.SetRootPosAndSize(nextPos, nextZoom);
            }
            else if (Mathf.Abs(cam.RootSize - DesiredZoom) > 0.25f)
            {
                float nextZoom = Mathf.Lerp(cam.RootSize, DesiredZoom, Time.deltaTime * ZoomSmoothSpeed);
                cam.SetRootPosAndSize(camPos, nextZoom);
            }
        }
    }
}
