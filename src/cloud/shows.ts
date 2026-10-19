// TV shows in the cloud: shows and episodes as stored in D1, turned into the
// shared Show / ShowDetail / Episode shapes with each person's watch state.
import type {
  Episode,
  EpisodeDetail,
  MovieImages,
  Person,
  Season,
  Show,
  ShowDetail,
  ShowsPayload,
} from '../shared/types.js';
import { badRequest, notFound } from '../server/errors.js';
import type { WrappedEpisode } from '../shared/wrapped.js';
import { mediaUrl, toUserState, type StoredSubtitle } from './catalog.js';
import { nowIso, type Sql } from './db.js';
import type { CloudEnv } from './env.js';
import { isServableKey } from './media.js';

/** A show's details, as the Mac sends them (images are R2 keys). */
export interface StoredShow {
  title: string;
  sortTitle: string;
  year: number | null;
  endYear: number | null;
  genres: string[];
  officialRating: string | null;
  communityRating: number | null;
  overview: string | null;
  images: MovieImages;
  cast: Person[];
  /** Season names and posters, by season number. */
  seasons: { number: number; name: string; poster: string | null }[];
}

interface ShowRow {
  id: string;
  tmdb_id: string | null;
  title: string;
  year: number | null;
  summary: string;
  date_added: string;
  updated_at: string;
}

export interface EpisodeRow {
  id: string;
  show_id: string;
  season_number: number | null;
  number: number | null;
  end_number: number | null;
  title: string;
  overview: string | null;
  runtime_minutes: number | null;
  premiere_date: string | null;
  image: string | null;
  video_key: string | null;
  video_bytes: number | null;
  video_sha256: string | null;
  duration_seconds: number | null;
  subtitles: string;
  subtitle_status: 'disc' | 'downloaded' | 'none';
  source_path: string | null;
  date_added: string;
  updated_at: string;
}

interface StateRow {
  item_id: string;
  played: number;
  favorite: number;
  position_seconds: number;
  play_count: number;
  last_played: string | null;
}

export const showId = (tmdbId: string) => `tmdbtv-${tmdbId}`;
const pad = (n: number) => String(n).padStart(2, '0');
export const episodeId = (show: string, season: number, episode: number) =>
  `${show}-s${pad(season)}e${pad(episode)}`;

/** Season, then episode; unknown numbers last. */
const order = (a: EpisodeRow, b: EpisodeRow) =>
  (a.season_number ?? 9999) - (b.season_number ?? 9999) ||
  // Specials (season 0) go after the regular seasons.
  (a.number ?? 9999) - (b.number ?? 9999);
const seasonRank = (n: number | null) => (n === 0 ? 10_000 : (n ?? 9_999));
const byWatchOrder = (a: EpisodeRow, b: EpisodeRow) =>
  seasonRank(a.season_number) - seasonRank(b.season_number) || order(a, b);

async function states(sql: Sql, userId: string, ids: string[]) {
  const map = new Map<string, StateRow>();
  // D1 limits bound parameters per query, so look ids up in chunks.
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    if (!chunk.length) break;
    const rows = await sql.all<StateRow>(
      `SELECT item_id, played, favorite, position_seconds, play_count, last_played FROM user_state
       WHERE user_id = ? AND item_id IN (${chunk.map(() => '?').join(',')})`,
      userId,
      ...chunk,
    );
    for (const r of rows) map.set(r.item_id, r);
  }
  return map;
}

function toEpisode(
  row: EpisodeRow,
  show: ShowRow,
  info: StoredShow,
  state: StateRow | undefined,
): Episode {
  return {
    id: row.id,
    showId: show.id,
    showTitle: show.title,
    seasonId: row.season_number == null ? null : `${show.id}-season-${row.season_number}`,
    seasonNumber: row.season_number,
    number: row.number,
    endNumber: row.end_number,
    title: row.title,
    overview: row.overview,
    runtimeMinutes: row.runtime_minutes,
    premiereDate: row.premiere_date,
    image: row.image ?? info.images.backdrop ?? info.images.poster,
    user: toUserState(state, row.runtime_minutes),
    available: Boolean(row.video_key),
  };
}

/** The episode to resume, or the one after the last watched (null when all are watched). */
function nextUpOf(episodes: Episode[]): Episode | null {
  const resume = episodes
    .filter((e) => e.user.positionSeconds > 0 && !e.user.played)
    .sort((a, b) => (b.user.lastPlayed ?? '').localeCompare(a.user.lastPlayed ?? ''))[0];
  if (resume) return resume;
  let lastWatched = -1;
  episodes.forEach((e, i) => {
    if (e.user.played) lastWatched = i;
  });
  return episodes.slice(lastWatched + 1).find((e) => !e.user.played && e.available) ?? null;
}

function toShow(row: ShowRow, info: StoredShow, episodes: Episode[], favorite: boolean): Show {
  const seasons = new Set(episodes.map((e) => e.seasonNumber).filter((n) => n != null && n > 0));
  return {
    id: row.id,
    title: info.title,
    sortTitle: info.sortTitle,
    year: info.year,
    endYear: info.endYear,
    genres: info.genres,
    officialRating: info.officialRating,
    communityRating: info.communityRating,
    overview: info.overview,
    dateAdded: row.date_added,
    images: info.images,
    seasonCount: seasons.size,
    episodeCount: episodes.length,
    unwatchedCount: episodes.filter((e) => !e.user.played).length,
    favorite,
  };
}

async function loadAll(sql: Sql, userId: string, onlyShow?: string) {
  const shows = onlyShow
    ? await sql.all<ShowRow>('SELECT * FROM shows WHERE id = ?', onlyShow)
    : await sql.all<ShowRow>('SELECT * FROM shows');
  const episodes = onlyShow
    ? await sql.all<EpisodeRow>('SELECT * FROM episodes WHERE show_id = ?', onlyShow)
    : await sql.all<EpisodeRow>('SELECT * FROM episodes');
  const state = await states(sql, userId, [
    ...episodes.map((e) => e.id),
    ...shows.map((s) => s.id),
  ]);
  return shows.map((show) => {
    const info = JSON.parse(show.summary) as StoredShow;
    const rows = episodes.filter((e) => e.show_id === show.id).sort(byWatchOrder);
    const eps = rows.map((r) => toEpisode(r, show, info, state.get(r.id)));
    return { show, info, rows, episodes: eps, favorite: state.get(show.id)?.favorite === 1 };
  });
}

export async function listShows(sql: Sql, userId: string): Promise<ShowsPayload> {
  const all = await loadAll(sql, userId);
  const shows = all
    .filter((s) => s.episodes.length > 0)
    .map((s) => toShow(s.show, s.info, s.episodes, s.favorite))
    .sort((a, b) => a.sortTitle.localeCompare(b.sortTitle));
  // Next up: shows someone has started, most recently watched first.
  const nextUp = all
    .map((s) => {
      const last = s.episodes
        .map((e) => e.user.lastPlayed)
        .filter((d): d is string => Boolean(d))
        .sort()
        .at(-1);
      return { last, next: last ? nextUpOf(s.episodes) : null };
    })
    .filter((x): x is { last: string; next: Episode } => Boolean(x.last && x.next))
    .sort((a, b) => b.last.localeCompare(a.last))
    .map((x) => x.next);
  return { shows, nextUp };
}

export async function showDetail(sql: Sql, userId: string, id: string): Promise<ShowDetail> {
  const [s] = await loadAll(sql, userId, id);
  if (!s || s.episodes.length === 0) throw notFound('This show isn’t in the library.');
  const bySeason = new Map<number | null, Episode[]>();
  for (const e of s.episodes)
    bySeason.set(e.seasonNumber, [...(bySeason.get(e.seasonNumber) ?? []), e]);
  const seasons: Season[] = [...bySeason.entries()]
    .sort(([a], [b]) => seasonRank(a) - seasonRank(b))
    .map(([number, eps]) => {
      const meta = s.info.seasons.find((x) => x.number === number);
      return {
        id: `${s.show.id}-season-${number ?? 'x'}`,
        number,
        name:
          meta?.name ??
          (number === 0 ? 'Specials' : number == null ? 'Episodes' : `Season ${number}`),
        episodeCount: eps.length,
        unwatchedCount: eps.filter((e) => !e.user.played).length,
        poster: meta?.poster ?? s.info.images.poster,
      };
    });
  return {
    ...toShow(s.show, s.info, s.episodes, s.favorite),
    cast: s.info.cast,
    seasons,
    episodes: s.episodes,
    nextUp: nextUpOf(s.episodes),
  };
}

export async function episodeDetail(sql: Sql, userId: string, id: string): Promise<EpisodeDetail> {
  const row = await episodeRow(sql, id);
  if (!row) throw notFound('This episode isn’t in the library.');
  const [s] = await loadAll(sql, userId, row.show_id);
  if (!s) throw notFound('This episode isn’t in the library.');
  const index = s.episodes.findIndex((e) => e.id === id);
  return {
    ...s.episodes[index]!,
    backdrop: s.info.images.backdrop,
    previousId: s.episodes[index - 1]?.id ?? null,
    nextId: s.episodes[index + 1]?.id ?? null,
  };
}

export function episodeRow(sql: Sql, id: string) {
  return sql.get<EpisodeRow>('SELECT * FROM episodes WHERE id = ?', id);
}

/** Title and runtime for "watching now", history and the player. */
export async function episodeInfo(sql: Sql, id: string) {
  const row = await sql.get<EpisodeRow & { show_title: string; show_summary: string }>(
    `SELECT e.*, s.title AS show_title, s.summary AS show_summary
     FROM episodes e JOIN shows s ON s.id = e.show_id WHERE e.id = ?`,
    id,
  );
  if (!row) return null;
  const info = JSON.parse(row.show_summary) as StoredShow;
  const code =
    row.season_number != null && row.number != null ? ` · S${row.season_number}E${row.number}` : '';
  return {
    row,
    title: `${row.show_title}${code}`,
    poster: info.images.poster,
    runtimeMinutes: row.runtime_minutes,
  };
}

// -----------------------------------------------------------------------------
// Adding shows and episodes (the Mac's API)

export interface IngestShow {
  tmdbId: string | null;
  show: Omit<StoredShow, 'images' | 'cast' | 'seasons'> & {
    cast: (Omit<Person, 'image'> & { imageKey: string | null })[];
    seasons: { number: number; name: string; posterKey: string | null }[];
  };
  images: { poster: string | null; backdrop: string | null; logo: string | null };
}

export interface IngestEpisode {
  showId: string;
  seasonNumber: number | null;
  number: number | null;
  endNumber: number | null;
  title: string;
  overview: string | null;
  runtimeMinutes: number | null;
  premiereDate: string | null;
  imageKey: string | null;
  video: { key: string; bytes: number; sha256: string; durationSeconds: number | null };
  /** Leave out to keep the episode's current subtitles. */
  subtitles?: StoredSubtitle[];
  subtitleStatus: 'disc' | 'downloaded' | 'none';
  sourcePath: string | null;
}

const validId = (id: string) => /^[\w-]{1,64}$/.test(id);
const keyUrl = (key: string | null | undefined, version?: string) =>
  key && isServableKey(key) ? mediaUrl(key, version) : null;

export async function ingestShow(sql: Sql, id: string, body: unknown) {
  if (!validId(id)) throw badRequest('Invalid show id.');
  const input = body as IngestShow;
  if (!input?.show?.title) throw badRequest('Send the show’s details.');
  const stored: StoredShow = {
    ...input.show,
    images: {
      poster: keyUrl(input.images?.poster),
      backdrop: keyUrl(input.images?.backdrop),
      logo: keyUrl(input.images?.logo),
    },
    cast: (input.show.cast ?? []).slice(0, 40).map(({ imageKey, ...p }) => ({
      ...p,
      image: keyUrl(imageKey),
    })),
    seasons: (input.show.seasons ?? []).map((s) => ({
      number: s.number,
      name: s.name,
      poster: keyUrl(s.posterKey),
    })),
  };
  const now = nowIso();
  await sql.run(
    `INSERT INTO shows (id, tmdb_id, title, year, summary, date_added, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET tmdb_id = excluded.tmdb_id, title = excluded.title,
       year = excluded.year, summary = excluded.summary, updated_at = excluded.updated_at`,
    id,
    input.tmdbId,
    stored.title,
    stored.year,
    JSON.stringify(stored),
    now,
    now,
  );
  return { id };
}

export async function ingestEpisode(env: CloudEnv, sql: Sql, id: string, body: unknown) {
  if (!validId(id)) throw badRequest('Invalid episode id.');
  const input = body as IngestEpisode;
  if (!input?.showId || !input.video || !input.title)
    throw badRequest('Send the episode’s details and video.');
  if (!(await sql.get('SELECT 1 AS ok FROM shows WHERE id = ?', input.showId)))
    throw badRequest('Add the show before its episodes.');
  const videoKey = input.video.key;
  if (!isServableKey(videoKey)) throw badRequest('Invalid video key.');
  const object = await env.MEDIA.head(videoKey);
  if (!object) throw badRequest('The video isn’t in storage yet. Upload it first.');
  if (object.size !== input.video.bytes) {
    throw badRequest(`The stored video is ${object.size} bytes, not ${input.video.bytes}.`);
  }
  const previous = input.subtitles
    ? null
    : await sql.get<{ subtitles: string; subtitle_status: IngestEpisode['subtitleStatus'] }>(
        'SELECT subtitles, subtitle_status FROM episodes WHERE id = ?',
        id,
      );
  const subtitles = input.subtitles
    ? input.subtitles.filter((s) => isServableKey(s.key))
    : previous
      ? (JSON.parse(previous.subtitles) as StoredSubtitle[])
      : [];
  const status = input.subtitles ? input.subtitleStatus : (previous?.subtitle_status ?? 'none');
  const now = nowIso();
  await sql.run(
    `INSERT INTO episodes (id, show_id, season_number, number, end_number, title, overview, runtime_minutes,
       premiere_date, image, video_key, video_bytes, video_sha256, duration_seconds, subtitles,
       subtitle_status, source_path, date_added, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET show_id = excluded.show_id, season_number = excluded.season_number,
       number = excluded.number, end_number = excluded.end_number, title = excluded.title,
       overview = excluded.overview, runtime_minutes = excluded.runtime_minutes,
       premiere_date = excluded.premiere_date, image = excluded.image, video_key = excluded.video_key,
       video_bytes = excluded.video_bytes, video_sha256 = excluded.video_sha256,
       duration_seconds = excluded.duration_seconds, subtitles = excluded.subtitles,
       subtitle_status = excluded.subtitle_status, source_path = excluded.source_path,
       updated_at = excluded.updated_at`,
    id,
    input.showId,
    input.seasonNumber,
    input.number,
    input.endNumber,
    input.title.slice(0, 200),
    input.overview,
    input.runtimeMinutes,
    input.premiereDate,
    keyUrl(input.imageKey, input.video.sha256.slice(0, 12)),
    videoKey,
    input.video.bytes,
    input.video.sha256,
    input.video.durationSeconds,
    JSON.stringify(subtitles),
    subtitles.length ? status : 'none',
    input.sourcePath,
    now,
    now,
  );
  await sql.run('UPDATE shows SET updated_at = ? WHERE id = ?', now, input.showId);
  return { id };
}

/** What the Mac has uploaded already (so it can skip it). */
export function listIngestedEpisodes(sql: Sql) {
  return sql.all<{
    id: string;
    show_id: string;
    video_bytes: number | null;
    video_sha256: string | null;
    subtitle_status: string;
    source_path: string | null;
  }>('SELECT id, show_id, video_bytes, video_sha256, subtitle_status, source_path FROM episodes');
}

/** Every episode with this person's watch state, for Wrapped. */
export async function wrappedEpisodes(sql: Sql, userId: string): Promise<WrappedEpisode[]> {
  const rows = await sql.all<{
    id: string;
    show_id: string;
    runtime_minutes: number | null;
    show_title: string;
    show_summary: string;
    played: number | null;
    last_played: string | null;
  }>(
    `SELECT e.id, e.show_id, e.runtime_minutes, s.title AS show_title, s.summary AS show_summary,
            u.played, u.last_played
     FROM episodes e JOIN shows s ON s.id = e.show_id
     LEFT JOIN user_state u ON u.item_id = e.id AND u.user_id = ?`,
    userId,
  );
  const info = new Map<string, StoredShow>();
  return rows.map((r) => {
    let show = info.get(r.show_id);
    if (!show) {
      show = JSON.parse(r.show_summary) as StoredShow;
      info.set(r.show_id, show);
    }
    return {
      id: r.id,
      showId: r.show_id,
      showTitle: r.show_title,
      poster: show.images.poster,
      runtimeMinutes: r.runtime_minutes,
      genres: show.genres,
      played: r.played === 1,
      lastPlayed: r.last_played,
    };
  });
}
