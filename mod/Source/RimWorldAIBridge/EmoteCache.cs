using System;
using System.Collections.Generic;
using System.Net;
using System.Threading;
using UnityEngine;
using Verse;

namespace RimWorldAIBridge
{
    /// <summary>
    /// Emote images, fetched once and kept.
    ///
    /// The chat HUD drew every message as plain text, so a viewer typing a 7TV emote appeared on
    /// the broadcast as the literal word `catJAM`. Every chat overlay people actually use solves
    /// this, and it is most of the difference between a stream that reads as live and one that
    /// reads as a log file.
    ///
    /// Downloads run on Unity's own coroutine scheduler so the game thread never blocks on the
    /// network, and a texture is fetched at most once per url: a busy chat repeats the same
    /// dozen emotes hundreds of times in an hour. A failed download is remembered as failed, so
    /// a dead CDN costs one request rather than one per message.
    ///
    /// Everything here comes from a third-party image host, so it is bounded: a hard cap on how
    /// many textures are kept, and a size limit on each, because an unbounded cache fed by chat
    /// is something viewers control.
    /// </summary>
    public static class EmoteCache
    {
        private const int MaxTextures = 220;
        private const int MaxBytes = 512 * 1024;
        private const int MaxPixels = 128;

        private static readonly Dictionary<string, Texture2D> textures = new Dictionary<string, Texture2D>();
        private static readonly HashSet<string> inFlight = new HashSet<string>();
        private static readonly HashSet<string> failed = new HashSet<string>();
        private static readonly object sync = new object();

        /// <summary>The texture if it is here, otherwise null and a fetch is started.</summary>
        public static Texture2D Get(string url)
        {
            if (string.IsNullOrEmpty(url)) return null;
            lock (sync)
            {
                if (textures.TryGetValue(url, out var t)) return t;
                if (failed.Contains(url) || inFlight.Contains(url)) return null;
                if (textures.Count >= MaxTextures) return null;
                inFlight.Add(url);
            }
            Download(url);
            return null;
        }

        /// <summary>
        /// Fetch the bytes off the game thread, then hand them to the main thread to become a
        /// texture. Texture2D can only be created on the main thread, and the network call must
        /// not happen there, so the work is split across the pump that already exists.
        ///
        /// LoadImage decodes PNG and JPG only. The studio therefore only ever sends PNG urls,
        /// and an emote with no PNG form arrives with no url at all, which the HUD draws as the
        /// name the viewer typed.
        /// </summary>
        private static void Download(string url)
        {
            if (!IsAllowedHost(url))
            {
                lock (sync) { inFlight.Remove(url); failed.Add(url); }
                return;
            }

            ThreadPool.QueueUserWorkItem(_ =>
            {
                byte[] bytes = null;
                try
                {
                    using (var client = new WebClient())
                    {
                        client.Headers.Add("User-Agent", "RimWorldAIBridge/0.1");
                        bytes = client.DownloadData(url);
                    }
                    if (bytes != null && bytes.Length > MaxBytes) bytes = null;
                }
                catch { bytes = null; }

                var payload = bytes;
                MainThread.Post(() =>
                {
                    Texture2D tex = null;
                    try
                    {
                        if (payload != null)
                        {
                            tex = new Texture2D(2, 2, TextureFormat.RGBA32, false);
                            if (!tex.LoadImage(payload) || tex.width > MaxPixels || tex.height > MaxPixels)
                            {
                                UnityEngine.Object.Destroy(tex);
                                tex = null;
                            }
                            else
                            {
                                tex.filterMode = FilterMode.Bilinear;
                            }
                        }
                    }
                    catch { tex = null; }

                    lock (sync)
                    {
                        inFlight.Remove(url);
                        if (tex != null) textures[url] = tex;
                        else failed.Add(url);
                    }
                });
            });
        }

        private static bool IsAllowedHost(string url)
        {
            return url.StartsWith("https://static-cdn.jtvnw.net/", StringComparison.OrdinalIgnoreCase)
                || url.StartsWith("https://cdn.7tv.app/", StringComparison.OrdinalIgnoreCase)
                || url.StartsWith("https://cdn.betterttv.net/", StringComparison.OrdinalIgnoreCase)
                || url.StartsWith("https://cdn.frankerfacez.com/", StringComparison.OrdinalIgnoreCase);
        }

        public static int Count { get { lock (sync) return textures.Count; } }
        public static int Failed { get { lock (sync) return failed.Count; } }
    }
}
