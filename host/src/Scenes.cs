// Hledání scén: každá podsložka scenes/ s index.html je scéna. Volitelný scene.json
// určí název, barvu pozadí a akce do menu: { "title", "background", "actions": [{ "id", "title" }] }.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Web.Script.Serialization;

namespace MojeTapeta
{
    sealed class SceneAction
    {
        public string Id;
        public string Title;
    }

    sealed class Scene
    {
        public string Name;
        public string Title;
        public Color Background = Color.Black;
        public List<SceneAction> Actions = new List<SceneAction>();

        public static List<Scene> Discover(string root)
        {
            var scenes = new List<Scene>();
            string folder = Path.Combine(root, "scenes");
            if (!Directory.Exists(folder)) return scenes;
            var names = new List<string>(Directory.GetDirectories(folder));
            names.Sort(StringComparer.OrdinalIgnoreCase);
            foreach (string directory in names)
            {
                if (!File.Exists(Path.Combine(directory, "index.html"))) continue;
                var scene = new Scene();
                scene.Name = Path.GetFileName(directory);
                scene.Title = scene.Name;
                string json = Path.Combine(directory, "scene.json");
                if (File.Exists(json))
                {
                    try
                    {
                        scene.Read(File.ReadAllText(json));
                    }
                    catch (Exception error)
                    {
                        Log.Write("scene.json ve scéně " + scene.Name + " nejde přečíst: " + error.Message);
                    }
                }
                scenes.Add(scene);
            }
            return scenes;
        }

        void Read(string text)
        {
            var data = new JavaScriptSerializer().DeserializeObject(text) as Dictionary<string, object>;
            if (data == null) return;
            object value;
            if (data.TryGetValue("title", out value) && value is string) Title = (string)value;
            if (data.TryGetValue("background", out value) && value is string)
            {
                try
                {
                    Background = ColorTranslator.FromHtml((string)value);
                }
                catch (Exception)
                {
                    Log.Write("Neznámá barva pozadí ve scéně " + Name + ": " + value);
                }
            }
            if (data.TryGetValue("actions", out value) && value is IEnumerable)
            {
                foreach (object entry in (IEnumerable)value)
                {
                    var action = entry as Dictionary<string, object>;
                    if (action == null) continue;
                    object id, title;
                    if (!action.TryGetValue("id", out id) || !(id is string)) continue;
                    var item = new SceneAction();
                    item.Id = (string)id;
                    item.Title = action.TryGetValue("title", out title) && title is string ? (string)title : item.Id;
                    Actions.Add(item);
                }
            }
        }

        public string Html
        {
            get { return "#" + Background.R.ToString("x2") + Background.G.ToString("x2") + Background.B.ToString("x2"); }
        }
    }
}
