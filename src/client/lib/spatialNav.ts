import { isTvMode, remoteKey, type RemoteKey } from './tv';

/**
 * Arrow-key ("spatial") navigation for TV remotes: arrows move focus to the
 * nearest focusable element in that direction, Enter activates it and Back
 * closes dialogs or goes to the previous page.
 */

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Pick the best box in `direction` from `from`. Boxes that overlap `from` on
 * the cross axis (same row or column) win over diagonal ones; among those,
 * the closest along the direction wins. Returns the index, or -1.
 */
export function findNext(from: Box, candidates: Box[], direction: Direction): number {
  const horizontal = direction === 'left' || direction === 'right';
  const fromCenter = { x: (from.left + from.right) / 2, y: (from.top + from.bottom) / 2 };
  let best = -1;
  let bestScore = Infinity;
  candidates.forEach((c, i) => {
    const center = { x: (c.left + c.right) / 2, y: (c.top + c.bottom) / 2 };
    // Must lie in the requested direction (centre beyond ours, and not containing us).
    let gap: number;
    if (direction === 'right') {
      if (center.x <= fromCenter.x + 1 || c.left < from.left + 1) return;
      gap = Math.max(0, c.left - from.right);
    } else if (direction === 'left') {
      if (center.x >= fromCenter.x - 1 || c.right > from.right - 1) return;
      gap = Math.max(0, from.left - c.right);
    } else if (direction === 'down') {
      if (center.y <= fromCenter.y + 1 || c.top < from.top + 1) return;
      gap = Math.max(0, c.top - from.bottom);
    } else {
      if (center.y >= fromCenter.y - 1 || c.bottom > from.bottom - 1) return;
      gap = Math.max(0, from.top - c.bottom);
    }
    const overlap = horizontal
      ? Math.min(from.bottom, c.bottom) - Math.max(from.top, c.top)
      : Math.min(from.right, c.right) - Math.max(from.left, c.left);
    const crossOffset = horizontal
      ? Math.abs(center.y - fromCenter.y)
      : Math.abs(center.x - fromCenter.x);
    // Left/right stay on the same row (no jumping to the end of another row);
    // up/down may move diagonally, but aligned candidates always win.
    if (horizontal && overlap <= 0) return;
    const score = overlap > 0 ? gap + crossOffset * 0.1 : 100_000 + gap + crossOffset * 2;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

// -----------------------------------------------------------------------------
// DOM wiring

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function isVisible(el: HTMLElement) {
  if (el.getClientRects().length === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

/** The region focus is confined to: an open modal dialog, otherwise the page. */
function scope(): ParentNode {
  const dialogs = document.querySelectorAll<HTMLDialogElement>('dialog[open]');
  return dialogs[dialogs.length - 1] ?? document;
}

function focusables(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => isVisible(el) && !el.closest('[inert], [aria-hidden="true"]'),
  );
}

export function focusElement(el: HTMLElement) {
  el.focus({ preventScroll: true });
  const rect = el.getBoundingClientRect();
  const fixed = el.closest('.topbar, .player, dialog');
  if (fixed) return;
  const absoluteTop = rect.top + window.scrollY;
  const reduced = document.documentElement.dataset.motion === 'reduced';
  if (absoluteTop < window.innerHeight * 0.55) {
    // Near the top of the page (e.g. the hero): show the page from the top.
    window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
  } else {
    el.scrollIntoView({
      block: 'center',
      inline: 'nearest',
      behavior: reduced ? 'auto' : 'smooth',
    });
  }
  // Keep horizontally scrolling rows in step with focus.
  const track = el.closest<HTMLElement>('.row__track');
  if (track) {
    const t = track.getBoundingClientRect();
    if (rect.left < t.left || rect.right > t.right) {
      el.scrollIntoView({
        block: 'nearest',
        inline: 'center',
        behavior: reduced ? 'auto' : 'smooth',
      });
    }
  }
}

/**
 * Focus a sensible starting point (used after navigation): the page's main
 * action, else its first poster, else its first control. Text fields come
 * last, since focusing one can pop up the TV's on-screen keyboard.
 */
export function focusFirst(): boolean {
  const root = (document.getElementById('main') as ParentNode | null) ?? scope();
  const inView = focusables(root).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  });
  const pick =
    inView.find((el) => el.matches('.btn--primary')) ??
    inView.find((el) => el.matches('.poster-card, .continue-card__art, .collection-card')) ??
    inView.find((el) => !el.matches('input, select, textarea')) ??
    inView[0];
  if (!pick) return false;
  focusElement(pick);
  return true;
}

function nothingFocused() {
  const active = document.activeElement;
  return !active || active === document.body || active.id === 'main';
}

/** Whether a text field should keep this arrow key for moving its caret. */
function fieldKeepsKey(el: HTMLElement, key: RemoteKey) {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    if (el.type === 'range') return key === 'left' || key === 'right';
    if (!/^(text|search|email|password|url|tel|number)$/.test(el.type)) return false;
    if (key !== 'left' && key !== 'right') return false;
    try {
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? 0;
      if (start !== end) return true;
      return key === 'left' ? start > 0 : end < el.value.length;
    } catch {
      return true;
    }
  }
  return false;
}

export function move(direction: Direction): boolean {
  const root = scope();
  const active = document.activeElement as HTMLElement | null;
  if (nothingFocused() || !active || !(root as Node).contains(active)) {
    return focusFirst();
  }
  const candidates = focusables(root).filter((el) => el !== active && !el.contains(active));
  const index = findNext(
    active.getBoundingClientRect(),
    candidates.map((el) => el.getBoundingClientRect()),
    direction,
  );
  if (index < 0) return false;
  focusElement(candidates[index]!);
  return true;
}

let backTimer: number | undefined;

function goBack() {
  const dialog = scope();
  if (dialog !== document) {
    (dialog as HTMLElement).querySelector<HTMLButtonElement>('.dialog__header button')?.click();
    return;
  }
  // Some TV browsers go back on their own when Back is pressed; only step in if they don't.
  const before = location.href;
  window.clearTimeout(backTimer);
  backTimer = window.setTimeout(() => {
    if (location.href === before && location.pathname !== '/') history.back();
  }, 250);
}

function onKeyDown(event: KeyboardEvent) {
  if (!isTvMode() || event.defaultPrevented) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const key = remoteKey(event);
  if (!key) return;
  const active = document.activeElement as HTMLElement | null;

  if (key === 'back') {
    event.preventDefault();
    goBack();
    return;
  }
  if (key === 'enter') {
    // Buttons, links and form fields handle Enter themselves; other focusables get a click.
    if (active && active.matches('[tabindex]:not(a, button, input, select, textarea)')) {
      event.preventDefault();
      active.click();
    }
    return;
  }
  if (key === 'up' || key === 'down' || key === 'left' || key === 'right') {
    if (active && fieldKeepsKey(active, key)) return;
    event.preventDefault();
    move(key);
  }
}

let installed = false;

/** Install the global remote-control handler (no-op unless TV mode is on). */
export function installSpatialNavigation() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('keydown', onKeyDown);
  // In TV mode, starting playback goes full screen so the browser's toolbar disappears.
  document.addEventListener(
    'click',
    (event) => {
      if (!isTvMode() || document.fullscreenElement) return;
      const link = (event.target as Element | null)?.closest?.('a[href*="/play/"]');
      if (link) void document.documentElement.requestFullscreen?.().catch(() => undefined);
    },
    true,
  );
}
