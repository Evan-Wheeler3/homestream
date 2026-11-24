// The parts of VR mode that are plain arithmetic, kept apart from WebXR so they
// can be tested: where a pointing ray lands on the block grid (teleporting),
// and the floating menu panel's buttons (laid out, drawn and pointed at).
import type { VoxelGrid } from './grid';
import { VOXEL } from './grid';
import { gated, overlaps } from './physics';

/** How far you can teleport in one pinch, in metres. */
export const TELEPORT_RANGE = 12;

export type TeleportHit =
  | { ok: true; x: number; y: number; z: number; distance: number }
  /** Aimed at something you can't stand on (a wall, a seat back, a door you have no ticket for). */
  | {
      ok: false;
      x: number;
      y: number;
      z: number;
      distance: number;
      blockedBy: number | null;
    };

/**
 * Follows a ray through the block grid to the first solid block. It's a place
 * to teleport to when the ray came down onto the top of a block and there's
 * room to stand there (and, at a theater door, you hold its ticket).
 * Returns null when the ray reaches nothing within range.
 */
export function castTeleport(
  grid: VoxelGrid,
  origin: { x: number; y: number; z: number },
  direction: { x: number; y: number; z: number },
  ticket: number | null,
  range = TELEPORT_RANGE,
): TeleportHit | null {
  const len = Math.hypot(direction.x, direction.y, direction.z);
  if (len < 1e-9) return null;
  const d = { x: direction.x / len, y: direction.y / len, z: direction.z / len };
  const b = grid.bounds;
  // In cell units, from the grid's corner.
  const p = {
    x: (origin.x - b.x0) / VOXEL,
    y: (origin.y - b.y0) / VOXEL,
    z: (origin.z - b.z0) / VOXEL,
  };
  let ix = Math.floor(p.x);
  let iy = Math.floor(p.y);
  let iz = Math.floor(p.z);
  const stepX = Math.sign(d.x);
  const stepY = Math.sign(d.y);
  const stepZ = Math.sign(d.z);
  const next = (pos: number, i: number, s: number, dir: number) =>
    s === 0 ? Infinity : ((s > 0 ? i + 1 - pos : pos - i) / Math.abs(dir)) * VOXEL;
  let tX = next(p.x, ix, stepX, d.x);
  let tY = next(p.y, iy, stepY, d.y);
  let tZ = next(p.z, iz, stepZ, d.z);
  const dX = stepX === 0 ? Infinity : VOXEL / Math.abs(d.x);
  const dY = stepY === 0 ? Infinity : VOXEL / Math.abs(d.y);
  const dZ = stepZ === 0 ? Infinity : VOXEL / Math.abs(d.z);
  // Leaving a block you're already inside (a hand through a wall) doesn't count as hitting it.
  const startedInside = grid.solidAt(ix, iy, iz);
  for (let guard = 0; guard < 2000; guard++) {
    let t: number;
    let axis: 'x' | 'y' | 'z';
    if (tX <= tY && tX <= tZ) {
      t = tX;
      axis = 'x';
      ix += stepX;
      tX += dX;
    } else if (tY <= tZ) {
      t = tY;
      axis = 'y';
      iy += stepY;
      tY += dY;
    } else {
      t = tZ;
      axis = 'z';
      iz += stepZ;
      tZ += dZ;
    }
    if (t > range) return null;
    // (Outside the grid counts as solid, so the ground under the building is a floor too.)
    if (!grid.solidAt(ix, iy, iz) || (startedInside && t < VOXEL)) continue;
    const x = origin.x + d.x * t;
    const z = origin.z + d.z * t;
    const top = b.y0 + (iy + 1) * VOXEL;
    return landing(grid, x, top, z, t, ticket, axis === 'y' && stepY < 0);
  }
  return null;
}

function landing(
  grid: VoxelGrid,
  x: number,
  y: number,
  z: number,
  distance: number,
  ticket: number | null,
  onTop: boolean,
): TeleportHit {
  if (!onTop) return { ok: false, x, y, z, distance, blockedBy: null };
  const door = gated(grid, x, z, ticket);
  if (door !== null) return { ok: false, x, y, z, distance, blockedBy: door };
  if (overlaps(grid, x, y, z)) return { ok: false, x, y, z, distance, blockedBy: null };
  return { ok: true, x, y, z, distance };
}

// -----------------------------------------------------------------------------
// The menu panel

export interface VrButton {
  id: string;
  label: string;
  /** Takes a whole row. */
  wide?: boolean;
  primary?: boolean;
}

export interface VrPanelModel {
  title: string;
  /** A line or two of news under the title (a ticket's directions, an error). */
  lines: string[];
  buttons: VrButton[];
}

export interface PanelLayout {
  width: number;
  height: number;
  buttons: { id: string; x: number; y: number; w: number; h: number }[];
}

export const PANEL_WIDTH = 640;
const PAD = 24;
const GAP = 14;
const TITLE_H = 58;
const LINE_H = 34;
const BUTTON_H = 78;

/** Two buttons to a row (a wide one takes the row), under the title and news. */
export function layoutPanel(model: VrPanelModel, width = PANEL_WIDTH): PanelLayout {
  const half = (width - PAD * 2 - GAP) / 2;
  let y = PAD + TITLE_H + model.lines.length * LINE_H + (model.lines.length ? GAP : 0);
  let col = 0;
  const buttons: PanelLayout['buttons'] = [];
  for (const b of model.buttons) {
    if (b.wide) {
      // A half row left open ends there.
      if (col === 1) y += BUTTON_H + GAP;
      buttons.push({ id: b.id, x: PAD, y, w: width - PAD * 2, h: BUTTON_H });
      y += BUTTON_H + GAP;
      col = 0;
    } else {
      buttons.push({ id: b.id, x: PAD + col * (half + GAP), y, w: half, h: BUTTON_H });
      if (col === 1) y += BUTTON_H + GAP;
      col = 1 - col;
    }
  }
  if (col === 1) y += BUTTON_H + GAP;
  return { width, height: y - GAP + PAD, buttons };
}

/** Which button a point on the panel is over (u, v as a texture sees them: 0..1 from bottom left). */
export function buttonAt(layout: PanelLayout, u: number, v: number): string | null {
  const x = u * layout.width;
  const y = (1 - v) * layout.height;
  const b = layout.buttons.find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
  return b?.id ?? null;
}

/** Cuts text to fit a width, with an ellipsis. */
function fit(g: CanvasRenderingContext2D, text: string, width: number) {
  if (g.measureText(text).width <= width) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > width) t = t.slice(0, -1);
  return `${t}…`;
}

export function drawPanel(
  canvas: HTMLCanvasElement,
  model: VrPanelModel,
  layout: PanelLayout,
  hover: string | null,
  pressed: string | null,
) {
  if (canvas.width !== layout.width) canvas.width = layout.width;
  if (canvas.height !== layout.height) canvas.height = layout.height;
  const g = canvas.getContext('2d')!;
  const font = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = 'rgba(14, 10, 30, 0.92)';
  roundRect(g, 0, 0, canvas.width, canvas.height, 28);
  g.fill();
  g.strokeStyle = '#f5c542';
  g.lineWidth = 4;
  roundRect(g, 2, 2, canvas.width - 4, canvas.height - 4, 26);
  g.stroke();
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.fillStyle = '#f5c542';
  g.font = `bold 34px ${font}`;
  g.fillText(fit(g, model.title, canvas.width - PAD * 2), PAD, PAD + TITLE_H / 2);
  g.fillStyle = '#e8e4f4';
  g.font = `26px ${font}`;
  model.lines.forEach((line, i) => {
    g.fillText(fit(g, line, canvas.width - PAD * 2), PAD, PAD + TITLE_H + LINE_H * i + LINE_H / 2);
  });
  g.textAlign = 'center';
  for (const r of layout.buttons) {
    const b = model.buttons.find((x) => x.id === r.id)!;
    const on = r.id === pressed;
    const over = r.id === hover;
    g.fillStyle = on
      ? '#fff3c4'
      : b.primary
        ? over
          ? '#ffd76a'
          : '#f5c542'
        : over
          ? '#4a3c7a'
          : '#2c2350';
    roundRect(g, r.x, r.y, r.w, r.h, 16);
    g.fill();
    if (over) {
      g.strokeStyle = '#ffffff';
      g.lineWidth = 4;
      roundRect(g, r.x + 2, r.y + 2, r.w - 4, r.h - 4, 14);
      g.stroke();
    }
    g.fillStyle = b.primary || on ? '#1a1030' : '#ffffff';
    g.font = `bold 28px ${font}`;
    g.fillText(fit(g, b.label, r.w - 24), r.x + r.w / 2, r.y + r.h / 2 + 1);
  }
}

function roundRect(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Seconds as 1:02:03 (or 2:03). */
export function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
