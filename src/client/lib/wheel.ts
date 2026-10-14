/**
 * Geometry for the movie wheel. Angles are in degrees, measured clockwise
 * from 12 o'clock (where the pointer is). Segment i covers
 * [i·s, (i+1)·s) with s = 360 / count when the wheel is at rotation 0.
 */

const rad = (deg: number) => ((deg - 90) * Math.PI) / 180;

export function polar(radius: number, deg: number): [number, number] {
  return [radius * Math.cos(rad(deg)), radius * Math.sin(rad(deg))];
}

/** SVG path for one slice of a wheel centred on (0, 0). */
export function slicePath(index: number, count: number, radius: number): string {
  const size = 360 / count;
  const start = index * size;
  const end = start + size;
  const [x1, y1] = polar(radius, start);
  const [x2, y2] = polar(radius, end);
  const large = size > 180 ? 1 : 0;
  const f = (n: number) => n.toFixed(3);
  return `M0 0 L${f(x1)} ${f(y1)} A${radius} ${radius} 0 ${large} 1 ${f(x2)} ${f(y2)} Z`;
}

const mod = (n: number, m: number) => ((n % m) + m) % m;

/** Which slice is under the pointer for a given wheel rotation. */
export function sliceAt(rotation: number, count: number): number {
  return Math.floor(mod(-rotation, 360) / (360 / count)) % count;
}

/**
 * Final rotation that lands `winner` under the pointer after a few full turns.
 * `offset` (−0.5…0.5) moves the stopping point within the slice so it doesn't
 * always stop dead centre; it is kept away from the edges to avoid ambiguity.
 */
export function targetRotation(
  current: number,
  winner: number,
  count: number,
  turns: number,
  offset = 0,
): number {
  const size = 360 / count;
  const within = Math.max(-0.35, Math.min(0.35, offset));
  const centre = (winner + 0.5 + within) * size;
  const delta = mod(-centre - current, 360);
  return current + turns * 360 + delta;
}

/** Fast start, long suspenseful slow-down. */
export function spinEase(t: number): number {
  return 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 4.2);
}

/** Shorten long titles so they fit along a slice. */
export function wheelLabel(title: string, max: number): string {
  if (title.length <= max) return title;
  const cut = title.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,:;.-]+$/, '')}…`;
}
