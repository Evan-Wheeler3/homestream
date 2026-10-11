/**
 * Append a target width to a Jellyfin image URL so the server sends an
 * appropriately sized image. Other URLs (sample SVG art, uploads) are returned
 * unchanged.
 */
export function sizedImage(url: string | null | undefined, width: number): string | undefined {
  if (!url) return undefined;
  if (!url.startsWith('/jf/')) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}maxWidth=${Math.round(width)}&quality=88`;
}

export function srcSet(url: string | null | undefined, widths: number[]): string | undefined {
  if (!url || !url.startsWith('/jf/')) return undefined;
  return widths.map((w) => `${sizedImage(url, w)} ${w}w`).join(', ');
}

export const POSTER_WIDTHS = [180, 280, 400, 560];
export const BACKDROP_WIDTHS = [640, 960, 1440, 1920, 2560];
