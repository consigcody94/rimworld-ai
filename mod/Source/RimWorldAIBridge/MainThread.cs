using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using UnityEngine;
using Verse;

namespace RimWorldAIBridge
{
    /// <summary>
    /// RimWorld is single threaded: every touch of game state must happen on the Unity main thread.
    /// The HTTP listener runs on a worker thread and hands closures to this pump, which drains them
    /// from a persistent MonoBehaviour's Update() so it works on the main menu, while paused, and in play.
    /// </summary>
    public static class MainThread
    {
        private sealed class WorkItem
        {
            public Func<object> Work;
            public object Result;
            public Exception Error;
            /// <summary>Set when the caller gave up waiting. The pump skips these rather than
            /// applying an order the client already treated as failed and re-sent.</summary>
            public volatile bool Abandoned;
            public readonly ManualResetEventSlim Done = new ManualResetEventSlim(false);
        }

        private static readonly ConcurrentQueue<WorkItem> queue = new ConcurrentQueue<WorkItem>();
        private static readonly List<Action> everyFrame = new List<Action>();
        private static int mainThreadId = -1;
        private static Pump pump;

        /// <summary>
        /// Milliseconds since the pump last ran, or -1 if it never has.
        ///
        /// The sentinel matters: starting this at zero and subtracting would report a loop that
        /// has never run as perfectly healthy, which is the exact shape of the bug this field
        /// exists to catch. An agent reads it to ask whether the game is simulating without
        /// having to touch game state, which is the one question it cannot otherwise answer about
        /// itself: a stopped game looks identical to a slow one from inside the loop.
        /// </summary>
        private static long lastPumpMs = -1;
        public static long PumpAgeMs => lastPumpMs < 0 ? -1 : (long)(DateTime.UtcNow - DateTime.MinValue).TotalMilliseconds - lastPumpMs;

        /// <summary>Budget per frame for queued work, so a burst of API calls cannot stall rendering.</summary>
        public const double FrameBudgetMs = 12.0;

        public static bool IsMainThread => Thread.CurrentThread.ManagedThreadId == mainThreadId;

        public static void EnsurePump()
        {
            if (pump != null) return;
            try
            {
                Application.runInBackground = true;
                Prefs.RunInBackground = true;
            }
            catch { }
            mainThreadId = Thread.CurrentThread.ManagedThreadId;
            var go = new GameObject("RimWorldAIBridge.MainThreadPump");
            UnityEngine.Object.DontDestroyOnLoad(go);
            pump = go.AddComponent<Pump>();
        }

        /// <summary>Register a callback that runs once per frame on the main thread (event capture, timers).</summary>
        public static void OnEveryFrame(Action a)
        {
            lock (everyFrame) everyFrame.Add(a);
        }

        /// <summary>Run work on the main thread and block the caller until it finishes (or times out).</summary>
        public static object Run(Func<object> work, int timeoutMs = 30000)
        {
            if (IsMainThread) return work();
            var item = new WorkItem { Work = work };
            queue.Enqueue(item);
            if (!item.Done.Wait(timeoutMs))
            {
                item.Abandoned = true;
                throw new TimeoutException("Main thread did not process the request within " + timeoutMs + " ms (is the game frozen or a modal dialog blocking?)");
            }
            if (item.Error != null)
            {
                if (item.Error is BridgeException) throw item.Error;
                throw new BridgeException(item.Error.Message, item.Error);
            }
            return item.Result;
        }

        public static void Run(Action work, int timeoutMs = 30000)
        {
            Run(() => { work(); return null; }, timeoutMs);
        }

        /// <summary>Fire and forget on the main thread.</summary>
        /// <summary>
        /// Run a Unity coroutine on the mod's own persistent behaviour.
        ///
        /// Downloading an emote image must not block the game thread, and UnityWebRequest is only
        /// usable from a coroutine, so the pump that already exists for main-thread work doubles
        /// as the place those downloads live.
        /// </summary>
        public static void StartCoroutine(System.Collections.IEnumerator routine)
        {
            try { pump?.StartCoroutine(routine); }
            catch (Exception e) { Log.ErrorOnce("[RimWorldAIBridge] coroutine failed to start: " + e, 7802); }
        }

        public static void Post(Action work)
        {
            queue.Enqueue(new WorkItem { Work = () => { work(); return null; } });
        }

        private sealed class Pump : MonoBehaviour
        {
            private readonly Stopwatch sw = new Stopwatch();

            private void Update()
            {
                lastPumpMs = (long)(DateTime.UtcNow - DateTime.MinValue).TotalMilliseconds;
                if (!Application.runInBackground)
                {
                    Application.runInBackground = true;
                }
                lock (everyFrame)
                {
                    for (int i = 0; i < everyFrame.Count; i++)
                    {
                        try { everyFrame[i](); }
                        catch (Exception e) { Log.ErrorOnce("[RimWorldAIBridge] frame hook failed: " + e, 7741 + i); }
                    }
                }
                if (queue.IsEmpty) return;
                sw.Restart();
                while (queue.TryDequeue(out WorkItem item))
                {
                    // The caller already gave up on this one and has very likely re-sent the order.
                    // Running it now would apply the same order twice, against stale coordinates.
                    if (item.Abandoned) { item.Done.Dispose(); continue; }
                    try { item.Result = item.Work(); }
                    catch (Exception e) { item.Error = e; }
                    finally { item.Done.Set(); }
                    if (sw.Elapsed.TotalMilliseconds > FrameBudgetMs) break;
                }
            }

            private void OnGUI()
            {
                try { TwitchChatHUD.OnGUI(); TaskBoardHUD.OnGUI(); }
                catch (Exception e) { Log.ErrorOnce("[RimWorldAIBridge] OnGUI failed: " + e, 7799); }
            }
        }
    }

    /// <summary>Error that should be reported to the API client as a 4xx/5xx with a message, not swallowed.</summary>
    public class BridgeException : Exception
    {
        public int Status { get; }
        public BridgeException(string message, int status = 400) : base(message) { Status = status; }
        public BridgeException(string message, Exception inner, int status = 500) : base(message, inner) { Status = status; }
    }
}
