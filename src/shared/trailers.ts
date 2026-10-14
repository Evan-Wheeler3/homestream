import type { Trailer } from './types.js';

const YOUTUBE_ID = /^[\w-]{11}$/;

/** Turn a trailer URL (usually YouTube, from Jellyfin) into something the app can show. */
export function toTrailer(name: string, url: string): Trailer | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const host = parsed.hostname.replace(/^(www\.|m\.)/, '');
  let id: string | null = null;
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id =
      parsed.searchParams.get('v') ??
      parsed.pathname.match(/^\/(?:embed|shorts)\/([\w-]+)/)?.[1] ??
      null;
  } else if (host === 'youtu.be') {
    id = parsed.pathname.slice(1);
  }
  if (id && YOUTUBE_ID.test(id)) {
    return {
      name: name || 'Trailer',
      kind: 'youtube',
      url: `https://www.youtube.com/watch?v=${id}`,
      embedUrl: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1`,
    };
  }
  return { name: name || 'Trailer', kind: 'link', url: parsed.toString(), embedUrl: null };
}
