import http from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 8080);
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".md": "text/plain",
};
http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      // Nahrávky záběrů pro video (scéna s ?nahravat=...): uloží se do postup/video/zabery.
      if (req.method === "PUT" && url.pathname === "/nahravka") {
        const name = (url.searchParams.get("nazev") || "zaber").replace(/[^a-z0-9-]/gi, "");
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const folder = resolve(root, "postup", "video", "zabery");
        await mkdir(folder, { recursive: true });
        await writeFile(resolve(folder, name + ".webm"), Buffer.concat(chunks));
        console.log(`Nahrávka uložena: ${name}.webm`);
        res.writeHead(200);
        res.end("ok");
        return;
      }
      let path = resolve(root, "." + decodeURIComponent(url.pathname));
      if (
        path !== root.slice(0, -1) &&
        !path.startsWith(root.endsWith(sep) ? root : root + sep)
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      if ((await stat(path)).isDirectory()) path = resolve(path, "index.html");
      const data = await readFile(path);
      res.writeHead(200, {
        "Content-Type": types[extname(path)] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  })
  .listen(port, "127.0.0.1", () =>
    console.log(`Moje tapeta: http://localhost:${port}`),
  );
