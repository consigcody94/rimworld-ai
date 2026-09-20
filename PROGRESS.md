# RimWorld AI Bridge Progress

- [done] 1. Native 60fps follow camera with deadzone and dynamic zoom
- [done] 2. In-game Twitch Chat HUD replacing learning helper
- [done] 3. Vocello neural text-to-speech integration on Apple Silicon
- [done] 4. Commit and push all streaming and mod enhancements to GitHub
- [done] 5. Launch Twitch live broadcast stream and greeting
- [in progress] 6. Autonomous Naked Brutality founder survival (founder hut, food, campfire, spike defense)
- [todo] 7. Technology progression: Complex Furniture, Stonecutting, Electricity, Batteries
- [todo] 8. Prisoner recruitment facility and medical clinic
- [todo] 9. Colony expansion to 5 colonists with individual bedrooms and agriculture
- [todo] 10. Colony expansion to 10 colonists with spacer-transition infrastructure

## Now
The first Naked Brutality run ended with the founder starving. Root cause found and fixed: hunger
could not break the recreation timetable, so a pawn that got hungry while in joy mode swam and
slept through 0% food while the agent narrated that food was the only priority. Three starvation
fixes and a dead-air watchdog are in, with 12 regression tests (`npm test`). Ready for run two.

## Log
- 2026-09-19T11:00:00Z Implemented FollowCamera.cs with 60fps lerp tracking, deadzone, and context-dependent zoom.
- 2026-09-19T11:05:00Z Implemented TwitchChatHUD.cs native IMGUI chat overlay in top-right corner; disabled AdaptiveTraining in engine prefs.
- 2026-09-19T11:15:00Z Integrated Vocello Qwen3-TTS 4-bit 1.7B Metal TTS engine on Apple Silicon with fallback to Siri Neural voice.
- 2026-09-19T11:36:15Z Committed and pushed all streaming enhancements, trade API, follow camera, and HUD to GitHub origin/main.
- 2026-09-19T11:38:50Z Started fresh Naked Brutality permadeath game Caveman Empire with curated founder V (Medicine 12**, Plants 6*, Intellectual 6*).
- 2026-09-19T11:39:45Z Twitch live broadcast active at ~30fps 2674 kbits/s with in-game chat HUD and Vocello greeting commentary.
- 2026-09-19T11:41:00Z Configured strict anti-dirt policy (Cleaning: 0), perimeter spike defense, and prisoner recruitment pipeline.
- 2026-09-19T11:58:30Z Stopped live broadcast, terminated colony agent and studio background tasks, released bridge lease, and closed RimWorld.
- 2026-09-19T20:06:00Z Run one ended: founder Trev starved on day 3 with 375 wood and 0 nutrition.
- 2026-09-19T20:55:00Z Found that ffmpeg had been pushing to Twitch for ~62 minutes after RimWorld
  exited: WINDOW LOST only set a status field and nothing stopped the encoder. Broadcast stopped.
- 2026-09-19T21:10:00Z Root-caused the starvation. In manageNeeds, Rule 4 puts a pawn on the joy
  timetable for a mood dip and only Rule 4's own exit branch clears it, but that branch sits below
  Rule 1's `continue`. A pawn that grew hungry while in joy mode could never leave it, and the food
  emergency skips joy-mode pawns, so it stayed on recreation until it died.
- 2026-09-19T21:10:00Z Fixed: hunger clears joy mode above every early return; a rested pawn asleep
  or at leisure under 15% food gets interrupted; new eatSomething() orders an explicit Ingest on the
  nearest edible item and unforbids it when that is the only food (crash debris and drop pods arrive
  forbidden). Added nutrition and humanEdible to the /things serializer so agents can find food.
- 2026-09-19T21:10:00Z Added a capture watchdog: the stream engine now stops the broadcast when the
  window stays lost past STREAM_WINDOW_LOST_GRACE_MS (default 120s) instead of pushing dead air.
- 2026-09-19T21:15:00Z Verified live against a running RimWorld 1.6.4871: /things reports nutrition
  and humanEdible, and eatSomething unforbade a turkey egg and put the colonist into an Ingest job.
- 2026-09-19T21:20:00Z Added `npm test`: 12 regression tests over the needs loop and the watchdog.
  Three of them fail against the pre-fix agent, which is the proof the starvation path was real.
