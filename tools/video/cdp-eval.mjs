// Ladění natáčení: vyhodnotí výraz ve stránce otevřené v Edge s --remote-debugging-port.
// Použití: node tools/video/cdp-eval.mjs 9333 "výraz"
const [port, expression] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id === 1) { console.log(JSON.stringify(m.result.result.value ?? m.result, null, 1)); ws.close(); }
});
