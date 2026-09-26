# RimWorld AI: operator runbook

An autonomous agent plays a RimWorld colony and a studio streams it to Twitch. **The colony agent
is the player. You keep it running, watch it, and improve it.** Every earlier AI operator failed the
same way: stopped the stack and never restarted it, played by hand for a while and left, or reported
things the logs did not say. This file exists so that does not happen again.

## The five commands

    cd ~/Desktop/rimworld-ai
    npm run preflight        # is everything ready? starts nothing, prints no secrets
    npm run up -- --new      # start everything with a fresh colony (omit --new to resume the newest save)
    npm run report           # what the run has achieved, what it is stuck on, the last log lines
    npm run status           # processes, colonists, and whether the channel is LIVE
    npm run down             # end the broadcast cleanly and stop the stack (-- --quit-game closes RimWorld)

`up` starts the studio and the supervisor. The supervisor starts the colony, the colony agent and
the broadcast, restarts what dies, kills what hangs, relaunches the game after a crash, and starts
a fresh colony after a wipe. Nothing else needs starting.

## Your loop

1. `npm run preflight`. Fix anything marked with a cross; warnings are fine.
2. `npm run up -- --new`.
3. Every ten minutes, `npm run report`. Quote it; do not describe it from memory.
4. Act only on what the report shows:
   - `stall` more than twice in a row: read the journal line it names, find the cause in
     `scripts/colony-agent.mjs`, fix it, `npm test`, then `npm run down -- --quit-game` and
     `npm run up -- --new`. A fix is tested on a fresh colony, never on a save.
   - `colony-lost`: nothing to do; the supervisor starts a new colony. Note the cause in PROGRESS.md.
   - the bridge not answering for more than three minutes with RimWorld running: `npm run down`,
     then `npm run up`.
5. When you stop working, leave the stack running unless you were told to stop it.

## Rules

- Never stop the stack, kill a process, or quit RimWorld except through `npm run down`, and only
  when asked or when this runbook says so.
- Never paste `ps` output, `.env`, environment variables or raw ffmpeg lines anywhere. `npm run
  report` and `npm run status` are redacted; nothing else is. A leaked stream key must be rotated.
- Never claim something is built, fixed, live or verified without the tool output that shows it.
  If you did not do it, say so.
- No dev mode, no god mode. `/status` reports both; both stay false.
- `npm test` before and after any change to `scripts/` or `stream-app/`. Every test names the run
  that failed without it.
- To play by hand, `npm run pause` first (the agent idles, the stream stays up), then `npm run
  resume`. Orders go through the bridge or the `rimworld` MCP server, never through the mouse.
- Commit as the repo's own identity (consigcody94), and only when asked.

## Where the knowledge is

- `OPERATIONS.md`: how the pieces fit, the house plan, the stream internals, the game facts that
  cost colonies, and what to report.
- `PLAYGUIDE.md`: the bridge contract, every route, and the strategy manual, including the
  storyteller's scripted first week (day 4 and day 6 are appointments, not luck).
- `PROGRESS.md`: the goal ladder and why each run ended.
- `runs/*.md`: one summary per run, with the milestones it reached and how it ended.
