/**
 * Twitch Helix API Integration
 * Handles category selection (RimWorld game_id: 394568) and stream title management.
 */

export const RIMWORLD_GAME_ID = "394568";
export const DEFAULT_STREAM_TITLE = "AI Plays RimWorld 24/7 | Cassandra Classic | Autonomous Colony & Chat Interaction";
export const DEFAULT_TAGS = ["RimWorld", "AI", "Simulation", "Autonomous"];

export async function updateTwitchChannelInfo({
  clientId,
  token,
  broadcasterId,
  title = DEFAULT_STREAM_TITLE,
  gameId = RIMWORLD_GAME_ID,
  tags = DEFAULT_TAGS,
}) {
  if (!clientId || !token) {
    throw new Error("Missing Twitch Client ID or OAuth token. Configure in .env or stream studio settings.");
  }

  const cleanToken = token.replace(/^oauth:/i, "");

  // If broadcasterId is not provided, fetch user info from token
  let bId = broadcasterId;
  if (!bId) {
    const userRes = await fetch("https://api.twitch.tv/helix/users", {
      headers: {
        "Client-Id": clientId,
        "Authorization": `Bearer ${cleanToken}`,
      },
    });
    if (!userRes.ok) {
      const err = await userRes.text();
      throw new Error(`Failed to resolve Twitch user: ${err}`);
    }
    const userData = await userRes.json();
    bId = userData.data?.[0]?.id;
    if (!bId) {
      throw new Error("No user found for provided token.");
    }
  }

  // Update channel information via Helix API
  const updateRes = await fetch(`https://api.twitch.tv/helix/channels?broadcaster_id=${bId}`, {
    method: "PATCH",
    headers: {
      "Client-Id": clientId,
      "Authorization": `Bearer ${cleanToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      game_id: gameId,
      title: title.slice(0, 140),
      broadcaster_language: "en",
      tags: tags.slice(0, 10),
    }),
  });

  if (!updateRes.ok) {
    const errText = await updateRes.text();
    throw new Error(`Failed to update Twitch channel: ${errText}`);
  }

  return {
    ok: true,
    broadcasterId: bId,
    title,
    gameId,
    category: "RimWorld",
  };
}
