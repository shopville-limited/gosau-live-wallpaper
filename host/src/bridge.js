// Most mezi aplikací Moje tapeta a stránkou scény. Aplikace ho vloží do stránky dřív,
// než se spustí její skripty.
//
// Scéna se přihlásí přes window.wallpaperHost.on('rate' | 'power' | 'action', handler).
// Hodnoty rate a power poslané dřív, než se scéna přihlásí, se podrží a doručí.
// Kurzor chodí do stránky jako pointermove a pointerleave na #scene.
(() => {
  const handlers = { rate: [], power: [], action: [] };
  const held = {};
  const post = (message) => {
    try {
      window.chrome.webview.postMessage(message);
    } catch {
      // Mimo aplikaci (např. v testu) není komu hlásit.
    }
  };
  const report = (text) => post({ type: 'report', text: String(text) });

  // Aplikace nemá okno s konzolí, chyby stránky jdou do jejího logu.
  for (const level of ['error', 'warn']) {
    const original = console[level];
    console[level] = (...parts) => {
      report(`${level}: ${parts.map((part) => (part && part.stack ? part.stack : part)).join(' ')}`);
      original.apply(console, parts);
    };
  }
  addEventListener('error', (event) =>
    report(`error: ${event.message} at ${event.filename}:${event.lineno}`));
  addEventListener('unhandledrejection', (event) =>
    report(`error: ${(event.reason && event.reason.stack) || event.reason}`));

  const sendSize = () =>
    post({ type: 'size', width: innerWidth, height: innerHeight, dpr: devicePixelRatio });
  addEventListener('resize', sendSize);
  addEventListener('DOMContentLoaded', sendSize);

  let inside = false;
  const target = () => document.querySelector('#scene') || document.documentElement;
  const call = (type, value) => {
    for (const handler of handlers[type]) {
      try {
        handler(value);
      } catch (error) {
        report(`error: ${(error && error.stack) || error}`);
      }
    }
  };

  window.wallpaperHost = Object.freeze({
    on(type, handler) {
      if (!handlers[type] || typeof handler !== 'function') return;
      handlers[type].push(handler);
      if (Object.hasOwn(held, type)) handler(held[type]);
    },
    // Následující volá aplikace.
    deliver(type, value) {
      if (!handlers[type]) return;
      if (type === 'rate' || type === 'power') held[type] = value;
      call(type, value);
    },
    pointer(x, y) {
      inside = true;
      target().dispatchEvent(new PointerEvent('pointermove', {
        clientX: x, clientY: y, bubbles: true, pointerType: 'mouse', isPrimary: true,
      }));
    },
    leave() {
      if (!inside) return;
      inside = false;
      target().dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse', isPrimary: true }));
    },
  });
})();
