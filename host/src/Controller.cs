// Řídí celou tapetu: okna na monitorech, menu v oznamovací oblasti, šetření energií,
// kurzor a příkazy zvenčí (--snapshot, --reload, --quit).

using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace MojeTapeta
{
    sealed class Controller
    {
        readonly string root;
        readonly string bridge;
        readonly SynchronizationContext ui;
        List<Scene> scenes = new List<Scene>();
        Scene scene;
        readonly List<WallpaperWindow> screens = new List<WallpaperWindow>();
        List<Rectangle> layout = new List<Rectangle>();
        CoreWebView2Environment environment;
        Desktop desktop;
        MessageWindow messages;
        NotifyIcon tray;
        ContextMenuStrip menu;
        readonly System.Windows.Forms.Timer pointerTimer = new System.Windows.Forms.Timer();
        readonly System.Windows.Forms.Timer exposureTimer = new System.Windows.Forms.Timer();
        int pointerRate;
        int applied;
        int full = 60;
        Point lastPoint = new Point(int.MinValue, int.MinValue);
        bool building;
        bool capturing;   // pořizuje se snímek: tapeta kreslí i zakrytá
        bool rebuildAgain;

        // Proč tapeta stojí.
        bool displayOn = true;
        bool locked;
        bool energySaver;
        bool batterySaver;
        /// <summary>Volba přežije restart. Dokud nikdo nerozhodl, řídí start „Efekty animace“ ve Windows.</summary>
        bool stopped;

        public Controller(string root)
        {
            this.root = root;
            ui = SynchronizationContext.Current;
            bridge = File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "bridge.js"));
            bool? paused = Settings.Paused;
            stopped = paused.HasValue ? paused.Value : ReduceMotion;
            pointerTimer.Tick += delegate { TrackPointer(); };
            exposureTimer.Interval = 1000;
            exposureTimer.Tick += delegate { ApplyRate(); };
        }

        bool LowPower
        {
            get { return energySaver || batterySaver; }
        }

        bool Awake
        {
            get { return displayOn && !locked; }
        }

        /// <summary>„Efekty animace“ vypnuté v nastavení Windows = uživatel chce méně pohybu.</summary>
        static bool ReduceMotion
        {
            get
            {
                bool animations = true;
                Native.SystemParametersInfo(Native.SPI_GETCLIENTAREAANIMATION, 0, ref animations, 0);
                return !animations;
            }
        }

        static bool OnBattery
        {
            get { return SystemInformation.PowerStatus.PowerLineStatus == PowerLineStatus.Offline; }
        }

        public async Task Start()
        {
            Log.Write("Moje tapeta startuje, scény ze složky " + root);
            scenes = Scene.Discover(root);
            if (scenes.Count == 0)
            {
                MessageBox.Show("Ve složce " + Path.Combine(root, "scenes") + " není žádná scéna.", "Moje tapeta",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                Application.Exit();
                return;
            }
            string chosen = Settings.Scene;
            scene = scenes.FirstOrDefault(s => s.Name == chosen) ?? scenes[0];

            try
            {
                var options = new CoreWebView2EnvironmentOptions(
                    // Větší mezipaměť přeložených shaderů: scéna má velké programy a s výchozí
                    // velikostí se při každém spuštění překládaly znovu (desítky sekund).
                    "--gpu-program-cache-size-kb=131072 --gpu-disk-cache-size-kb=262144 " +
                    "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling --disable-background-timer-throttling " +
                    "--disable-backgrounding-occluded-windows --disable-renderer-backgrounding");
                string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MojeTapeta", "WebView2");
                environment = await CoreWebView2Environment.CreateAsync(null, data, options);
            }
            catch (WebView2RuntimeNotFoundException)
            {
                MessageBox.Show("Chybí Microsoft Edge WebView2 Runtime. Stáhněte ho z https://go.microsoft.com/fwlink/p/?LinkId=2124703",
                    "Moje tapeta", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Application.Exit();
                return;
            }

            messages = new MessageWindow(this);
            AddMenu();
            SystemEvents.DisplaySettingsChanged += delegate { Post(ScreensChanged); };
            SystemEvents.PowerModeChanged += delegate { Post(ApplyRate); };
            SystemEvents.SessionSwitch += delegate (object sender, SessionSwitchEventArgs e)
            {
                if (e.Reason == SessionSwitchReason.SessionLock) locked = true;
                else if (e.Reason == SessionSwitchReason.SessionUnlock) locked = false;
                else return;
                Post(ApplyRate);
            };
            // Vypnutí „Efektů animace“ během běhu zastaví scénu ze stejného důvodu, z jakého
            // pod nimi startuje zastavená, pokud o pauze už někdo nerozhodl sám.
            SystemEvents.UserPreferenceChanged += delegate
            {
                Post(delegate
                {
                    if (Settings.Paused.HasValue) return;
                    bool wanted = ReduceMotion;
                    if (wanted == stopped) return;
                    stopped = wanted;
                    ApplyRate();
                });
            };
            ListenForCommands();
            await Build();
        }

        void Post(Action action)
        {
            ui.Post(delegate { action(); }, null);
        }

        // ---- Okna na monitorech ----

        static List<Rectangle> CurrentLayout()
        {
            // Hlavní monitor první, pak zleva doprava. Pořadí určuje ?screen=N.
            return Screen.AllScreens
                .OrderByDescending(s => s.Primary)
                .ThenBy(s => s.Bounds.X)
                .ThenBy(s => s.Bounds.Y)
                .Select(s => s.Bounds)
                .ToList();
        }

        void ScreensChanged()
        {
            if (CurrentLayout().SequenceEqual(layout) && desktop != null && desktop.Alive) return;
            var ignored = Build();
        }

        /// <summary>Průzkumník se restartoval: plocha je nová, okna je třeba vložit znovu.</summary>
        public void DesktopRecreated()
        {
            Log.Write("Plocha byla vytvořena znovu, vkládám tapetu znovu.");
            var ignored = Build();
        }

        async Task Build()
        {
            if (building)
            {
                rebuildAgain = true;
                return;
            }
            building = true;
            try
            {
                do
                {
                    rebuildAgain = false;
                    await BuildOnce();
                } while (rebuildAgain);
            }
            finally
            {
                building = false;
            }
        }

        async Task BuildOnce()
        {
            CloseScreens();
            layout = CurrentLayout();
            desktop = Desktop.Find();
            if (desktop == null)
            {
                Log.Write("Plocha nenalezena, zkusím to znovu za 3 sekundy.");
                await Task.Delay(3000);
                rebuildAgain = true;
                return;
            }
            Log.Write("Plocha: " + (desktop.Raised ? "Windows 11 24H2+ (Progman)" : "WorkerW") + ", monitorů: " + layout.Count);
            var started = new List<Task>();
            for (int i = 0; i < layout.Count; i++)
            {
                var window = new WallpaperWindow(i, layout[i], scene, root, bridge);
                IntPtr handle = window.Handle;   // vytvoří okno, zatím neviditelné
                desktop.Attach(handle, layout[i]);
                window.Show();
                window.Loaded += delegate { ApplyRate(); };
                screens.Add(window);
                started.Add(window.Start(environment));
            }
            try
            {
                await Task.WhenAll(started);
            }
            catch (Exception error)
            {
                Log.Write("Scénu nejde spustit: " + error);
            }
            ApplyRate();
            UpdateTooltip();
        }

        void CloseScreens()
        {
            foreach (var window in screens)
            {
                window.Close();
                window.Dispose();
            }
            screens.Clear();
            if (desktop != null) desktop.Repaint();
        }

        // ---- Šetření energií ----

        /// <summary>
        /// Naplno, když je tapeta vidět; pomalu, když ji okna z větší části zakrývají;
        /// vůbec, když je zakrytá celá, obrazovka je vypnutá, zamčená nebo běží úsporný režim.
        /// </summary>
        public void ApplyRate()
        {
            bool battery = OnBattery;
            // Krajina se hýbe pomalu: 30 snímků stačí, grafika zůstává pro hry a práci.
            full = battery ? 20 : 30;
            string game;
            int level = GameLevel(out game);
            bool gaming = level == 2;
            bool still = (stopped || LowPower || !Awake || gaming) && !capturing;
            // Okno bez rámečku přes celý monitor (hra v okně, video): ostatní monitory jen zpomalí.
            if (level == 1 && !capturing) full = 10;
            if (level != wasLevel)
            {
                wasLevel = level;
                Log.Write(level == 2 ? "Běží hra (" + game + "): tapeta stojí na všech monitorech."
                    : level == 1 ? "Okno přes celý monitor (" + game + "): tapeta jinde zpomalí na 10 snímků."
                    : "Hra nebo okno přes celý monitor skončilo: tapeta běží normálně.");
            }
            List<Rectangle> blockers = still ? new List<Rectangle>() : WindowBlockers();
            applied = 0;
            bool changed = false;
            for (int i = 0; i < screens.Count; i++)
            {
                double showing = i < layout.Count ? Exposure(layout[i], blockers) : 1;
                int rate = full;
                if (capturing) rate = full;
                else if (still || showing < 0.15) rate = 0;
                else if (showing < 0.4) rate = 20;
                screens[i].SetPower(battery);
                if (screens[i].SetRate(rate)) changed = true;
                applied = Math.Max(applied, rate);
            }
            if (changed)
            {
                lastPoint = new Point(int.MinValue, int.MinValue);
                Log.Write("Snímková frekvence: " + applied);
            }
            // Při hře se dál jednou za sekundu kontroluje, jestli už skončila.
            UpdateTimers(!still || gaming);
        }

        int wasLevel;

        /// <summary>
        /// Běží hra nebo jiná aplikace přes celou obrazovku (na kterémkoli monitoru)? Pak tapeta
        /// stojí všude, ať grafická karta patří hře. Pozná exkluzivní režim Direct3D, prezentační
        /// režim i hru v okně bez rámečku přes celý monitor.
        /// </summary>
        /// <returns>2 = hra v exkluzivním režimu nebo prezentace (tapeta stojí všude),
        /// 1 = okno bez rámečku přes celý monitor (jinde jen zpomalí), 0 = nic.</returns>
        static int GameLevel(out string what)
        {
            what = "";
            int state;
            // Jen jisté stavy: 3 = Direct3D přes celou obrazovku, 4 = prezentační režim.
            // Stav 2 (QUNS_BUSY) Windows hlásí i u běžných aplikací, proto se nepoužívá.
            if (Native.SHQueryUserNotificationState(out state) == 0 && (state == 3 || state == 4))
            {
                what = state == 3 ? "Direct3D přes celou obrazovku" : "prezentační režim";
                return 2;
            }
            return BorderlessFullscreen(out what) ? 1 : 0;
        }

        static bool BorderlessFullscreen(out string what)
        {
            what = "";
            IntPtr hwnd = Native.GetForegroundWindow();
            if (hwnd == IntPtr.Zero || !Native.IsWindowVisible(hwnd) || Native.IsIconic(hwnd)) return false;
            if (ShellClasses.Contains(Native.ClassOf(hwnd))) return false;
            uint owner;
            Native.GetWindowThreadProcessId(hwnd, out owner);
            if (owner == (uint)System.Diagnostics.Process.GetCurrentProcess().Id) return false;
            // Maximalizované okno má rámeček a lištu; okno bez rámečku přes celý monitor je hra nebo video.
            long style = Native.Style(hwnd, -16);
            const long WS_CAPTION = 0x00C00000L;
            if ((style & WS_CAPTION) == WS_CAPTION) return false;
            Native.RECT r;
            if (!Native.GetWindowRect(hwnd, out r)) return false;
            var rect = Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
            foreach (Screen screen in Screen.AllScreens)
            {
                if (!rect.Contains(screen.Bounds)) continue;
                try { what = System.Diagnostics.Process.GetProcessById((int)owner).ProcessName + ", okno bez rámečku"; }
                catch (ArgumentException) { what = "okno bez rámečku"; }
                return true;
            }
            return false;
        }

        void UpdateTimers(bool pollExposure)
        {
            // Kurzor není třeba číst rychleji než animaci, ani budit zastavenou tapetu.
            int wanted = Math.Min(30, applied);
            if (wanted != pointerRate)
            {
                pointerRate = wanted;
                pointerTimer.Stop();
                if (wanted > 0)
                {
                    pointerTimer.Interval = Math.Max(10, 1000 / wanted);
                    pointerTimer.Start();
                }
            }
            // I zakrytá tapeta se jednou za sekundu podívá, jestli ji někdo neodkryl.
            if (pollExposure)
            {
                if (!exposureTimer.Enabled) exposureTimer.Start();
            }
            else
            {
                exposureTimer.Stop();
            }
        }

        static readonly HashSet<string> ShellClasses = new HashSet<string>
        {
            "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "NotifyIconOverflowWindow",
            "Windows.UI.Core.CoreWindow", "XamlExplorerHostIslandWindow", "TopLevelWindowForOverflowXamlIsland",
        };

        /// <summary>Obdélníky běžných oken, která tapetu zakrývají.</summary>
        static List<Rectangle> WindowBlockers()
        {
            var list = new List<Rectangle>();
            uint me = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
            Native.EnumWindows(delegate (IntPtr hwnd, IntPtr unused)
            {
                if (!Native.IsWindowVisible(hwnd) || Native.IsIconic(hwnd)) return true;
                uint owner;
                Native.GetWindowThreadProcessId(hwnd, out owner);
                if (owner == me) return true;
                int cloaked;
                if (Native.DwmGetWindowAttribute(hwnd, Native.DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return true;
                long ex = Native.Style(hwnd, Native.GWL_EXSTYLE);
                if ((ex & Native.WS_EX_TRANSPARENT) != 0) return true;
                if ((ex & Native.WS_EX_TOOLWINDOW) != 0 && (ex & Native.WS_EX_APPWINDOW) == 0) return true;
                if ((ex & Native.WS_EX_LAYERED) != 0)
                {
                    // Průhledné vrstvy (překryvy, stíny) nic nezakrývají.
                    uint key, flags;
                    byte alpha;
                    if (!Native.GetLayeredWindowAttributes(hwnd, out key, out alpha, out flags)) return true;
                    if ((flags & Native.LWA_ALPHA) != 0 && alpha < 242) return true;
                }
                if (ShellClasses.Contains(Native.ClassOf(hwnd))) return true;
                Native.RECT r;
                if (Native.DwmGetWindowAttribute(hwnd, Native.DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(Native.RECT))) != 0)
                    Native.GetWindowRect(hwnd, out r);
                if (r.Right - r.Left < 4 || r.Bottom - r.Top < 4) return true;
                list.Add(Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom));
                return true;
            }, IntPtr.Zero);
            return list;
        }

        /// <summary>Jaká část obrazovky zůstává odkrytá, od 0 do 1.</summary>
        static double Exposure(Rectangle frame, List<Rectangle> blockers)
        {
            if (blockers.Count == 0) return 1;
            const int columns = 16, rows = 10;
            int free = 0;
            for (int c = 0; c < columns; c++)
            {
                for (int r = 0; r < rows; r++)
                {
                    int x = frame.X + (int)(frame.Width * (c + 0.5) / columns);
                    int y = frame.Y + (int)(frame.Height * (r + 0.5) / rows);
                    bool covered = false;
                    foreach (var b in blockers)
                    {
                        if (b.Contains(x, y))
                        {
                            covered = true;
                            break;
                        }
                    }
                    if (!covered) free++;
                }
            }
            return free / (double)(columns * rows);
        }

        public void PowerSetting(Guid setting, uint value)
        {
            if (setting == Native.GUID_CONSOLE_DISPLAY_STATE) displayOn = value != 0;   // 0 vypnuto, 1 zapnuto, 2 ztlumeno
            else if (setting == Native.GUID_ENERGY_SAVER_STATUS) energySaver = value != 0;
            else if (setting == Native.GUID_POWER_SAVING_STATUS) batterySaver = value != 0;
            else return;
            ApplyRate();
        }

        // ---- Kurzor ----

        /// <summary>Kurzor patří Průzkumníkovi, poloha se proto čte, ne chytá.</summary>
        void TrackPointer()
        {
            Native.POINT p;
            if (!Native.GetCursorPos(out p)) return;
            if (p.X == lastPoint.X && p.Y == lastPoint.Y) return;
            lastPoint = new Point(p.X, p.Y);
            for (int i = 0; i < screens.Count && i < layout.Count; i++)
            {
                Rectangle frame = layout[i];
                if (frame.Contains(p.X, p.Y)) screens[i].SetPointer(new Point(p.X - frame.X, p.Y - frame.Y));
                else screens[i].SetPointer(null);
            }
        }

        // ---- Menu v oznamovací oblasti ----

        void AddMenu()
        {
            menu = new ContextMenuStrip();
            menu.ShowImageMargin = false;
            menu.Opening += delegate { FillMenu(); };
            tray = new NotifyIcon();
            tray.Icon = Sparkles.Create(Math.Max(16, SystemInformation.SmallIconSize.Width));
            tray.ContextMenuStrip = menu;
            tray.Visible = true;
            UpdateTooltip();
            FillMenu();
        }

        void UpdateTooltip()
        {
            if (tray != null) tray.Text = "Moje tapeta · " + (scene != null ? scene.Title : "");
        }

        string StateText()
        {
            if (LowPower) return "Stojí kvůli úspornému režimu";
            if (stopped)
            {
                if (!Settings.Paused.HasValue && ReduceMotion) return "Pozastaveno, Windows mají vypnuté efekty animace";
                return "Pozastaveno";
            }
            if (!displayOn) return "Stojí, obrazovka je vypnutá";
            if (locked) return "Stojí, počítač je zamčený";
            if (applied == 0) return "Odpočívá za okny";
            if (applied < full) return "Běží zpomaleně, plochu zakrývají okna";
            if (OnBattery) return "Běží, šetří baterii";
            return "Běží";
        }

        /// <summary>Menu se sestaví při každém otevření, ať říká, co tapeta dělá a proč.</summary>
        void FillMenu()
        {
            menu.Items.Clear();
            var state = new ToolStripMenuItem(StateText());
            state.Enabled = false;
            menu.Items.Add(state);
            menu.Items.Add(new ToolStripSeparator());

            var sceneMenu = new ToolStripMenuItem("Scéna");
            foreach (var choice in scenes)
            {
                var item = new ToolStripMenuItem(choice.Title);
                item.Checked = choice == scene;
                var picked = choice;
                item.Click += delegate { SelectScene(picked); };
                sceneMenu.DropDownItems.Add(item);
            }
            menu.Items.Add(sceneMenu);

            if (scene.Actions.Count > 0)
            {
                menu.Items.Add(new ToolStripSeparator());
                foreach (var action in scene.Actions)
                {
                    var item = new ToolStripMenuItem(action.Title);
                    // Akce, kterou by nikdo neviděl, by čekala a pak se ukázala naráz.
                    item.Enabled = applied > 0;
                    string id = action.Id;
                    item.Click += delegate { RunAction(id); };
                    menu.Items.Add(item);
                }
            }

            menu.Items.Add(new ToolStripSeparator());
            var pause = new ToolStripMenuItem(stopped ? "Pokračovat" : "Pozastavit");
            // V úsporném režimu by tlačítko nic neudělalo.
            pause.Enabled = !LowPower;
            pause.Click += delegate { TogglePause(); };
            menu.Items.Add(pause);
            var reload = new ToolStripMenuItem("Znovu načíst scénu");
            reload.Click += delegate { Reload(); };
            menu.Items.Add(reload);
            menu.Items.Add(new ToolStripSeparator());
            var quit = new ToolStripMenuItem("Ukončit");
            quit.Click += delegate { Quit(); };
            menu.Items.Add(quit);
        }

        /// <summary>Každý monitor má svůj vlastní svět, akce proto jde na všechny.</summary>
        public void RunAction(string id)
        {
            foreach (var window in screens) window.RunAction(id);
        }

        void SelectScene(Scene chosen)
        {
            if (chosen == scene) return;
            scene = chosen;
            Settings.Scene = chosen.Name;
            UpdateTooltip();
            var ignored = Build();
        }

        void TogglePause()
        {
            stopped = !stopped;
            Settings.Paused = stopped;
            ApplyRate();
        }

        /// <summary>Znovu načte scény ze složky a stránku na všech monitorech.</summary>
        public void Reload()
        {
            Log.Write("Znovu načítám scénu.");
            var found = Scene.Discover(root);
            if (found.Count == 0) return;
            scenes = found;
            var same = scenes.FirstOrDefault(s => s.Name == scene.Name);
            if (same == null)
            {
                scene = scenes[0];
                var ignored = Build();
                return;
            }
            scene = same;
            UpdateTooltip();
            // Po načtení stránka dostane rychlost znovu.
            foreach (var window in screens) window.Reload();
        }

        /// <summary>Na chvíli rozběhne všechny obrazovky a uloží, co ukazuje první.</summary>
        public void Snapshot()
        {
            if (screens.Count == 0) return;
            var first = screens[0];
            capturing = true;
            foreach (var window in screens) window.SetRate(60);
            var timer = new System.Windows.Forms.Timer();
            timer.Interval = 4000;
            timer.Tick += async delegate
            {
                timer.Stop();
                timer.Dispose();
                try
                {
                    await first.Probe();
                    // Časový limit: zaseknutý snímek nesmí nechat tapetu běžet naplno.
                    var capture = first.Snapshot(Path.Combine(Path.GetTempPath(), "moje-tapeta.png"));
                    if (await Task.WhenAny(capture, Task.Delay(10000)) != capture)
                        Log.Write("Snímek se nepovedl do 10 s.");
                }
                catch (Exception error)
                {
                    Log.Write("Snímek se nepovedl: " + error.Message);
                }
                capturing = false;
                ApplyRate();
            };
            timer.Start();
        }

        public void Quit()
        {
            pointerTimer.Stop();
            exposureTimer.Stop();
            if (tray != null)
            {
                tray.Visible = false;
                tray.Dispose();
            }
            CloseScreens();
            Log.Write("Moje tapeta končí.");
            Application.Exit();
        }

        // ---- Příkazy zvenčí: MojeTapeta.exe --snapshot | --reload | --quit ----

        void ListenForCommands()
        {
            var handles = new WaitHandle[]
            {
                Commands.Open(Commands.Snapshot),
                Commands.Open(Commands.Reload),
                Commands.Open(Commands.Quit),
            };
            var thread = new Thread(delegate ()
            {
                while (true)
                {
                    int which = WaitHandle.WaitAny(handles);
                    if (which == 0) Post(Snapshot);
                    else if (which == 1) Post(Reload);
                    else if (which == 2)
                    {
                        Post(Quit);
                        return;
                    }
                }
            });
            thread.IsBackground = true;
            thread.Start();
        }
    }

    /// <summary>Pojmenované události, kterými si instance předávají příkazy (obdoba kill -USR1).</summary>
    static class Commands
    {
        public const string Snapshot = "MojeTapeta.Snimek";
        public const string Reload = "MojeTapeta.Znovu";
        public const string Quit = "MojeTapeta.Konec";

        public static EventWaitHandle Open(string name)
        {
            return new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\" + name);
        }

        /// <summary>Pošle příkaz běžící instanci. Vrací false, když žádná neběží.</summary>
        public static bool Send(string name)
        {
            EventWaitHandle handle;
            if (!EventWaitHandle.TryOpenExisting(@"Local\" + name, out handle)) return false;
            using (handle) handle.Set();
            return true;
        }
    }

    /// <summary>Skryté okno pro zprávy o napájení a o restartu Průzkumníka.</summary>
    sealed class MessageWindow : NativeWindow
    {
        readonly Controller controller;
        readonly uint taskbarCreated;

        public MessageWindow(Controller controller)
        {
            this.controller = controller;
            CreateHandle(new CreateParams { Caption = "Moje tapeta" });
            taskbarCreated = Native.RegisterWindowMessage("TaskbarCreated");
            foreach (var setting in new[] { Native.GUID_CONSOLE_DISPLAY_STATE, Native.GUID_ENERGY_SAVER_STATUS, Native.GUID_POWER_SAVING_STATUS })
            {
                Guid copy = setting;
                Native.RegisterPowerSettingNotification(Handle, ref copy, 0);
            }
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Native.WM_POWERBROADCAST && m.WParam.ToInt64() == Native.PBT_POWERSETTINGCHANGE && m.LParam != IntPtr.Zero)
            {
                var setting = (Native.POWERBROADCAST_SETTING)Marshal.PtrToStructure(m.LParam, typeof(Native.POWERBROADCAST_SETTING));
                controller.PowerSetting(setting.PowerSetting, setting.Data);
                m.Result = new IntPtr(1);
                return;
            }
            if (taskbarCreated != 0 && m.Msg == (int)taskbarCreated) controller.DesktopRecreated();
            base.WndProc(ref m);
        }
    }
}
