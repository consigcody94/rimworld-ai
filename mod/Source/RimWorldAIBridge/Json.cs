using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace RimWorldAIBridge
{
    /// <summary>
    /// Minimal dependency-free JSON writer/parser. RimWorld ships no Newtonsoft, and
    /// Unity's JsonUtility cannot handle dictionaries, so this covers what the bridge needs:
    /// null, bool, numbers, strings, IDictionary (string keys), IEnumerable.
    /// Parsed values come back as Dictionary&lt;string, object&gt;, List&lt;object&gt;, string, double, long, bool, null.
    /// </summary>
    public static class Json
    {
        // ------------------------------------------------------------------ write

        public static string Serialize(object value, bool pretty = false)
        {
            var sb = new StringBuilder(1024);
            Write(sb, value, pretty, 0);
            return sb.ToString();
        }

        private static void Write(StringBuilder sb, object value, bool pretty, int depth)
        {
            if (value == null) { sb.Append("null"); return; }
            switch (value)
            {
                case string s: WriteString(sb, s); return;
                case bool b: sb.Append(b ? "true" : "false"); return;
                case int i: sb.Append(i.ToString(CultureInfo.InvariantCulture)); return;
                case long l: sb.Append(l.ToString(CultureInfo.InvariantCulture)); return;
                case float f: WriteFloat(sb, f); return;
                case double d: WriteFloat(sb, d); return;
                case decimal m: sb.Append(m.ToString(CultureInfo.InvariantCulture)); return;
                case short sh: sb.Append(sh.ToString(CultureInfo.InvariantCulture)); return;
                case byte by: sb.Append(by.ToString(CultureInfo.InvariantCulture)); return;
                case uint ui: sb.Append(ui.ToString(CultureInfo.InvariantCulture)); return;
                case ulong ul: sb.Append(ul.ToString(CultureInfo.InvariantCulture)); return;
                case Enum e: WriteString(sb, e.ToString()); return;
                case IDictionary dict: WriteDict(sb, dict, pretty, depth); return;
                case IEnumerable list: WriteList(sb, list, pretty, depth); return;
                default: WriteString(sb, value.ToString()); return;
            }
        }

        private static void WriteFloat(StringBuilder sb, double d)
        {
            if (double.IsNaN(d) || double.IsInfinity(d)) { sb.Append("null"); return; }
            // Round to 3 decimals: game floats are noisy and tokens are expensive.
            double r = Math.Round(d, 3);
            if (r == Math.Floor(r) && Math.Abs(r) < 1e15) sb.Append(((long)r).ToString(CultureInfo.InvariantCulture));
            else sb.Append(r.ToString("0.###", CultureInfo.InvariantCulture));
        }

        private static void WriteDict(StringBuilder sb, IDictionary dict, bool pretty, int depth)
        {
            sb.Append('{');
            bool first = true;
            foreach (DictionaryEntry kv in dict)
            {
                if (!first) sb.Append(',');
                first = false;
                if (pretty) Indent(sb, depth + 1);
                WriteString(sb, kv.Key?.ToString() ?? "null");
                sb.Append(pretty ? ": " : ":");
                Write(sb, kv.Value, pretty, depth + 1);
            }
            if (pretty && !first) Indent(sb, depth);
            sb.Append('}');
        }

        private static void WriteList(StringBuilder sb, IEnumerable list, bool pretty, int depth)
        {
            sb.Append('[');
            bool first = true;
            foreach (object item in list)
            {
                if (!first) sb.Append(',');
                first = false;
                if (pretty) Indent(sb, depth + 1);
                Write(sb, item, pretty, depth + 1);
            }
            if (pretty && !first) Indent(sb, depth);
            sb.Append(']');
        }

        private static void Indent(StringBuilder sb, int depth)
        {
            sb.Append('\n');
            for (int i = 0; i < depth; i++) sb.Append("  ");
        }

        private static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        // ------------------------------------------------------------------ read

        public static object Deserialize(string json)
        {
            if (string.IsNullOrEmpty(json)) return null;
            var p = new Parser(json);
            p.SkipWs();
            object v = p.ReadValue();
            p.SkipWs();
            if (!p.End) throw new FormatException("Trailing characters at " + p.Pos);
            return v;
        }

        public static Dictionary<string, object> DeserializeObject(string json)
        {
            return Deserialize(json) as Dictionary<string, object> ?? new Dictionary<string, object>();
        }

        private sealed class Parser
        {
            private readonly string s;
            public int Pos;
            public Parser(string s) { this.s = s; }
            public bool End => Pos >= s.Length;

            public void SkipWs()
            {
                while (Pos < s.Length && char.IsWhiteSpace(s[Pos])) Pos++;
            }

            private int depth;
            private const int MaxDepth = 64;

            public object ReadValue()
            {
                SkipWs();
                if (End) throw new FormatException("Unexpected end of JSON");
                char c = s[Pos];
                if (c == '{' || c == '[')
                {
                    // A stack overflow cannot be caught in .NET; it takes the whole game down.
                    // Bound the nesting instead and fail the request cleanly.
                    if (++depth > MaxDepth) throw new FormatException("JSON nested deeper than " + MaxDepth + " levels");
                    try { return c == '{' ? ReadObject() : (object)ReadArray(); }
                    finally { depth--; }
                }
                if (c == '"') return ReadString();
                if (c == 't') { Expect("true"); return true; }
                if (c == 'f') { Expect("false"); return false; }
                if (c == 'n') { Expect("null"); return null; }
                return ReadNumber();
            }

            private void Expect(string word)
            {
                if (string.CompareOrdinal(s, Pos, word, 0, word.Length) != 0)
                    throw new FormatException("Expected " + word + " at " + Pos);
                Pos += word.Length;
            }

            private Dictionary<string, object> ReadObject()
            {
                var d = new Dictionary<string, object>();
                Pos++; // {
                SkipWs();
                if (Peek() == '}') { Pos++; return d; }
                while (true)
                {
                    SkipWs();
                    if (Peek() != '"') throw new FormatException("Expected string key at " + Pos);
                    string key = ReadString();
                    SkipWs();
                    if (Peek() != ':') throw new FormatException("Expected ':' at " + Pos);
                    Pos++;
                    d[key] = ReadValue();
                    SkipWs();
                    char c = Peek();
                    if (c == ',') { Pos++; continue; }
                    if (c == '}') { Pos++; return d; }
                    throw new FormatException("Expected ',' or '}' at " + Pos);
                }
            }

            private List<object> ReadArray()
            {
                var l = new List<object>();
                Pos++; // [
                SkipWs();
                if (Peek() == ']') { Pos++; return l; }
                while (true)
                {
                    l.Add(ReadValue());
                    SkipWs();
                    char c = Peek();
                    if (c == ',') { Pos++; continue; }
                    if (c == ']') { Pos++; return l; }
                    throw new FormatException("Expected ',' or ']' at " + Pos);
                }
            }

            private string ReadString()
            {
                var sb = new StringBuilder();
                Pos++; // opening quote
                while (true)
                {
                    if (End) throw new FormatException("Unterminated string");
                    char c = s[Pos++];
                    if (c == '"') return sb.ToString();
                    if (c != '\\') { sb.Append(c); continue; }
                    if (End) throw new FormatException("Unterminated escape");
                    char e = s[Pos++];
                    switch (e)
                    {
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case '/': sb.Append('/'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            if (Pos + 4 > s.Length) throw new FormatException("Bad \\u escape");
                            sb.Append((char)Convert.ToInt32(s.Substring(Pos, 4), 16));
                            Pos += 4;
                            break;
                        default: throw new FormatException("Bad escape \\" + e);
                    }
                }
            }

            private object ReadNumber()
            {
                int start = Pos;
                while (!End && "+-0123456789.eE".IndexOf(s[Pos]) >= 0) Pos++;
                string tok = s.Substring(start, Pos - start);
                if (tok.Length == 0) throw new FormatException("Unexpected character '" + s[start] + "' at " + start);
                if (tok.IndexOfAny(new[] { '.', 'e', 'E' }) < 0 && long.TryParse(tok, NumberStyles.Integer, CultureInfo.InvariantCulture, out long l)) return l;
                if (double.TryParse(tok, NumberStyles.Float, CultureInfo.InvariantCulture, out double d)) return d;
                throw new FormatException("Bad number '" + tok + "' at " + start);
            }

            private char Peek() => End ? '\0' : s[Pos];
        }

        // ------------------------------------------------------------------ helpers for request bodies

        public static string Str(Dictionary<string, object> d, string key, string def = null)
        {
            if (d != null && d.TryGetValue(key, out object v) && v != null) return v.ToString();
            return def;
        }

        public static int Int(Dictionary<string, object> d, string key, int def = 0)
        {
            if (d == null || !d.TryGetValue(key, out object v) || v == null) return def;
            switch (v)
            {
                case long l: return (int)l;
                case double db: return (int)Math.Round(db);
                case int i: return i;
                case string s when int.TryParse(s, out int r): return r;
                default: return def;
            }
        }

        public static float Float(Dictionary<string, object> d, string key, float def = 0f)
        {
            if (d == null || !d.TryGetValue(key, out object v) || v == null) return def;
            switch (v)
            {
                case long l: return l;
                case double db: return (float)db;
                case int i: return i;
                case string s when float.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out float r): return r;
                default: return def;
            }
        }

        public static bool Bool(Dictionary<string, object> d, string key, bool def = false)
        {
            if (d == null || !d.TryGetValue(key, out object v) || v == null) return def;
            switch (v)
            {
                case bool b: return b;
                case long l: return l != 0;
                case string s: return s == "true" || s == "1" || s == "yes";
                default: return def;
            }
        }

        public static bool Has(Dictionary<string, object> d, string key) => d != null && d.ContainsKey(key) && d[key] != null;

        public static List<object> List(Dictionary<string, object> d, string key)
        {
            if (d != null && d.TryGetValue(key, out object v) && v is List<object> l) return l;
            return null;
        }

        public static Dictionary<string, object> Obj(Dictionary<string, object> d, string key)
        {
            if (d != null && d.TryGetValue(key, out object v) && v is Dictionary<string, object> o) return o;
            return null;
        }
    }
}
