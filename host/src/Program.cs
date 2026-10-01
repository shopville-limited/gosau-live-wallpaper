// Moje tapeta: živá tapeta pro Windows. Na každý monitor položí pod ikony plochy okno
// s WebView2, které ukazuje scénu ze složky scenes/, a posílá do ní polohu kurzoru.
//
// Použití:
//   MojeTapeta.exe [--root <složka projektu>]   spustí tapetu
//   MojeTapeta.exe --snapshot                   uloží snímek první obrazovky do %TEMP%\moje-tapeta.png
//   MojeTapeta.exe --reload                     znovu načte scénu
//   MojeTapeta.exe --quit                       ukončí běžící tapetu
//   MojeTapeta.exe --test <složka> [--scene X]  samotest: vykreslí scénu mimo plochu a uloží PNG

using System;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace MojeTapeta
{
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            try
            {
                Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); // Per Monitor v2
            }
            catch (Exception)
            {
                // Starší Windows: stačí DPI z manifestu.
            }

            string rootArgument = null;
            string testFolder = null;
            string testScene = null;
            for (int i = 0; i < args.Length; i++)
            {
                switch (args[i])
                {
                    case "--snapshot":
                        return Commands.Send(Commands.Snapshot) ? 0 : 1;
                    case "--reload":
                        return Commands.Send(Commands.Reload) ? 0 : 1;
                    case "--quit":
                        return Commands.Send(Commands.Quit) ? 0 : 1;
                    case "--root":
                        if (i + 1 < args.Length) rootArgument = args[++i];
                        break;
                    case "--test":
                        if (i + 1 < args.Length) testFolder = args[++i];
                        break;
                    case "--scene":
                        if (i + 1 < args.Length) testScene = args[++i];
                        break;
                }
            }

            string root = ResolveRoot(rootArgument);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());

            if (testFolder != null) return SelfTest.Run(root, Path.GetFullPath(testFolder), testScene);

            bool created;
            using (var instance = new Mutex(true, @"Local\MojeTapeta.Instance", out created))
            {
                if (!created) return 2; // Už běží.
                var controller = new Controller(root);
                var starting = controller.Start();
                starting.ContinueWith(delegate (System.Threading.Tasks.Task task)
                {
                    if (task.Exception != null) Log.Write("Start selhal: " + task.Exception);
                }, System.Threading.Tasks.TaskScheduler.FromCurrentSynchronizationContext());
                Application.Run();
                GC.KeepAlive(instance);
            }
            return 0;
        }

        /// <summary>Složka se scénami: --root, vedle programu, nebo nad ním (při vývoji).</summary>
        static string ResolveRoot(string argument)
        {
            if (!string.IsNullOrEmpty(argument)) return Path.GetFullPath(argument);
            var folder = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
            while (folder != null)
            {
                if (Directory.Exists(Path.Combine(folder.FullName, "scenes"))) return folder.FullName;
                folder = folder.Parent;
            }
            return AppDomain.CurrentDomain.BaseDirectory;
        }
    }
}
