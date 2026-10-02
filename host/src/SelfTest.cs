// Samotest ve skutečném WebView2: vykreslí scénu v okně schovaném za obrázkem plochy,
// pošle falešný kurzor, spustí akce z menu a uloží PNG. Plochu přitom nijak nemění.
// Výsledek zapíše do <složka>\vysledek.txt, návratový kód 0 = v pořádku.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

namespace MojeTapeta
{
    static class SelfTest
    {
        public static int Run(string root, string folder, string sceneName)
        {
            int code = 1;
            Directory.CreateDirectory(folder);
            var report = new StringBuilder();
            Execute(root, folder, sceneName, report).ContinueWith(task =>
            {
                if (task.Exception != null) report.AppendLine("CHYBA: " + task.Exception.GetBaseException());
                else code = task.Result ? 0 : 1;
                report.AppendLine(code == 0 ? "VÝSLEDEK: v pořádku" : "VÝSLEDEK: selhalo");
                File.WriteAllText(Path.Combine(folder, "vysledek.txt"), report.ToString(), Encoding.UTF8);
                Application.ExitThread();
            }, TaskScheduler.FromCurrentSynchronizationContext());
            Application.Run();
            return code;
        }

        static async Task<bool> Execute(string root, string folder, string sceneName, StringBuilder report)
        {
            var scenes = Scene.Discover(root);
            var scene = scenes.FirstOrDefault(s => s.Name == sceneName) ?? (sceneName == null ? scenes.FirstOrDefault() : null);
            if (scene == null)
            {
                report.AppendLine("Scéna " + sceneName + " ve složce " + root + " není.");
                return false;
            }
            report.AppendLine("Scéna: " + scene.Title + " (" + scene.Name + "), akce: " +
                string.Join(", ", scene.Actions.Select(a => a.Id + "=" + a.Title)));

            string data = Path.Combine(Path.GetTempPath(), "MojeTapeta-test");
            var options = new CoreWebView2EnvironmentOptions("--gpu-program-cache-size-kb=131072 --gpu-disk-cache-size-kb=262144 --disable-features=CalculateNativeWinOcclusion " +
                "--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding");
            var environment = await CoreWebView2Environment.CreateAsync(null, data, options);
            report.AppendLine("WebView2 Runtime: " + environment.BrowserVersionString);

            string bridge = File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "bridge.js"));
            Rectangle primary = Screen.PrimaryScreen.Bounds;
            // Proměnná MOJETAPETA_TEST_PLNE=1 spustí test v plném rozlišení hlavního monitoru.
            bool fullSize = Environment.GetEnvironmentVariable("MOJETAPETA_TEST_PLNE") == "1";
            var bounds = fullSize ? primary : new Rectangle(primary.X, primary.Y, Math.Min(1280, primary.Width), Math.Min(720, primary.Height));
            var window = new WallpaperWindow(0, bounds, scene, root, bridge);
            // MOJETAPETA_TEST_ADRESA=hodina=13&akce=ptaci přidá parametry do adresy scény.
            window.ExtraQuery = Environment.GetEnvironmentVariable("MOJETAPETA_TEST_ADRESA");
            var errors = new List<string>();
            window.Reported += (sender, line) =>
            {
                report.AppendLine("stránka: " + line);
                if (line.StartsWith("error")) errors.Add(line);
            };
            var loaded = new TaskCompletionSource<bool>();
            window.Loaded += sender => loaded.TrySetResult(true);
            window.Show();
            // Za obrázek plochy: úplně dospod, pod okno plochy. Uživatel nic neuvidí.
            Native.SetWindowPos(window.Handle, Native.HWND_BOTTOM, 0, 0, 0, 0,
                Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
            var checks = new List<KeyValuePair<string, bool>>();
            try
            {
                await window.Start(environment);
                if (await Task.WhenAny(loaded.Task, Task.Delay(20000)) != loaded.Task)
                {
                    report.AppendLine("Stránka se nenačetla do 20 s.");
                    return false;
                }
                bool ready = false;
                // Po aktualizaci WebView2 se shadery překládají znovu (desítky sekund).
                for (int i = 0; i < 450 && !ready; i++)
                {
                    ready = await window.Evaluate("document.documentElement.dataset.ready") == "\"true\"";
                    if (!ready) await Task.Delay(200);
                }
                checks.Add(new KeyValuePair<string, bool>("První snímek vykreslen", ready));
                if (!ready) return Summary(report, checks, errors);

                window.SetPower(false);
                window.SetRate(60);
                await Task.Delay(1500);
                // Scéna, která se dopočítává na pozadí (Alpy), se fotí až hotová (nejvýš 90 s),
                // jinak by snímky ukazovaly jen rychlý náhled.
                for (int i = 0; i < 180; i++)
                {
                    string done = await window.Evaluate("window.sceneCheck ? sceneCheck('hotovo') : true");
                    if (done != "false") break;
                    await Task.Delay(500);
                }
                await window.Snapshot(Path.Combine(folder, "01-klid.png"));

                // Falešný kurzor: pomalý tah přes spodní část obrazovky.
                for (int i = 0; i <= 45; i++)
                {
                    window.SetPointer(new Point(bounds.Width / 3 + i * 8, bounds.Height * 7 / 10 + i * 2));
                    await Task.Delay(33);
                }
                await Task.Delay(700);
                await window.Snapshot(Path.Combine(folder, "02-kurzor.png"));
                await Check(window, "kurzor", checks);
                // Výřez kolem hejna ptáků (jen Alpy), zapsaný přímo ze stránky.
                string birds = await window.Evaluate("window.alpy && alpy.birdShot ? alpy.birdShot() : ''");
                string shot = new JavaScriptSerializer() { MaxJsonLength = int.MaxValue }.Deserialize<string>(birds);
                if (!string.IsNullOrEmpty(shot) && shot.StartsWith("data:image/png;base64,"))
                    File.WriteAllBytes(Path.Combine(folder, "04-ptaci.png"), Convert.FromBase64String(shot.Substring(22)));

                window.SetPointer(null);
                // Stejná cesta jako položky akcí v menu.
                foreach (var action in scene.Actions) window.RunAction(action.Id);
                await Task.Delay(3000);
                await window.Snapshot(Path.Combine(folder, "03-akce.png"));
                await Check(window, "akce", checks);

                // Zastavení: rychlost 0 musí smyčku zastavit.
                window.SetRate(0);
                await Task.Delay(500);
                string frames1 = await window.Evaluate("window.sceneCheck && sceneCheck('snimky')");
                await Task.Delay(1000);
                string frames2 = await window.Evaluate("window.sceneCheck && sceneCheck('snimky')");
                checks.Add(new KeyValuePair<string, bool>("Rychlost 0 zastaví kreslení (" + frames1 + " / " + frames2 + ")", frames1 == frames2));
                return Summary(report, checks, errors);
            }
            finally
            {
                window.Close();
                window.Dispose();
            }
        }

        /// <summary>Kontroly, které si scéna určí sama ve window.sceneCheck(fáze).</summary>
        static async Task Check(WallpaperWindow window, string phase, List<KeyValuePair<string, bool>> checks)
        {
            string raw = await window.Evaluate("JSON.stringify(window.sceneCheck ? sceneCheck('" + phase + "') : {})");
            var json = new JavaScriptSerializer();
            string inner = json.Deserialize<string>(raw);
            var result = inner == null ? null : json.DeserializeObject(inner) as Dictionary<string, object>;
            if (result == null) return;
            foreach (var entry in result) checks.Add(new KeyValuePair<string, bool>(entry.Key, true.Equals(entry.Value)));
        }

        static bool Summary(StringBuilder report, List<KeyValuePair<string, bool>> checks, List<string> errors)
        {
            foreach (var check in checks) report.AppendLine(check.Key + ": " + (check.Value ? "ano" : "ne"));
            report.AppendLine("Chyby stránky: " + errors.Count);
            return errors.Count == 0 && checks.All(c => c.Value);
        }
    }
}
