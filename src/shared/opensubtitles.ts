// A small OpenSubtitles.com REST client (plain fetch), used by the Worker's
// "Find subtitles" button, the upload command and the Mac's ripper.
import { checkTiming, toWebVtt, type TimingCheck } from './subtitles.js';

const API = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = 'Wheelhouse v1.0';

export interface OpenSubtitlesCredentials {
  apiKey: string;
  username: string;
  password: string;
}

export interface SubtitleCandidate {
  fileId: number;
  release: string;
  downloads: number;
  hearingImpaired: boolean;
  fps: number | null;
  fromTrusted: boolean;
  machineTranslated: boolean;
}

export interface FoundSubtitle {
  vtt: string;
  candidate: SubtitleCandidate;
  timing: TimingCheck;
}

interface SearchResponse {
  data?: {
    attributes: {
      release?: string;
      download_count?: number;
      hearing_impaired?: boolean;
      fps?: number;
      from_trusted?: boolean;
      machine_translated?: boolean;
      ai_translated?: boolean;
      files?: { file_id: number }[];
    };
  }[];
}

export class OpenSubtitles {
  private token: string | null = null;
  private base = API;

  constructor(
    private readonly credentials: OpenSubtitlesCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(auth = false): Record<string, string> {
    return {
      'Api-Key': this.credentials.apiKey,
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(auth && this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  private async login() {
    if (this.token) return;
    const res = await this.fetchImpl(`${API}/login`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        username: this.credentials.username,
        password: this.credentials.password,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      token?: string;
      base_url?: string;
      message?: string;
    };
    if (!res.ok || !body.token) {
      throw new Error(`OpenSubtitles sign-in failed: ${body.message ?? res.status}`);
    }
    this.token = body.token;
    if (body.base_url) this.base = `https://${body.base_url.replace(/^https?:\/\//, '')}/api/v1`;
  }

  /** English subtitles for a movie, best first: trusted, not machine-made, most downloaded. */
  async search(ids: { imdbId?: string | null; tmdbId?: string | null }, language = 'en') {
    const params = new URLSearchParams({ languages: language, type: 'movie' });
    if (ids.imdbId) params.set('imdb_id', ids.imdbId.replace(/^tt/, '').replace(/^0+/, ''));
    else if (ids.tmdbId) params.set('tmdb_id', ids.tmdbId);
    else return [];
    const res = await this.fetchImpl(`${API}/subtitles?${params}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`OpenSubtitles search failed (${res.status})`);
    const body = (await res.json()) as SearchResponse;
    const candidates: SubtitleCandidate[] = [];
    for (const item of body.data ?? []) {
      const a = item.attributes;
      const fileId = a.files?.[0]?.file_id;
      if (!fileId) continue;
      candidates.push({
        fileId,
        release: a.release ?? '',
        downloads: a.download_count ?? 0,
        hearingImpaired: Boolean(a.hearing_impaired),
        fps: a.fps || null,
        fromTrusted: Boolean(a.from_trusted),
        machineTranslated: Boolean(a.machine_translated || a.ai_translated),
      });
    }
    const score = (c: SubtitleCandidate) =>
      (c.machineTranslated ? -1e9 : 0) +
      (c.fromTrusted ? 1e6 : 0) +
      (c.hearingImpaired ? -1e3 : 0) +
      Math.log10(c.downloads + 1) * 100 +
      // DVD and Blu-ray releases are the most likely to match a disc's timing.
      (/dvd|bluray|blu-ray|bdrip|brrip/i.test(c.release) ? 50 : 0);
    return candidates.sort((x, y) => score(y) - score(x));
  }

  /** Downloads one file (uses one of the account's daily downloads). */
  async download(fileId: number): Promise<string> {
    await this.login();
    const res = await this.fetchImpl(`${this.base}/download`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ file_id: fileId, sub_format: 'srt' }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      link?: string;
      message?: string;
      remaining?: number;
    };
    if (!res.ok || !body.link) {
      throw new Error(
        res.status === 406
          ? 'Today’s OpenSubtitles download allowance is used up. Try again tomorrow.'
          : `OpenSubtitles download failed: ${body.message ?? res.status}`,
      );
    }
    const file = await this.fetchImpl(body.link);
    if (!file.ok) throw new Error(`OpenSubtitles file download failed (${file.status})`);
    return file.text();
  }

  /**
   * The first of the best few candidates whose timing fits the movie's length.
   * Each try uses a download, so at most `maxTries` are spent.
   */
  async findBest(
    ids: { imdbId?: string | null; tmdbId?: string | null },
    durationSeconds: number | null,
    options: { maxTries?: number; skipFileIds?: number[]; fileId?: number } = {},
  ): Promise<FoundSubtitle | null> {
    let candidates = await this.search(ids);
    if (options.fileId) candidates = candidates.filter((c) => c.fileId === options.fileId);
    const skip = new Set(options.skipFileIds ?? []);
    candidates = candidates.filter((c) => !skip.has(c.fileId) && !c.machineTranslated);
    for (const candidate of candidates.slice(0, options.maxTries ?? 3)) {
      const srt = await this.download(candidate.fileId);
      const timing = checkTiming(srt, durationSeconds);
      if (timing.ok || options.fileId) return { vtt: toWebVtt(srt), candidate, timing };
    }
    return null;
  }
}
