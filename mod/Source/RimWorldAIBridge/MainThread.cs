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
            public readonly ManualResetEventSlim Done = new ManualResetEventSlim(false);
        }

        private static readonly ConcurrentQueue<WorkItem> queue = new ConcurrentQueue<WorkItem>();
        private static readonly List<Action> everyFrame = new List<Action>();
        private static int mainThreadId = -1;
        private static Pump pump;

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
                throw new TimeoutException("Main thread did not process the request within " + timeoutMs + " ms (is the game frozen or a modal dialog blocking?)");
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
        public static void Post(Action work)
        {
            queue.Enqueue(new WorkItem { Work = () => { work(); return null; } });
        }

        private sealed class Pump : MonoBehaviour
        {
            private readonly Stopwatch sw = new Stopwatch();

            private void Update()
            {
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
                    try { item.Result = item.Work(); }
                    catch (Exception e) { item.Error = e; }
                    finally { item.Done.Set(); }
                    if (sw.Elapsed.TotalMilliseconds > FrameBudgetMs) break;
                }
            }

            private void OnGUI()
            {
                try { TwitchChatHUD.OnGUI(); }
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
