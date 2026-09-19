using System;
using System.Collections;
using System.Threading;
using UnityEngine;
using Verse;

namespace RimWorldAIBridge
{
    /// <summary>Captures the rendered frame as PNG (optionally downscaled) for multimodal agents.</summary>
    public static class Screenshot
    {
        private sealed class Runner : MonoBehaviour { }
        private static Runner runner;

        public static byte[] Capture(int maxWidth, int timeoutMs = 10000)
        {
            byte[] result = null;
            Exception error = null;
            var done = new ManualResetEventSlim(false);
            MainThread.Run(() =>
            {
                if (runner == null)
                {
                    var go = new GameObject("RimWorldAIBridge.Screenshot");
                    UnityEngine.Object.DontDestroyOnLoad(go);
                    runner = go.AddComponent<Runner>();
                }
                runner.StartCoroutine(CaptureCo(maxWidth, (bytes, err) => { result = bytes; error = err; done.Set(); }));
            });
            if (!done.Wait(timeoutMs)) throw new BridgeException("Screenshot timed out (game not rendering? minimised windows do not render).", 504);
            if (error != null) throw new BridgeException("Screenshot failed: " + error.Message, 500);
            return result;
        }

        private static IEnumerator CaptureCo(int maxWidth, Action<byte[], Exception> cb)
        {
            yield return new WaitForEndOfFrame();
            Texture2D tex = null, small = null;
            RenderTexture rt = null;
            try
            {
                tex = ScreenCapture.CaptureScreenshotAsTexture();
                Texture2D src = tex;
                if (maxWidth > 0 && tex.width > maxWidth)
                {
                    int w = maxWidth;
                    int h = Mathf.RoundToInt(tex.height * (maxWidth / (float)tex.width));
                    rt = RenderTexture.GetTemporary(w, h, 0, RenderTextureFormat.ARGB32);
                    Graphics.Blit(tex, rt);
                    var prev = RenderTexture.active;
                    RenderTexture.active = rt;
                    small = new Texture2D(w, h, TextureFormat.RGB24, false);
                    small.ReadPixels(new Rect(0, 0, w, h), 0, 0);
                    small.Apply();
                    RenderTexture.active = prev;
                    src = small;
                }
                cb(src.EncodeToPNG(), null);
            }
            catch (Exception e) { cb(null, e); }
            finally
            {
                if (rt != null) RenderTexture.ReleaseTemporary(rt);
                if (tex != null) UnityEngine.Object.Destroy(tex);
                if (small != null) UnityEngine.Object.Destroy(small);
            }
        }
    }
}
