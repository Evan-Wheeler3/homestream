// Apply cached appearance preferences before React loads, to avoid a flash of
// the default theme. The server copy remains the source of truth.
(function () {
  try {
    var cached = JSON.parse(localStorage.getItem('pc-appearance') || 'null');
    if (!cached) return;
    var root = document.documentElement;
    if (cached.theme) root.dataset.theme = cached.theme;
    if (cached.density) root.dataset.density = cached.density;
    if (cached.motion) root.dataset.motion = cached.motion;
    if (cached.accent) root.style.setProperty('--accent', cached.accent);
    if (cached.accentInk) root.style.setProperty('--accent-ink', cached.accentInk);
    if (cached.appName) document.title = cached.appName;
  } catch {
    /* storage unavailable: defaults apply */
  }
})();
