// A demand-driven loop: a stopped scene has no rAF chain and no polling timer.
// Below the display refresh rate, sleep until shortly before the next presentation
// instead of waking JavaScript on every refresh just to discard the frame.
//
// Úprava pro Moji tapetu: časovač se probouzí s předstihem dvou obnovení displeje a snímek
// se kreslí na tom obnovení, které je termínu nejblíž (tolerance půl obnovení). Původní
// tolerance 0,5 ms na 180Hz monitoru střídala rozestupy 5, 6, 7 a 8 obnovení a pohyb cukal.
export function createFrameLoop(draw, {
  fps = 60,
  paused = false,
  hidden = false,
  clock = () => performance.now(),
  requestFrame = (fn) => requestAnimationFrame(fn),
  cancelFrame = (id) => cancelAnimationFrame(id),
  delay = (fn, ms) => setTimeout(fn, ms),
  cancelDelay = (id) => clearTimeout(id),
} = {}) {
  let raf = null, timer = null, dirty = true, disposed = false;
  let last = null, deadline = clock();
  // Délka jednoho obnovení displeje, měřená z po sobě jdoucích rAF při čekání na termín.
  let refresh = 1000 / 60, polled = null;
  const validRate = (value) => Number.isFinite(value) && value > 0 ? Math.min(120, value) : 0;
  fps = validRate(fps);
  const running = () => fps > 0 && !paused && !hidden && !disposed;
  const cancel = () => {
    if (raf !== null) cancelFrame(raf);
    if (timer !== null) cancelDelay(timer);
    raf = timer = null;
  };
  function schedule() {
    if (disposed || hidden || (!dirty && !running()) || raf !== null || timer !== null) return;
    const wait = dirty ? 0 : deadline - clock() - refresh * 3 - 4;
    if (wait > 4) {
      timer = delay(() => { timer = null; raf = requestFrame(frame); }, wait);
    } else raf = requestFrame(frame);
  }
  function frame(now) {
    raf = null;
    if (disposed || hidden || (!dirty && !running())) return;
    if (polled !== null) {
      const step = now - polled;
      if (step > 2 && step < 60) refresh += (step - refresh) * 0.25;
    }
    if (!dirty && now + refresh * 0.5 < deadline) {
      polled = now;
      raf = requestFrame(frame);
      return;
    }
    polled = null;
    const active = running();
    // Discard suspended time; cap a real stall, but not a normal 20/30 fps interval.
    const dt = active && last !== null ? Math.min(0.1, Math.max(0, (now - last) / 1000)) : 0;
    last = active ? now : null;
    dirty = false;
    draw(dt, now);
    if (active) {
      // Další termín od skutečného okamžiku vykreslení: snímky pak drží stejný počet
      // obnovení displeje a nedohánějí zpoždění dávkou zbytečných snímků.
      deadline = now + 1000 / fps;
    }
    schedule();
  }
  function changed() {
    cancel();
    last = null;
    deadline = clock();
    schedule();
  }
  const api = {
    setRate(value) {
      const next = validRate(value);
      if (next !== fps) { fps = next; changed(); }
    },
    setPaused(value) {
      if (paused !== Boolean(value)) { paused = Boolean(value); changed(); }
    },
    setHidden(value) {
      if (hidden !== Boolean(value)) { hidden = Boolean(value); changed(); }
    },
    invalidate() { dirty = true; cancel(); schedule(); },
    dispose() { disposed = true; cancel(); },
    get state() { return { fps, paused, hidden, running: running(), pending: raf !== null || timer !== null }; },
  };
  schedule();
  return api;
}
