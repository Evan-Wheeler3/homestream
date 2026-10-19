// This Mac and Wheelhouse in the cloud: rips upload themselves when they're
// done, and the cloud Discs page sees the ripper (and can drive it).
import fs from 'node:fs';
import path from 'node:path';
import { OpenSubtitles } from '../../shared/opensubtitles.js';
import { toPublicJob } from '../ripper/jobs.js';
import type { Runner } from '../ripper/process.js';
import type { Ripper, RipperCloud, TitleSearch } from '../ripper/ripper.js';
import { CloudClient, cloudConfigFromEnv, defaultWorkDir, publishMovie } from './publish.js';
import { R2Uploader, r2ConfigFromEnv, type MultipartState } from './r2.js';
import { confidentMatch, Tmdb } from './tmdb.js';

type Log = Pick<Console, 'info' | 'warn'>;

export interface CloudLink {
  client: CloudClient;
  publisher: RipperCloud;
  /** Disc names are looked up on TMDB (Jellyfin may be switched off). */
  titleSearch: TitleSearch;
}

/** The cloud connection, when .env has everything it needs (else null). */
export function cloudLinkFromEnv(
  options: { run: Runner; handbrakeCli: string; dataDir: string; log: Log },
  env: NodeJS.ProcessEnv = process.env,
): CloudLink | null {
  const cloud = cloudConfigFromEnv(env);
  const r2Config = r2ConfigFromEnv(env);
  if (!cloud || !r2Config || !env.TMDB_READ_TOKEN) return null;
  const client = new CloudClient(cloud);
  const r2 = new R2Uploader(r2Config);
  const tmdb = new Tmdb(env.TMDB_READ_TOKEN);
  const openSubtitles =
    env.OPENSUBTITLES_API_KEY && env.OPENSUBTITLES_USERNAME && env.OPENSUBTITLES_PASSWORD
      ? new OpenSubtitles({
          apiKey: env.OPENSUBTITLES_API_KEY,
          username: env.OPENSUBTITLES_USERNAME,
          password: env.OPENSUBTITLES_PASSWORD,
        })
      : null;
  // Unfinished uploads survive a restart.
  const stateFile = path.join(options.dataDir, 'cloud-rip-uploads.json');
  const readState = (): Record<string, MultipartState> => {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Record<string, MultipartState>;
    } catch {
      return {};
    }
  };

  const publisher: RipperCloud = {
    async publish(movie, onProgress) {
      let tmdbId = movie.tmdbId;
      if (!tmdbId) {
        const match = confidentMatch(
          await tmdb.search(movie.title, movie.year),
          movie.title,
          movie.year,
        );
        if (!match) {
          throw new Error(
            `Couldn’t tell which TMDB movie “${movie.title}” is. Name it again and pick a search result.`,
          );
        }
        tmdbId = String(match.id);
      }
      const result = await publishMovie(
        { file: movie.file, tmdbId, discSubtitles: movie.discSubtitles },
        {
          run: options.run,
          handbrakeCli: options.handbrakeCli,
          r2,
          tmdb,
          cloud: client,
          openSubtitles,
          workDir: defaultWorkDir(),
          log: (line) => options.log.info(line),
          state: readState()[movie.file] ?? null,
          saveState: (s) => {
            const all = readState();
            if (s) all[movie.file] = s;
            else delete all[movie.file];
            fs.writeFileSync(stateFile, JSON.stringify(all));
          },
          onProgress: (done, size) => onProgress(size ? done / size : 0),
        },
      );
      if (result.subtitleNote) options.log.info(`${result.title}: ${result.subtitleNote}`);
      return { id: result.id, url: result.url };
    },
  };
  const toCandidates = (results: { id: number; title: string; year: number | null }[]) =>
    results
      .slice(0, 10)
      .map((r) => ({ title: r.title, year: r.year, tmdbId: String(r.id), imdbId: null }));
  const titleSearch: TitleSearch = {
    searchMovies: async (name) => toCandidates(await tmdb.search(name, null)),
    searchShows: async (name) => toCandidates(await tmdb.searchShows(name)),
  };
  return { client, publisher, titleSearch };
}

interface Command {
  id: string;
  jobId: string;
  action: string;
  payload: Record<string, unknown>;
}

const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, 200) : null);

/** Runs a Discs-page action taken in the cloud, like the Mac's own API does. */
export async function runCommand(ripper: Ripper, c: Command) {
  const p = c.payload ?? {};
  switch (c.action) {
    case 'choose':
      return ripper.chooseTitle(c.jobId, Number(p.titleIndex));
    case 'name':
      if (typeof p.title !== 'string') throw new Error('Enter the movie’s title.');
      return ripper.resolveName(c.jobId, {
        title: p.title,
        year: typeof p.year === 'number' ? p.year : null,
        tmdbId: text(p.tmdbId),
        imdbId: text(p.imdbId),
      });
    case 'episodes': {
      const show = (p.show ?? {}) as Record<string, unknown>;
      if (typeof show.title !== 'string') throw new Error('Enter the show’s name.');
      return ripper.ripEpisodes(c.jobId, {
        show: {
          title: show.title,
          year: typeof show.year === 'number' ? show.year : null,
          tmdbId: text(show.tmdbId),
          imdbId: text(show.imdbId),
        },
        season: Number(p.season),
        episodes: (Array.isArray(p.episodes) ? p.episodes : []).slice(0, 100).map((e) => {
          const ep = (e ?? {}) as Record<string, unknown>;
          return { titleIndex: Number(ep.titleIndex), episode: Number(ep.episode) };
        }),
      });
    }
    case 'kind':
      return ripper.setKind(c.jobId, p.kind === 'tv' ? 'tv' : 'movie');
    case 'retry':
      return ripper.retry(c.jobId);
    case 'dismiss':
      return ripper.dismiss(c.jobId);
    default:
      throw new Error(`Unknown action ${c.action}`);
  }
}

/**
 * Tells the cloud what the ripper is doing every few seconds (more often while
 * it's busy) and carries out actions taken on the cloud Discs page.
 */
export class MacReporter {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private failures = 0;

  constructor(
    private readonly client: CloudClient,
    private readonly ripper: Ripper,
    private readonly log: Log,
  ) {}

  start() {
    this.stopped = false;
    void this.tick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async tick() {
    let busy = false;
    try {
      const jobs = this.ripper.listJobs().map(toPublicJob);
      busy = jobs.some((j) =>
        ['scanning', 'ripping', 'encoding', 'filing', 'importing'].includes(j.status),
      );
      const { commands } = await this.client.call<{ commands: Command[] }>('POST', '/status', {
        health: this.ripper.health(),
        jobs,
      });
      for (const command of commands) {
        let error: string | null = null;
        try {
          await runCommand(this.ripper, command);
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        await this.client.call('POST', `/commands/${command.id}`, { error }).catch(() => undefined);
      }
      if (this.failures > 2) this.log.info('Reaching the cloud again.');
      this.failures = 0;
      // Answer cloud actions quickly after one was taken.
      if (commands.length) busy = true;
    } catch (error) {
      if (++this.failures === 3) {
        this.log.warn(
          'Can’t reach Wheelhouse in the cloud:',
          error instanceof Error ? error.message : error,
        );
      }
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.tick(), busy ? 5_000 : 20_000);
    this.timer?.unref?.();
  }
}
