// Log, uložené volby a ikona do oznamovací oblasti.

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using Microsoft.Win32;

namespace MojeTapeta
{
    /// <summary>Aplikace nemá vlastní okno, co se děje, zapisuje do %TEMP%\moje-tapeta.log.</summary>
    static class Log
    {
        static readonly object gate = new object();
        public static readonly string FilePath = Path.Combine(Path.GetTempPath(), "moje-tapeta.log");

        public static void Write(string text)
        {
            lock (gate)
            {
                try
                {
                    var info = new FileInfo(FilePath);
                    if (info.Exists && info.Length > 1024 * 1024) info.Delete();
                    File.AppendAllText(FilePath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + text + Environment.NewLine);
                }
                catch (Exception)
                {
                    // Bez logu se dá žít.
                }
            }
        }
    }

    /// <summary>Volby, které přežijí restart: vybraná scéna a pauza (HKCU\Software\MojeTapeta).</summary>
    static class Settings
    {
        const string KeyPath = @"Software\MojeTapeta";

        public static string Scene
        {
            get { return Read("Scena") as string; }
            set { Write("Scena", value, RegistryValueKind.String); }
        }

        /// <summary>null, dokud o pauze nikdo nerozhodl.</summary>
        public static bool? Paused
        {
            get
            {
                object value = Read("Pozastaveno");
                if (value is int) return (int)value != 0;
                return null;
            }
            set { Write("Pozastaveno", value.HasValue && value.Value ? 1 : 0, RegistryValueKind.DWord); }
        }

        static object Read(string name)
        {
            using (var key = Registry.CurrentUser.OpenSubKey(KeyPath))
            {
                return key == null ? null : key.GetValue(name);
            }
        }

        static void Write(string name, object value, RegistryValueKind kind)
        {
            using (var key = Registry.CurrentUser.CreateSubKey(KeyPath))
            {
                key.SetValue(name, value, kind);
            }
        }
    }

    /// <summary>Ikona „sparkles“: tři čtyřcípé hvězdičky, kreslené podle barvy hlavního panelu.</summary>
    static class Sparkles
    {
        public static Icon Create(int size)
        {
            bool light = false;
            using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
            {
                if (key != null)
                {
                    object value = key.GetValue("SystemUsesLightTheme");
                    light = value is int && (int)value != 0;
                }
            }
            Color color = light ? Color.FromArgb(28, 28, 32) : Color.FromArgb(245, 245, 250);
            using (var bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(bitmap))
                using (var brush = new SolidBrush(color))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.Clear(Color.Transparent);
                    float s = size;
                    Star(g, brush, s * 0.40f, s * 0.60f, s * 0.38f);
                    Star(g, brush, s * 0.77f, s * 0.22f, s * 0.20f);
                    Star(g, brush, s * 0.80f, s * 0.80f, s * 0.13f);
                }
                IntPtr handle = bitmap.GetHicon();
                try
                {
                    using (var borrowed = Icon.FromHandle(handle))
                    {
                        return (Icon)borrowed.Clone();
                    }
                }
                finally
                {
                    Native.DestroyIcon(handle);
                }
            }
        }

        static void Star(Graphics g, Brush brush, float cx, float cy, float r)
        {
            float k = r * 0.16f;
            var top = new PointF(cx, cy - r);
            var right = new PointF(cx + r, cy);
            var bottom = new PointF(cx, cy + r);
            var left = new PointF(cx - r, cy);
            using (var path = new GraphicsPath())
            {
                path.AddBezier(top, new PointF(cx + k, cy - k), new PointF(cx + k, cy - k), right);
                path.AddBezier(right, new PointF(cx + k, cy + k), new PointF(cx + k, cy + k), bottom);
                path.AddBezier(bottom, new PointF(cx - k, cy + k), new PointF(cx - k, cy + k), left);
                path.AddBezier(left, new PointF(cx - k, cy - k), new PointF(cx - k, cy - k), top);
                path.CloseFigure();
                g.FillPath(brush, path);
            }
        }
    }
}
