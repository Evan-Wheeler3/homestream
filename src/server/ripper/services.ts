import type { RipCandidate } from '../../shared/types.js';
import type { Runner } from './process.js';

/**
 * Jellyfin calls the ripper makes with an API key (created in Jellyfin's
 * Dashboard → API Keys), independent of anyone being signed in.
 */
export class JellyfinAdmin {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly version: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(path: string, init: { method?: string; body?: unknown } = {}) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        Authorization:
          `MediaBrowser Client="Wheelhouse", Device="Wheelhouse disc ripper", ` +
          `DeviceId="wheelhouse-ripper", Version="${this.version}", Token="${this.apiKey}"`,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error('Jellyfin rejected the API key (check JELLYFIN_API_KEY).');
    }
    if (!response.ok) throw new Error(`Jellyfin answered ${response.status} for ${path}`);
    return response;
  }

  async check(): Promise<void> {
    await this.request('/System/Info');
  }

  /** Look a title up in Jellyfin's metadata providers (TMDB etc). */
  searchMovies(name: string, year?: number | null): Promise<RipCandidate[]> {
    return this.remoteSearch('Movie', name, year);
  }

  /** Look a TV show up in Jellyfin's metadata providers. */
  searchShows(name: string, year?: number | null): Promise<RipCandidate[]> {
    return this.remoteSearch('Series', name, year);
  }

  private async remoteSearch(
    type: 'Movie' | 'Series',
    name: string,
    year?: number | null,
  ): Promise<RipCandidate[]> {
    const response = await this.request(`/Items/RemoteSearch/${type}`, {
      method: 'POST',
      body: {
        SearchInfo: { Name: name, ...(year ? { Year: year } : {}) },
        IncludeDisabledProviders: true,
      },
    });
    const results = (await response.json()) as {
      Name?: string;
      ProductionYear?: number;
      PremiereDate?: string;
      ProviderIds?: Record<string, string>;
    }[];
    const seen = new Set<string>();
    const candidates: RipCandidate[] = [];
    for (const r of Array.isArray(results) ? results : []) {
      if (!r.Name) continue;
      const ids = Object.fromEntries(
        Object.entries(r.ProviderIds ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      );
      const year =
        r.ProductionYear ?? (r.PremiereDate ? Number(r.PremiereDate.slice(0, 4)) || null : null);
      const key = ids.tmdb ?? `${r.Name}|${year}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        title: r.Name,
        year: year ?? null,
        tmdbId: ids.tmdb ?? null,
        imdbId: ids.imdb ?? null,
      });
    }
    return candidates;
  }

  async refreshLibrary(): Promise<void> {
    await this.request('/Library/Refresh', { method: 'POST' });
  }

  /** Find the movie Jellyfin created for a file, by its folder name. */
  findMovieByFolder(searchTitle: string, folder: string): Promise<string | null> {
    return this.findByFolder('Movie', searchTitle, folder);
  }

  /** Find the show Jellyfin created for a folder of episodes. */
  findShowByFolder(searchTitle: string, folder: string): Promise<string | null> {
    return this.findByFolder('Series', searchTitle, folder);
  }

  /** Folders of Jellyfin's libraries of one kind (e.g. "tvshows"). */
  async libraryFolders(collectionType: string): Promise<string[]> {
    const response = await this.request('/Library/VirtualFolders');
    const libraries = (await response.json()) as {
      CollectionType?: string;
      Locations?: string[];
    }[];
    return (Array.isArray(libraries) ? libraries : [])
      .filter((l) => l.CollectionType === collectionType)
      .flatMap((l) => l.Locations ?? []);
  }

  private async findByFolder(
    type: 'Movie' | 'Series',
    searchTitle: string,
    folder: string,
  ): Promise<string | null> {
    const params = new URLSearchParams({
      Recursive: 'true',
      IncludeItemTypes: type,
      Fields: 'Path',
      SearchTerm: searchTitle,
      Limit: '50',
    });
    const response = await this.request(`/Items?${params}`);
    const body = (await response.json()) as { Items?: { Id?: string; Path?: string }[] };
    const match = (body.Items ?? []).find((item) => item.Path?.split(/[\\/]/).includes(folder));
    return match?.Id ?? null;
  }
}

// -----------------------------------------------------------------------------
// Notifications

export interface Notification {
  title: string;
  message: string;
  /** Opened when the notification is tapped. */
  click?: string;
  priority?: 'low' | 'default' | 'high';
  tags?: string[];
}

export interface Notifier {
  send(notification: Notification): Promise<void>;
}

const PRIORITY = { low: 2, default: 3, high: 4 } as const;

/** Phone notifications through ntfy (https://ntfy.sh): free, no account. */
export class NtfyNotifier implements Notifier {
  constructor(
    private readonly server: string,
    private readonly topic: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(n: Notification): Promise<void> {
    // JSON publishing keeps titles with accents intact (HTTP headers would not).
    const response = await this.fetchImpl(this.server.replace(/\/+$/, ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: this.topic,
        title: n.title,
        message: n.message,
        priority: PRIORITY[n.priority ?? 'default'],
        tags: n.tags ?? [],
        ...(n.click ? { click: n.click } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`ntfy answered ${response.status}`);
  }
}

/** A notification in the Mac's Notification Center (no-op on other systems). */
export class MacNotifier implements Notifier {
  constructor(private readonly run: Runner) {}

  async send(n: Notification): Promise<void> {
    if (process.platform !== 'darwin') return;
    // Text is passed as arguments, never spliced into the script.
    await this.run('/usr/bin/osascript', [
      '-e',
      'on run argv',
      '-e',
      'display notification (item 2 of argv) with title (item 1 of argv)',
      '-e',
      'end run',
      n.title,
      n.message,
    ]);
  }
}

/** Sends to every notifier; one failing never stops the others. */
export class MultiNotifier implements Notifier {
  constructor(
    private readonly notifiers: Notifier[],
    private readonly logger: Pick<Console, 'warn'> = console,
  ) {}

  async send(n: Notification): Promise<void> {
    const results = await Promise.allSettled(this.notifiers.map((x) => x.send(n)));
    for (const r of results) {
      if (r.status === 'rejected') this.logger.warn('Notification failed:', r.reason);
    }
  }
}
