// Malé ovládání pro náhled v prohlížeči. V aplikaci tapety se neukazuje.
// Každá scéna si předá vlastní tlačítka; Pauza, Celá obrazovka a Skrýt jsou společné.
// Klávesy: podle tlačítek scény, mezerník pauza, F celá obrazovka, H skrýt.

export function setupControls({ buttons = [], extras = [], onPause }) {
  const panel = document.createElement('nav');
  panel.id = 'controls';
  panel.setAttribute('aria-label', 'Ovládání náhledu');
  const keys = new Map();
  const button = (label, key, action) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `${label} <kbd>${key}</kbd>`;
    b.addEventListener('click', () => { action(); b.blur(); });
    panel.append(b);
    keys.set(key === 'mezerník' ? ' ' : key.toLowerCase(), action);
    return b;
  };
  let paused = false;
  const setPaused = (value) => {
    paused = value;
    pause.innerHTML = `${paused ? 'Pokračovat' : 'Pauza'} <kbd>mezerník</kbd>`;
    onPause(paused);
  };
  const fullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  };

  for (const { label, key, action } of buttons) button(label, key, action);
  // Vlastní prvky scény (třeba posuvníky), vloží se za její tlačítka.
  for (const element of extras) panel.append(element);
  const pause = button('Pauza', 'mezerník', () => setPaused(!paused));
  button('Celá obrazovka', 'F', fullscreen);
  button('Skrýt', 'H', () => panel.classList.toggle('hidden'));
  document.body.append(panel);

  addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target instanceof HTMLInputElement) return;
    const action = keys.get(event.key.toLowerCase());
    if (!action) return;
    action();
    event.preventDefault();
  });
}
