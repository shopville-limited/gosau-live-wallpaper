// Jedna obrazovka tapety: okno bez rámečku s WebView2, které ukazuje scénu.
//
// Okno nikdy nebere myš. Kurzor se do scény dostane jinak: aplikace čte jeho polohu
// a posílá ji stránce jako pointermove, takže klikání na plochu dál patří Průzkumníkovi.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace MojeTapeta
{
    sealed class WallpaperWindow : Form
    {
        public const string HostName = "moje-tapeta.local";

        readonly WebView2 view;
        readonly int index;
        readonly Scene scene;
        readonly string root;
        readonly string bridge;
        bool loaded;
        bool inside;
        int rate = -1;
        bool battery;
        double pixelRatio = 1;
        int failures;

        /// <summary>Hlášení stránky (chyby, varování), pro log i pro test.</summary>
        public event Action<WallpaperWindow, string> Reported;
        public event Action<WallpaperWindow> Loaded;

        public int Index { get { return index; } }
        public int Rate { get { return Math.Max(0, rate); } }
        public bool IsLoaded { get { return loaded; } }
        public CoreWebView2 Core { get { return view.CoreWebView2; } }
        /// <summary>Parametry navíc do adresy scény (jen pro samotest).</summary>
        public string ExtraQuery;

        public WallpaperWindow(int index, Rectangle bounds, Scene scene, string root, string bridge)
        {
            this.index = index;
            this.scene = scene;
            this.root = root;
            this.bridge = bridge;
            AutoScaleMode = AutoScaleMode.None;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            Bounds = bounds;
            BackColor = scene.Background;
            Text = "Moje tapeta " + (index + 1);
            view = new WebView2();
            view.Dock = DockStyle.Fill;
            view.DefaultBackgroundColor = scene.Background;
            Controls.Add(view);
        }

        protected override CreateParams CreateParams
        {
            get
            {
                var parameters = base.CreateParams;
                parameters.ExStyle |= Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE;
                return parameters;
            }
        }

        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        public async Task Start(CoreWebView2Environment environment)
        {
            await view.EnsureCoreWebView2Async(environment);
            var core = view.CoreWebView2;
            var settings = core.Settings;
            settings.AreDefaultContextMenusEnabled = false;
            settings.AreDevToolsEnabled = false;
            settings.IsStatusBarEnabled = false;
            settings.IsZoomControlEnabled = false;
            settings.AreBrowserAcceleratorKeysEnabled = false;
            settings.IsPinchZoomEnabled = false;
            settings.IsSwipeNavigationEnabled = false;
            core.SetVirtualHostNameToFolderMapping(HostName, root, CoreWebView2HostResourceAccessKind.Allow);
            await core.AddScriptToExecuteOnDocumentCreatedAsync(bridge);
            // Upravená scéna se po „Znovu načíst“ musí opravdu načíst znovu, ne z mezipaměti.
            await core.CallDevToolsProtocolMethodAsync("Network.enable", "{}");
            await core.CallDevToolsProtocolMethodAsync("Network.setCacheDisabled", "{\"cacheDisabled\":true}");
            core.WebMessageReceived += OnMessage;
            core.NavigationStarting += delegate { loaded = false; inside = false; };
            core.NavigationCompleted += OnNavigated;
            core.ProcessFailed += delegate (object sender, CoreWebView2ProcessFailedEventArgs e)
            {
                Log.Write("Obrazovka " + (index + 1) + ": proces prohlížeče selhal (" + e.ProcessFailedKind + ")");
                // Zaseknutí krátce po načtení bývá jen dlouhý první překlad shaderů po
                // aktualizaci (grafika je chvíli zaneprázdněná). Znovunačtení by překlad
                // spustilo od začátku; raději počkat a pak ověřit, jestli stránka odpovídá.
                if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive &&
                    (DateTime.UtcNow - navigatedAt).TotalSeconds < 90)
                {
                    if (waitingForCompile) return;
                    waitingForCompile = true;
                    Log.Write("Obrazovka " + (index + 1) + ": stránka se zasekla krátce po načtení (překlad shaderů?), čekám minutu.");
                    var watch = new System.Windows.Forms.Timer();
                    watch.Interval = 60000;
                    watch.Tick += async delegate
                    {
                        watch.Stop();
                        watch.Dispose();
                        waitingForCompile = false;
                        var answer = Evaluate("1");
                        if (await Task.WhenAny(answer, Task.Delay(10000)) == answer)
                        {
                            Log.Write("Obrazovka " + (index + 1) + ": stránka zase odpovídá.");
                            return;
                        }
                        Log.Write("Obrazovka " + (index + 1) + ": stránka pořád neodpovídá, načítám ji znovu.");
                        Reload();
                    };
                    watch.Start();
                    return;
                }
                // Po pádu grafiky nebo stránky ji po chvíli načíst znovu; při opakovaných pádech
                // s delším odstupem (5 s, 20 s, 1 min, pak 5 min), ať se grafika stihne zotavit.
                failures++;
                int wait = failures <= 1 ? 5000 : failures == 2 ? 20000 : failures == 3 ? 60000 : 300000;
                var timer = new System.Windows.Forms.Timer();
                timer.Interval = wait;
                timer.Tick += delegate
                {
                    timer.Stop();
                    timer.Dispose();
                    Log.Write("Obrazovka " + (index + 1) + ": načítám scénu znovu po pádu.");
                    Reload();
                };
                timer.Start();
            };
            core.Navigate(Address);
        }

        public string Address
        {
            get
            {
                return "https://" + HostName + "/scenes/" + Uri.EscapeDataString(scene.Name) +
                    "/index.html?screen=" + index.ToString(CultureInfo.InvariantCulture) +
                    (string.IsNullOrEmpty(ExtraQuery) ? "" : "&" + ExtraQuery);
            }
        }

        DateTime navigatedAt = DateTime.UtcNow;
        bool waitingForCompile;

        void OnNavigated(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            navigatedAt = DateTime.UtcNow;
            if (!e.IsSuccess)
            {
                Log.Write("Obrazovka " + (index + 1) + ": scénu se nepodařilo načíst (" + e.WebErrorStatus + ")");
                return;
            }
            loaded = true;
            Send();
            if (failures > 0) Log.Write("Obrazovka " + (index + 1) + ": scéna po pádu znovu běží.");
            var handler = Loaded;
            if (handler != null) handler(this);
        }

        void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            Dictionary<string, object> message;
            try
            {
                message = new JavaScriptSerializer().DeserializeObject(e.WebMessageAsJson) as Dictionary<string, object>;
            }
            catch (Exception)
            {
                return;
            }
            if (message == null) return;
            object type;
            message.TryGetValue("type", out type);
            if ("report".Equals(type))
            {
                object text;
                message.TryGetValue("text", out text);
                string line = Convert.ToString(text, CultureInfo.InvariantCulture);
                Log.Write("Stránka (obrazovka " + (index + 1) + "): " + line);
                var handler = Reported;
                if (handler != null) handler(this, line);
            }
            else if ("size".Equals(type))
            {
                object dpr;
                if (message.TryGetValue("dpr", out dpr))
                {
                    double value = Convert.ToDouble(dpr, CultureInfo.InvariantCulture);
                    if (value > 0) pixelRatio = value;
                }
            }
        }

        public void Reload()
        {
            if (view.CoreWebView2 == null) return;
            loaded = false;
            view.CoreWebView2.Navigate(Address);
        }

        /// <summary>Posílá jen změny. Stránka si poslední hodnotu podrží sama.</summary>
        public bool SetRate(int wanted)
        {
            if (wanted == rate) return false;
            rate = wanted;
            if (rate == 0 && inside) SetPointer(null, true);
            Send();
            return true;
        }

        public void SetPower(bool onBattery)
        {
            if (battery == onBattery) return;
            battery = onBattery;
            Send();
        }

        void Send()
        {
            if (!loaded) return;
            Script("wallpaperHost.deliver('power', " + (battery ? "true" : "false") + ");" +
                "wallpaperHost.deliver('rate', " + Math.Max(0, rate).ToString(CultureInfo.InvariantCulture) + ");");
        }

        /// <summary>Akce scény z menu. Když scéna stojí, nic se neposílá.</summary>
        public void RunAction(string id, bool evenWhenStill = false)
        {
            if (!loaded || (rate <= 0 && !evenWhenStill)) return;
            Script("wallpaperHost.deliver('action', " + new JavaScriptSerializer().Serialize(id) + ");");
        }

        /// <summary>Poloha kurzoru v pixelech této obrazovky, nebo null, když z ní odjel.</summary>
        public void SetPointer(Point? position, bool force = false)
        {
            if (!loaded || (rate <= 0 && !force)) return;
            if (!position.HasValue)
            {
                if (inside) Script("wallpaperHost.leave();");
                inside = false;
                return;
            }
            inside = true;
            double x = position.Value.X / pixelRatio;
            double y = position.Value.Y / pixelRatio;
            Script("wallpaperHost.pointer(" + x.ToString("0.0", CultureInfo.InvariantCulture) + "," +
                y.ToString("0.0", CultureInfo.InvariantCulture) + ");");
        }

        void Script(string code)
        {
            if (view.CoreWebView2 == null) return;
            view.CoreWebView2.ExecuteScriptAsync("window.wallpaperHost && (() => { " + code + " })()");
        }

        public Task<string> Evaluate(string expression)
        {
            return view.CoreWebView2.ExecuteScriptAsync(expression);
        }

        /// <summary>Co tato obrazovka právě ukazuje, jako PNG.</summary>
        public async Task Snapshot(string file)
        {
            using (var stream = new FileStream(file, FileMode.Create, FileAccess.Write))
            {
                await view.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, stream);
            }
            Log.Write("Snímek obrazovky " + (index + 1) + " uložen: " + file);
        }

        /// <summary>Stav stránky do logu.</summary>
        public async Task Probe()
        {
            try
            {
                string state = await Evaluate(
                    "(() => { const c = document.querySelector('#scene'); return JSON.stringify({" +
                    "pixels: c && [c.width, c.height], hidden: document.hidden, ready: document.documentElement.dataset.ready," +
                    "error: (document.querySelector('#error') || {}).textContent || '' }); })()");
                Log.Write("Stav stránky (obrazovka " + (index + 1) + "): " + state);
            }
            catch (Exception error)
            {
                Log.Write("Stav stránky nejde přečíst: " + error.Message);
            }
        }
    }
}
