// Putting one movie in the cloud: check it plays in browsers (converting it
// when not), upload the video, artwork and subtitles to R2, then tell the
// Worker about it. Used by `npm run cloud:upload` and by the disc ripper.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenSubtitles } from '../../shared/opensubtitles.js';
import { checkTiming } from '../../shared/subtitles.js';
import type { Runner } from '../ripper/process.js';
import { isBrowserPlayable, mediaInfo, probe } from './probe.js';
import { R2Uploader, sha256File, type MultipartState } from './r2.js';
import { Tmdb, type TmdbMovie } from './tmdb.js';

export interface CloudConfig {
  /** The deployed site, e.g. https://wheelhouse.example.workers.dev */
  url: string;
  macToken: string;
}

export function cloudConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CloudConfig | null {
  if (!env.CLOUD_URL || !env.CLOUD_MAC_TOKEN) return null;
  return { url: env.CLOUD_URL.replace(/\/$/, ''), macToken: env.CLOUD_MAC_TOKEN };
}

export interface IngestedMovie {
  id: string;
  tmdb_id: string | null;
  title: string;
  year: number | null;
  video_bytes: number | null;
  video_sha256: string | null;
  subtitle_status: string;
  source_path: string | null;
}

/** The Worker's Mac-only API. */
export class CloudClient {
  constructor(
    readonly config: CloudConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async call<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.config.url}/api/mac${url}`, {
      method,
      headers: {
        authorization: `Bearer ${this.config.macToken}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
      } catch {
        /* plain text */
      }
      throw new Error(`Cloud ${method} ${url} failed (${res.status}): ${message}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  movies() {
    return this.call<{ movies: IngestedMovie[] }>('GET', '/movies').then((r) => r.movies);
  }

  episodes() {
    return this.call<{ episodes: IngestedEpisode[] }>('GET', '/episodes').then((r) => r.episodes);
  }

  movieUrl(id: string) {
    return `${this.config.url}/movie/${id}`;
  }
}

export interface PublishDeps {
  run: Runner;
  handbrakeCli: string;
  r2: R2Uploader;
  tmdb: Tmdb;
  cloud: CloudClient;
  openSubtitles: OpenSubtitles | null;
  /** Where converted copies are made (never the movies drive). */
  workDir: string;
  log: (line: string) => void;
  /** Resumable upload state for this file, and how to save it. */
  state?: MultipartState | null;
  saveState?: (state: MultipartState | null) => void;
  onProgress?: (bytesDone: number, size: number) => void;
}

export interface PublishInput {
  file: string;
  tmdbId: string;
  /** The movie's own subtitles, already OCR'd from the disc (WebVTT). */
  discSubtitles?: string | null;
  /** Known SHA-256 (skips hashing again). */
  sha256?: string | null;
  /** Skip OpenSubtitles (e.g. today's downloads are used up). */
  skipDownloads?: boolean;
}

export interface PublishResult {
  id: string;
  url: string;
  title: string;
  year: number | null;
  bytes: number;
  subtitles: 'disc' | 'downloaded' | 'none';
  subtitleNote: string | null;
  converted: boolean;
}

export const cloudMovieId = (tmdbId: string) => `tmdb-${tmdbId}`;

/** The file as browsers can play it (H.264 + AAC in MP4), converted into workDir if need be. */
async function browserPlayable(
  original: string,
  id: string,
  label: string,
  deps: Pick<PublishDeps, 'run' | 'handbrakeCli' | 'workDir' | 'log'>,
) {
  let file = original;
  let info = await probe(deps.run, deps.handbrakeCli, file);
  let converted = false;
  if (!isBrowserPlayable(info)) {
    fs.mkdirSync(deps.workDir, { recursive: true });
    const out = path.join(deps.workDir, `${id}.mp4`);
    deps.log(
      `${label}: converting to a browser-friendly MP4 (${info.videoCodec ?? '?'} / ${info.audioCodecs[0] ?? '?'})…`,
    );
    const result = await deps.run(deps.handbrakeCli, [
      '-i',
      file,
      '-o',
      out,
      '--preset',
      'Fast 1080p30',
      '--format',
      'av_mp4',
      '--optimize',
      '--encoder',
      'x264',
      '--aencoder',
      'av_aac',
    ]);
    if (result.code !== 0 || !fs.existsSync(out))
      throw new Error(`HandBrake couldn’t convert ${file}`);
    file = out;
    info = await probe(deps.run, deps.handbrakeCli, file);
    converted = true;
  }
  return { file, info, converted };
}

const ext = (p: string) => path.extname(p).slice(1).toLowerCase() || 'jpg';

export async function publishMovie(input: PublishInput, deps: PublishDeps): Promise<PublishResult> {
  const id = cloudMovieId(input.tmdbId);
  const meta = await deps.tmdb.movie(input.tmdbId);
  const already = (await deps.cloud.movies()).find((m) => m.id === id);

  // 1. A file every browser can play (H.264 + AAC in MP4), converted if need be.
  const { file, info, converted } = await browserPlayable(input.file, id, meta.title, deps);
  const size = fs.statSync(file).size;
  const sha256 = !converted && input.sha256 ? input.sha256 : await sha256File(file);

  // 2. The video (skipped when the same file is already there).
  const key = `movies/${id}/video.mp4`;
  const existing = await deps.r2.head(key);
  if (existing && existing.size === size && existing.meta.sha256 === sha256) {
    deps.log(`${meta.title}: video already in storage`);
    deps.onProgress?.(size, size);
  } else {
    await deps.r2.uploadFile(file, key, {
      contentType: 'video/mp4',
      metadata: { sha256 },
      state: deps.state,
      save: (s) => deps.saveState?.(s),
      onProgress: deps.onProgress,
    });
  }
  deps.saveState?.(null);

  // 3. Artwork and cast photos.
  const images = {
    poster: null as string | null,
    backdrop: null as string | null,
    logo: null as string | null,
  };
  const art: [keyof typeof images, string | null, string][] = [
    ['poster', meta.posterPath, 'w780'],
    ['backdrop', meta.backdropPath, 'w1280'],
    ['logo', meta.logoPath, 'w500'],
  ];
  for (const [kind, from, size] of art) {
    if (!from) continue;
    const imageKey = `movies/${id}/${kind}.${ext(from)}`;
    if (!(await deps.r2.head(imageKey))) {
      await deps.r2.put(
        imageKey,
        await deps.tmdb.image(from, size),
        ext(from) === 'png' ? 'image/png' : 'image/jpeg',
      );
    }
    images[kind] = imageKey;
  }
  const cast = [];
  for (const person of meta.cast) {
    let imageKey: string | null = null;
    if (person.profilePath) {
      imageKey = `people/${person.id}.${ext(person.profilePath)}`;
      if (!(await deps.r2.head(imageKey))) {
        await deps.r2.put(
          imageKey,
          await deps.tmdb.image(person.profilePath, 'w185'),
          'image/jpeg',
        );
      }
    }
    cast.push({
      id: String(person.id),
      name: person.name,
      role: person.character,
      type: 'Actor',
      imageKey,
    });
  }
  let franchise = null;
  if (meta.collection) {
    const fid = `tmdb-collection-${meta.collection.id}`;
    const fimg = async (from: string | null, kind: 'poster' | 'backdrop', size: string) => {
      if (!from) return null;
      const k = `movies/${fid}/${kind}.${ext(from)}`;
      if (!(await deps.r2.head(k)))
        await deps.r2.put(k, await deps.tmdb.image(from, size), 'image/jpeg');
      return k;
    };
    franchise = {
      id: fid,
      name: meta.collection.name,
      poster: await fimg(meta.collection.posterPath, 'poster', 'w500'),
      backdrop: await fimg(meta.collection.backdropPath, 'backdrop', 'w1280'),
    };
  }

  // 4. English subtitles: the disc's own (OCR'd), else downloaded.
  const subtitles = [];
  let subtitleNote: string | null = null;
  const duration = info.durationSeconds ?? (meta.runtime ? meta.runtime * 60 : null);
  if (input.discSubtitles) {
    const timing = checkTiming(input.discSubtitles, duration);
    if (timing.ok) {
      const subKey = `movies/${id}/subtitles.eng.disc.vtt`;
      await deps.r2.put(subKey, input.discSubtitles, 'text/vtt; charset=utf-8');
      subtitles.push({
        language: 'eng',
        label: 'English',
        key: subKey,
        source: 'disc' as const,
        release: 'From the disc',
      });
    } else subtitleNote = `Disc subtitles not used: ${timing.reason}`;
  }
  if (subtitles.length === 0) {
    if (already && already.subtitle_status !== 'none') {
      subtitleNote = 'Kept the subtitles already in the cloud';
    } else if (!deps.openSubtitles || input.skipDownloads) {
      subtitleNote ??= 'No subtitles yet (find some in Settings → Subtitles)';
    } else {
      try {
        const found = await deps.openSubtitles.findBest(
          { imdbId: meta.imdbId, tmdbId: String(meta.id) },
          duration,
        );
        if (found) {
          const subKey = `movies/${id}/subtitles.eng.opensubtitles.vtt`;
          await deps.r2.put(subKey, found.vtt, 'text/vtt; charset=utf-8');
          subtitles.push({
            language: 'eng',
            label: 'English',
            key: subKey,
            source: 'opensubtitles' as const,
            fileId: found.candidate.fileId,
            release: found.candidate.release,
          });
        } else subtitleNote = 'OpenSubtitles had nothing with matching timing';
      } catch (error) {
        subtitleNote = error instanceof Error ? error.message : String(error);
      }
    }
  }

  // 5. Tell the cloud.
  const subtitleStatus =
    subtitles[0]?.source === 'disc' ? 'disc' : subtitles.length ? 'downloaded' : 'none';
  const body = {
    tmdbId: String(meta.id),
    imdbId: meta.imdbId,
    summary: summaryOf(meta, fs.statSync(input.file).mtime.toISOString()),
    detail: {
      cast,
      trailers: meta.trailers,
      writers: meta.writers,
      producers: meta.producers,
      mediaInfo: mediaInfo(info, size),
      externalLinks: [
        ...(meta.imdbId
          ? [{ name: 'IMDb', url: `https://www.imdb.com/title/${meta.imdbId}/` }]
          : []),
        { name: 'TheMovieDb', url: `https://www.themoviedb.org/movie/${meta.id}` },
      ],
    },
    images,
    video: { key, bytes: size, sha256, durationSeconds: info.durationSeconds },
    subtitles,
    subtitleStatus,
    franchise,
    sourcePath: input.file,
  };
  // Keep subtitles already in the cloud when none were found this time.
  const keepSubtitles = subtitles.length === 0 && already && already.subtitle_status !== 'none';
  if (keepSubtitles) delete (body as Partial<typeof body>).subtitles;
  await deps.cloud.call('PUT', `/movies/${id}`, body);
  if (converted) fs.rmSync(file, { force: true });
  return {
    id,
    url: deps.cloud.movieUrl(id),
    title: meta.title,
    year: meta.year,
    bytes: size,
    subtitles: keepSubtitles
      ? (already.subtitle_status as PublishResult['subtitles'])
      : subtitleStatus,
    subtitleNote,
    converted,
  };
}

function summaryOf(m: TmdbMovie, dateAdded: string) {
  return {
    title: m.title,
    sortTitle: m.title.toLowerCase().replace(/^(the|a|an) /, ''),
    originalTitle: m.originalTitle,
    year: m.year,
    premiereDate: m.releaseDate,
    runtimeMinutes: m.runtime,
    genres: m.genres,
    directors: m.directors,
    actors: m.cast.slice(0, 10).map((c) => c.name),
    studios: m.studios,
    tags: m.keywords,
    countries: m.countries,
    officialRating: m.certification,
    communityRating: m.voteAverage,
    criticRating: null,
    overview: m.overview,
    tagline: m.tagline,
    dateAdded,
  };
}

export const defaultWorkDir = () => path.join(os.tmpdir(), 'wheelhouse-cloud');

// -----------------------------------------------------------------------------
// TV shows

export interface IngestedEpisode {
  id: string;
  show_id: string;
  video_bytes: number | null;
  video_sha256: string | null;
  subtitle_status: string;
  source_path: string | null;
}

export const cloudShowId = (tmdbId: string) => `tmdbtv-${tmdbId}`;
const pad2 = (n: number) => String(n).padStart(2, '0');
export const cloudEpisodeId = (show: string, season: number, episode: number) =>
  `${show}-s${pad2(season)}e${pad2(episode)}`;

export interface EpisodeInput {
  file: string;
  showTmdbId: string;
  season: number;
  episode: number;
  /** Last episode of a double episode (S01E01-E02). */
  endEpisode?: number | null;
  discSubtitles?: string | null;
  sha256?: string | null;
  skipDownloads?: boolean;
}

/** Show details are fetched once per run, however many episodes are uploaded. */
const showsDone = new Map<string, Promise<{ seasons: Map<number, TmdbEpisodeList> }>>();
type TmdbEpisodeList = Awaited<ReturnType<Tmdb['season']>>;

async function publishShowOnce(showTmdbId: string, deps: PublishDeps) {
  const id = cloudShowId(showTmdbId);
  const meta = await deps.tmdb.show(showTmdbId);
  const put = async (from: string | null, key: string, size: string) => {
    if (!from) return null;
    const k = `${key}.${ext(from)}`;
    if (!(await deps.r2.head(k))) {
      await deps.r2.put(
        k,
        await deps.tmdb.image(from, size),
        ext(from) === 'png' ? 'image/png' : 'image/jpeg',
      );
    }
    return k;
  };
  const images = {
    poster: await put(meta.posterPath, `shows/${id}/poster`, 'w780'),
    backdrop: await put(meta.backdropPath, `shows/${id}/backdrop`, 'w1280'),
    logo: await put(meta.logoPath, `shows/${id}/logo`, 'w500'),
  };
  const seasons = [];
  for (const s of meta.seasons) {
    seasons.push({
      number: s.number,
      name: s.name,
      posterKey: await put(s.posterPath, `shows/${id}/season-${pad2(s.number)}`, 'w500'),
    });
  }
  const cast = [];
  for (const person of meta.cast) {
    let imageKey: string | null = null;
    if (person.profilePath) {
      imageKey = `people/${person.id}.${ext(person.profilePath)}`;
      if (!(await deps.r2.head(imageKey))) {
        await deps.r2.put(
          imageKey,
          await deps.tmdb.image(person.profilePath, 'w185'),
          'image/jpeg',
        );
      }
    }
    cast.push({
      id: String(person.id),
      name: person.name,
      role: person.character,
      type: 'Actor',
      imageKey,
    });
  }
  await deps.cloud.call('PUT', `/shows/${id}`, {
    tmdbId: String(meta.id),
    show: {
      title: meta.title,
      sortTitle: meta.title.toLowerCase().replace(/^(the|a|an) /, ''),
      year: meta.year,
      endYear: meta.endYear,
      genres: meta.genres,
      officialRating: meta.certification,
      communityRating: meta.voteAverage,
      overview: meta.overview,
      cast,
      seasons,
    },
    images,
  });
  deps.log(`${meta.title}: show details in the cloud`);
  return { seasons: new Map<number, TmdbEpisodeList>() };
}

export interface EpisodePublishResult {
  id: string;
  showId: string;
  url: string;
  title: string;
  bytes: number;
  subtitles: 'disc' | 'downloaded' | 'none';
  subtitleNote: string | null;
}

/** Uploads one episode file (and its show, the first time) to the cloud. */
export async function publishEpisode(
  input: EpisodeInput,
  deps: PublishDeps,
): Promise<EpisodePublishResult> {
  const show = cloudShowId(input.showTmdbId);
  const id = cloudEpisodeId(show, input.season, input.episode);
  let pending = showsDone.get(input.showTmdbId);
  if (!pending) {
    pending = publishShowOnce(input.showTmdbId, deps);
    showsDone.set(input.showTmdbId, pending);
    pending.catch(() => showsDone.delete(input.showTmdbId));
  }
  const showInfo = await pending;
  let seasonEpisodes = showInfo.seasons.get(input.season);
  if (!seasonEpisodes) {
    seasonEpisodes = await deps.tmdb.season(input.showTmdbId, input.season).catch(() => []);
    showInfo.seasons.set(input.season, seasonEpisodes);
  }
  const meta = seasonEpisodes.find((e) => e.number === input.episode);
  const label = `S${pad2(input.season)}E${pad2(input.episode)}`;
  const title = meta?.title ?? `Episode ${input.episode}`;

  const { file, info, converted } = await browserPlayable(input.file, id, label, deps);
  const size = fs.statSync(file).size;
  const sha256 = !converted && input.sha256 ? input.sha256 : await sha256File(file);
  const key = `shows/${show}/${id}.mp4`;
  const existing = await deps.r2.head(key);
  if (existing && existing.size === size && existing.meta.sha256 === sha256) {
    deps.log(`${label}: video already in storage`);
    deps.onProgress?.(size, size);
  } else {
    await deps.r2.uploadFile(file, key, {
      contentType: 'video/mp4',
      metadata: { sha256 },
      state: deps.state,
      save: (s) => deps.saveState?.(s),
      onProgress: deps.onProgress,
    });
  }
  deps.saveState?.(null);

  let imageKey: string | null = null;
  if (meta?.stillPath) {
    imageKey = `shows/${show}/${id}.${ext(meta.stillPath)}`;
    if (!(await deps.r2.head(imageKey)))
      await deps.r2.put(imageKey, await deps.tmdb.image(meta.stillPath, 'w780'), 'image/jpeg');
  }

  // Subtitles: the disc's own (OCR'd), else downloaded for this episode.
  const subtitles = [];
  let subtitleNote: string | null = null;
  const duration = info.durationSeconds ?? (meta?.runtime ? meta.runtime * 60 : null);
  if (input.discSubtitles) {
    const timing = checkTiming(input.discSubtitles, duration);
    if (timing.ok) {
      const subKey = `shows/${show}/${id}.eng.disc.vtt`;
      await deps.r2.put(subKey, input.discSubtitles, 'text/vtt; charset=utf-8');
      subtitles.push({
        language: 'eng',
        label: 'English',
        key: subKey,
        source: 'disc' as const,
        release: 'From the disc',
      });
    } else subtitleNote = `Disc subtitles not used: ${timing.reason}`;
  }
  if (subtitles.length === 0 && deps.openSubtitles && !input.skipDownloads) {
    try {
      const found = await deps.openSubtitles.findBest(
        { episode: { showTmdbId: input.showTmdbId, season: input.season, episode: input.episode } },
        duration,
      );
      if (found) {
        const subKey = `shows/${show}/${id}.eng.opensubtitles.vtt`;
        await deps.r2.put(subKey, found.vtt, 'text/vtt; charset=utf-8');
        subtitles.push({
          language: 'eng',
          label: 'English',
          key: subKey,
          source: 'opensubtitles' as const,
          fileId: found.candidate.fileId,
          release: found.candidate.release,
        });
      } else subtitleNote = 'OpenSubtitles had nothing with matching timing';
    } catch (error) {
      subtitleNote = error instanceof Error ? error.message : String(error);
    }
  }
  const subtitleStatus =
    subtitles[0]?.source === 'disc' ? 'disc' : subtitles.length ? 'downloaded' : 'none';
  await deps.cloud.call('PUT', `/episodes/${id}`, {
    showId: show,
    seasonNumber: input.season,
    number: input.episode,
    endNumber: input.endEpisode ?? null,
    title,
    overview: meta?.overview ?? null,
    runtimeMinutes: meta?.runtime ?? (duration ? Math.round(duration / 60) : null),
    premiereDate: meta?.airDate ?? null,
    imageKey,
    video: { key, bytes: size, sha256, durationSeconds: info.durationSeconds },
    ...(subtitles.length ? { subtitles } : {}),
    subtitleStatus,
    sourcePath: input.file,
  });
  if (converted) fs.rmSync(file, { force: true });
  return {
    id,
    showId: show,
    url: `${deps.cloud.config.url}/show/${show}`,
    title: `${label} · ${title}`,
    bytes: size,
    subtitles: subtitleStatus,
    subtitleNote,
  };
}
