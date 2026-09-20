/**
 * Emotes, which are most of what a Twitch message actually says.
 *
 * The in-game chat HUD rendered every message as plain text, so a viewer typing a 7TV emote saw
 * the literal token `catJAM` on the broadcast. Every chat overlay worth using solves this the
 * same way and it is the single largest visual difference between a stream that looks live and
 * one that looks like a log file.
 *
 * Four sources, resolved in the order Twitch itself resolves them:
 *
 * 1. Twitch's own emotes, which arrive already located in the IRC `emotes` tag as
 *    `25:0-4,12-16/1902:6-10` — id, then character ranges into the message. No lookup needed
 *    and no API call: the positions are authoritative, which matters because a subscriber emote
 *    is only an emote for the people who can use it.
 * 2. 7TV, 3. BetterTTV, 4. FrankerFaceZ, each of which is a name-to-image map with a global set
 *    and a per-channel set. These are matched on whole words only; `catJAM` inside `thecatJAMs`
 *    is not an emote.
 *
 * Sets are fetched once at startup and refreshed hourly. Every one of these services can be
 * down, and none of them is worth failing a broadcast over, so each failure leaves that source
 * empty and the rest carry on.
 */

const TWITCH_CDN = (id) => `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/1.0`;
const REFRESH_MS = 60 * 60 * 1000;

async function getJson(url, timeoutMs = 6000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

export class EmoteResolver {
  constructor({ channel, channelId = null, log = () => {} } = {}) {
    this.channel = channel;
    this.channelId = channelId;
    this.log = log;
    this.map = new Map();            // lowercase name -> { name, url, source }
    this.exact = new Map();          // exact-case name -> entry, checked first
    this.loadedAt = 0;
    this.counts = { sevenTv: 0, bttv: 0, ffz: 0 };
  }

  add(name, url, source) {
    if (!name || !url) return;
    const entry = { name, url, source };
    this.exact.set(name, entry);
    if (!this.map.has(name.toLowerCase())) this.map.set(name.toLowerCase(), entry);
  }

  /** Global plus channel sets from all three third-party services. Failures are per-source. */
  async load() {
    const before = this.exact.size;
    this.counts = { sevenTv: 0, bttv: 0, ffz: 0 };

    // 7TV. The v3 API takes a Twitch user id for the channel set.
    try {
      const global = await getJson("https://7tv.io/v3/emote-sets/global");
      for (const e of global.emotes ?? []) {
        this.add(e.name, this.sevenTvUrl(e), "7tv");
        this.counts.sevenTv++;
      }
    } catch (e) { this.log(`7TV global unavailable: ${e.message}`); }
    if (this.channelId) {
      try {
        const user = await getJson(`https://7tv.io/v3/users/twitch/${this.channelId}`);
        for (const e of user?.emote_set?.emotes ?? []) {
          this.add(e.name, this.sevenTvUrl(e), "7tv");
          this.counts.sevenTv++;
        }
      } catch (e) { this.log(`7TV channel set unavailable: ${e.message}`); }
    }

    // BetterTTV.
    try {
      const global = await getJson("https://api.betterttv.net/3/cached/emotes/global");
      for (const e of global ?? []) { this.add(e.code, `https://cdn.betterttv.net/emote/${e.id}/1x.png`, "bttv"); this.counts.bttv++; }
    } catch (e) { this.log(`BTTV global unavailable: ${e.message}`); }
    if (this.channelId) {
      try {
        const chan = await getJson(`https://api.betterttv.net/3/cached/users/twitch/${this.channelId}`);
        for (const e of [...(chan.channelEmotes ?? []), ...(chan.sharedEmotes ?? [])]) {
          this.add(e.code, `https://cdn.betterttv.net/emote/${e.id}/1x.png`, "bttv");
          this.counts.bttv++;
        }
      } catch (e) { this.log(`BTTV channel set unavailable: ${e.message}`); }
    }

    // FrankerFaceZ.
    try {
      const global = await getJson("https://api.frankerfacez.com/v1/set/global");
      for (const set of Object.values(global.sets ?? {})) {
        for (const e of set.emoticons ?? []) { this.add(e.name, this.ffzUrl(e), "ffz"); this.counts.ffz++; }
      }
    } catch (e) { this.log(`FFZ global unavailable: ${e.message}`); }
    if (this.channelId) {
      try {
        const room = await getJson(`https://api.frankerfacez.com/v1/room/id/${this.channelId}`);
        for (const set of Object.values(room.sets ?? {})) {
          for (const e of set.emoticons ?? []) { this.add(e.name, this.ffzUrl(e), "ffz"); this.counts.ffz++; }
        }
      } catch (e) { this.log(`FFZ channel set unavailable: ${e.message}`); }
    }

    this.loadedAt = Date.now();
    this.log(`Emotes: ${this.exact.size} loaded (${this.counts.sevenTv} 7TV, ${this.counts.bttv} BTTV, ${this.counts.ffz} FFZ)${before ? `, was ${before}` : ""}.`);
    return this.exact.size;
  }

  /**
   * PNG only, deliberately.
   *
   * RimWorld renders these through Texture2D.LoadImage, which decodes PNG and JPG and nothing
   * else. 7TV serves WebP and AVIF for everything and adds a PNG only for static emotes, so an
   * animated emote has no form the game can draw. Returning its WebP would mean a silent gap in
   * the message; returning null lets the HUD fall back to showing the name the viewer typed,
   * which is at least true.
   */
  sevenTvUrl(e) {
    const files = e?.data?.host?.files ?? [];
    const pick = files.find((f) => f.name === "1x.png") ?? files.find((f) => f.name === "2x.png");
    const host = e?.data?.host?.url;
    return host && pick ? `https:${host}/${pick.name}` : null;
  }

  ffzUrl(e) {
    const u = e.urls ?? {};
    const path = u["1"] ?? u["2"] ?? u["4"];
    return path ? (path.startsWith("//") ? `https:${path}` : path) : null;
  }

  async refreshIfStale() {
    if (Date.now() - this.loadedAt > REFRESH_MS) {
      try { await this.load(); } catch {}
    }
  }

  /**
   * Turn one chat message into ordered parts: runs of text and emotes with their image urls.
   *
   * Twitch's own emotes come from the tag and win, because the tag knows which emotes this
   * particular viewer was entitled to use. Third-party names are then matched on the remaining
   * text, whole words only.
   */
  parse(message, emotesTag = "") {
    const claims = [];

    if (emotesTag) {
      for (const group of emotesTag.split("/")) {
        const [id, ranges] = group.split(":");
        if (!id || !ranges) continue;
        for (const range of ranges.split(",")) {
          const [a, b] = range.split("-").map(Number);
          if (Number.isFinite(a) && Number.isFinite(b)) {
            claims.push({ start: a, end: b + 1, url: TWITCH_CDN(id), source: "twitch" });
          }
        }
      }
    }

    // Twitch indexes the tag by CODE POINT, not by UTF-16 unit, so a message containing an emoji
    // before an emote would otherwise be sliced in the wrong place.
    const chars = Array.from(message);
    claims.sort((p, q) => p.start - q.start);

    const parts = [];
    let cursor = 0;
    const pushText = (text) => {
      if (!text) return;
      // Third-party emotes only exist in the text Twitch did not already claim.
      for (const token of text.split(/(\s+)/)) {
        if (!token.trim()) { if (token) parts.push({ type: "text", text: token }); continue; }
        const hit = this.exact.get(token) ?? this.map.get(token.toLowerCase());
        if (hit && hit.url) parts.push({ type: "emote", name: hit.name, url: hit.url, source: hit.source });
        else parts.push({ type: "text", text: token });
      }
    };

    for (const c of claims) {
      if (c.start < cursor) continue;                    // overlapping claim, ignore
      pushText(chars.slice(cursor, c.start).join(""));
      parts.push({ type: "emote", name: chars.slice(c.start, c.end).join(""), url: c.url, source: "twitch" });
      cursor = c.end;
    }
    pushText(chars.slice(cursor).join(""));

    // Collapse neighbouring text runs so the HUD draws fewer labels.
    const merged = [];
    for (const p of parts) {
      const last = merged[merged.length - 1];
      if (p.type === "text" && last?.type === "text") last.text += p.text;
      else merged.push({ ...p });
    }
    return merged;
  }
}

/**
 * The badges a viewer is wearing, as a short marker the HUD can colour.
 * Twitch sends these as `badges=broadcaster/1,subscriber/12`.
 */
export function parseBadges(badgesTag = "") {
  const out = [];
  for (const b of badgesTag.split(",")) {
    const name = b.split("/")[0];
    if (!name) continue;
    if (name === "broadcaster") out.push({ key: "broadcaster", mark: "◆", color: "#E91916" });
    else if (name === "moderator") out.push({ key: "moderator", mark: "⚔", color: "#00AD03" });
    else if (name === "vip") out.push({ key: "vip", mark: "◈", color: "#E005B9" });
    else if (name === "subscriber") out.push({ key: "subscriber", mark: "★", color: "#9147FF" });
    else if (name === "founder") out.push({ key: "founder", mark: "☆", color: "#9147FF" });
    else if (name === "partner") out.push({ key: "partner", mark: "✓", color: "#9147FF" });
  }
  return out;
}
