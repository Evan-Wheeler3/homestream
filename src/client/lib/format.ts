export function formatRuntime(minutes: number | null | undefined): string | null {
  if (!minutes || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** 3725 → "1:02:05", 65 → "1:05" */
export function formatClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const s = Math.floor(totalSeconds % 60);
  const m = Math.floor((totalSeconds / 60) % 60);
  const h = Math.floor(totalSeconds / 3600);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export function timeLeft(runtimeMinutes: number | null, positionSeconds: number): string | null {
  if (!runtimeMinutes) return null;
  const left = Math.max(0, Math.round(runtimeMinutes - positionSeconds / 60));
  if (left < 1) return 'Almost done';
  return `${formatRuntime(left)} left`;
}

export function formatBytes(bytes: number | null | undefined): string | null {
  if (!bytes) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function resolutionLabel(width: number | null, height: number | null): string | null {
  if (!width || !height) return null;
  if (width >= 3800) return '4K';
  if (width >= 1900) return '1080p';
  if (width >= 1260) return '720p';
  if (height >= 570) return '576p';
  return `${height}p`;
}

export function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff)) return null;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(iso).toLocaleDateString();
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

const LANGS: Record<string, string> = {
  eng: 'English',
  fre: 'French',
  fra: 'French',
  ger: 'German',
  deu: 'German',
  spa: 'Spanish',
  ita: 'Italian',
  jpn: 'Japanese',
  kor: 'Korean',
  chi: 'Chinese',
  zho: 'Chinese',
  por: 'Portuguese',
  rus: 'Russian',
  dut: 'Dutch',
  nld: 'Dutch',
  swe: 'Swedish',
  dan: 'Danish',
  nor: 'Norwegian',
  fin: 'Finnish',
  pol: 'Polish',
  ara: 'Arabic',
  hin: 'Hindi',
  tur: 'Turkish',
  heb: 'Hebrew',
};

export function languageName(code: string | null): string | null {
  if (!code) return null;
  return LANGS[code.toLowerCase()] ?? code;
}

export const SUBTITLE_LANGUAGE_OPTIONS = [
  { value: '', label: 'Off (forced subtitles only)' },
  ...['eng', 'spa', 'fre', 'ger', 'ita', 'por', 'jpn', 'kor', 'chi', 'dut', 'swe'].map((code) => ({
    value: code,
    label: LANGS[code] ?? code,
  })),
];
