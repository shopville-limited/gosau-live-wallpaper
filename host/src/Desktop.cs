// Umístění okna mezi obrázek plochy a ikony.
//
// Průzkumník na zprávu 0x052C poslanou oknu Progman vytvoří okno WorkerW, které kreslí
// obrázek plochy odděleně od vrstvy s ikonami (SHELLDLL_DefView). Tapeta se vloží mezi ně:
//  - do Windows 11 23H2 je WorkerW samostatné okno za oknem s ikonami a tapeta je jeho dítě;
//  - od Windows 11 24H2 jsou WorkerW i ikony dětmi Progman a tapeta se zařadí mezi ně.

using System;
using System.Drawing;

namespace MojeTapeta
{
    sealed class Desktop
    {
        public IntPtr Parent { get; private set; }
        public IntPtr Icons { get; private set; }
        public IntPtr Picture { get; private set; }
        public bool Raised { get; private set; }

        public static Desktop Find()
        {
            IntPtr progman = Native.FindWindow("Progman", null);
            if (progman == IntPtr.Zero) return null;
            IntPtr ignored;
            Native.SendMessageTimeout(progman, 0x052C, new IntPtr(0xD), new IntPtr(0x1), Native.SMTO_NORMAL, 1000, out ignored);
            Native.SendMessageTimeout(progman, 0x052C, IntPtr.Zero, IntPtr.Zero, Native.SMTO_NORMAL, 1000, out ignored);

            // Windows 11 24H2 a novější.
            IntPtr icons = Native.FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
            IntPtr picture = Native.FindWindowEx(progman, IntPtr.Zero, "WorkerW", null);
            if (icons != IntPtr.Zero && picture != IntPtr.Zero)
            {
                var raised = new Desktop();
                raised.Parent = progman;
                raised.Icons = icons;
                raised.Picture = picture;
                raised.Raised = true;
                return raised;
            }

            // Starší: WorkerW hned za oknem, které drží ikony.
            IntPtr worker = IntPtr.Zero;
            IntPtr iconHost = IntPtr.Zero;
            Native.EnumWindows(delegate (IntPtr top, IntPtr unused)
            {
                IntPtr shell = Native.FindWindowEx(top, IntPtr.Zero, "SHELLDLL_DefView", null);
                if (shell != IntPtr.Zero)
                {
                    iconHost = shell;
                    worker = Native.FindWindowEx(IntPtr.Zero, top, "WorkerW", null);
                }
                return true;
            }, IntPtr.Zero);
            if (worker == IntPtr.Zero) return null;
            var classic = new Desktop();
            classic.Parent = worker;
            classic.Icons = iconHost;
            classic.Picture = worker;
            classic.Raised = false;
            return classic;
        }

        public bool Alive
        {
            get { return Native.IsWindow(Parent) && Native.IsWindow(Picture); }
        }

        /// <summary>Vloží okno na plochu. bounds jsou souřadnice obrazovky v pixelech.</summary>
        public void Attach(IntPtr window, Rectangle bounds)
        {
            long style = Native.Style(window, Native.GWL_STYLE);
            style &= ~(Native.WS_POPUP | Native.WS_CAPTION | Native.WS_THICKFRAME);
            style |= Native.WS_CHILD;
            Native.SetStyle(window, Native.GWL_STYLE, style);
            if (Raised)
            {
                // Progman kreslí přes DirectComposition, dítě musí být vrstvené okno.
                long ex = Native.Style(window, Native.GWL_EXSTYLE);
                Native.SetStyle(window, Native.GWL_EXSTYLE, ex | Native.WS_EX_LAYERED);
                Native.SetLayeredWindowAttributes(window, 0, 255, Native.LWA_ALPHA);
            }
            Native.SetParent(window, Parent);

            Native.RECT origin;
            Native.GetWindowRect(Parent, out origin);
            int x = bounds.X - origin.Left;
            int y = bounds.Y - origin.Top;
            if (Raised)
            {
                // Pod ikony, nad obrázek plochy.
                Native.SetWindowPos(window, Icons, x, y, bounds.Width, bounds.Height,
                    Native.SWP_NOACTIVATE | Native.SWP_SHOWWINDOW | Native.SWP_FRAMECHANGED);
                Native.SetWindowPos(Picture, Native.HWND_BOTTOM, 0, 0, 0, 0,
                    Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
            }
            else
            {
                Native.SetWindowPos(window, IntPtr.Zero, x, y, bounds.Width, bounds.Height,
                    Native.SWP_NOZORDER | Native.SWP_NOACTIVATE | Native.SWP_SHOWWINDOW | Native.SWP_FRAMECHANGED);
            }
        }

        /// <summary>Po odchodu tapety ať plocha znovu nakreslí svůj obrázek.</summary>
        public void Repaint()
        {
            uint flags = Native.RDW_INVALIDATE | Native.RDW_ERASE | Native.RDW_ALLCHILDREN | Native.RDW_UPDATENOW | Native.RDW_FRAME;
            if (Native.IsWindow(Picture)) Native.RedrawWindow(Picture, IntPtr.Zero, IntPtr.Zero, flags);
            if (Native.IsWindow(Parent)) Native.RedrawWindow(Parent, IntPtr.Zero, IntPtr.Zero, flags);
        }
    }
}
