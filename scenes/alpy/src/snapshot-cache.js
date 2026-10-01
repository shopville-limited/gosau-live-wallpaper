// Poslední hotový snímek scény pro okamžitý start: dokud se po spuštění (nebo po pádu
// grafiky) překládají shadery a dopočítává krajina, ukáže se obrázek z minula a pak
// plynule přejde do živé scény. Ukládá se do IndexedDB prohlížeče zvlášť pro každou
// obrazovku a rozlišení, nejvýš jednou za 15 minut.

const DB = 'moje-tapeta';
const STORE = 'snimky';
const EVERY = 15 * 60;   // s

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run(mode, action) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const request = action(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export function createSnapshotCache(key) {
  let image = null;
  let lastSave = -Infinity;
  let saving = false;

  // Obrázek z minula hned po načtení stránky (pod plátnem scény se nic neukazuje).
  run('readonly', (store) => store.get(key))
    .then((blob) => {
      if (!(blob instanceof Blob) || image === false) return;
      image = document.createElement('img');
      image.alt = '';
      image.src = URL.createObjectURL(blob);
      Object.assign(image.style, {
        position: 'fixed', inset: '0', width: '100vw', height: '100vh', objectFit: 'cover',
        zIndex: '1', pointerEvents: 'none', transition: 'opacity 1.5s ease',
      });
      document.body.append(image);
    })
    .catch(() => {});

  return {
    /** Živá scéna je hotová: obrázek z minula plynule zmizí. */
    hide() {
      if (image === null) { image = false; return; }
      if (!image) return;
      const old = image;
      image = false;
      old.style.opacity = '0';
      setTimeout(() => { URL.revokeObjectURL(old.src); old.remove(); }, 1800);
    },
    /** Volá se hned po nakreslení snímku (obsah plátna je ještě k dispozici). */
    maybeSave(canvas, time) {
      if (saving || time - lastSave < EVERY) return;
      lastSave = time;
      saving = true;
      canvas.toBlob((blob) => {
        saving = false;
        if (blob) run('readwrite', (store) => store.put(blob, key)).catch(() => {});
      }, 'image/jpeg', 0.88);
    },
  };
}
