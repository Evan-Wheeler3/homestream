import { describe, expect, it } from 'vitest';
import { cloud } from './fakes';
import type { IngestMovie } from '../../src/cloud/mac';

type Cloud = ReturnType<typeof cloud>;

const token = (url: string) => url.split('/invite/')[1]!;

/** The first administrator, signed in. */
async function signedInAdmin(c: Cloud, name = 'Evan') {
  const boot = await c.mac('POST', '/bootstrap', { name });
  expect(boot.status).toBe(200);
  const { url } = (await boot.json()) as { url: string };
  const res = await c.call('POST', `/api/invites/${token(url)}`, {
    body: { username: name.toLowerCase(), password: 'correct horse' },
  });
  expect(res.status).toBe(200);
  return res.json();
}

const VIDEO = new Uint8Array(10_000).map((_, i) => i % 251);

async function addMovie(
  c: Cloud,
  id = 'tmdb-680',
  title = 'Pulp Fiction',
  extra: Partial<IngestMovie> = {},
) {
  await c.media.put(`movies/${id}/video.mp4`, VIDEO, {
    httpMetadata: { contentType: 'video/mp4' },
  });
  await c.media.put(`movies/${id}/poster.jpg`, new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]));
  const body: IngestMovie = {
    tmdbId: id.replace('tmdb-', ''),
    imdbId: 'tt0110912',
    summary: {
      title,
      sortTitle: title.toLowerCase(),
      originalTitle: null,
      year: 1994,
      premiereDate: '1994-09-10',
      runtimeMinutes: 154,
      genres: ['Crime', 'Thriller'],
      directors: ['Quentin Tarantino'],
      actors: ['John Travolta', 'Uma Thurman'],
      studios: ['Miramax'],
      tags: [],
      countries: ['United States of America'],
      officialRating: 'R',
      communityRating: 8.5,
      criticRating: null,
      overview: 'A burger-loving hit man…',
      tagline: null,
      dateAdded: '2026-10-18T00:00:00.000Z',
    },
    detail: {
      cast: [
        { id: null, name: 'John Travolta', role: 'Vincent Vega', type: 'Actor', imageKey: null },
      ],
      trailers: [],
      writers: ['Quentin Tarantino'],
      producers: [],
      mediaInfo: null,
      externalLinks: [],
    },
    images: { poster: `movies/${id}/poster.jpg`, backdrop: null, logo: null },
    video: {
      key: `movies/${id}/video.mp4`,
      bytes: VIDEO.length,
      sha256: 'abc123def4567890',
      durationSeconds: 9240,
    },
    subtitles: [],
    subtitleStatus: 'none',
    franchise: null,
    sourcePath: `/Volumes/LaCie/Movies/${title}/${title}.mp4`,
    ...extra,
  };
  const res = await c.mac('PUT', `/movies/${id}`, body);
  expect(res.status).toBe(200);
}

describe('cloud: invitations and sign-in', () => {
  it('has no public sign-up: only the Mac can make the first administrator, once', async () => {
    const c = cloud();
    expect((await c.call('POST', '/api/mac/bootstrap', { body: { name: 'X' } })).status).toBe(401);
    const session = await signedInAdmin(c);
    expect(session).toMatchObject({ user: { name: 'Evan', isAdmin: true }, source: 'cloud' });
    expect((await c.mac('POST', '/bootstrap', { name: 'Mallory' })).status).toBe(409);
  });

  it('signs in with a username and password, and keeps the session in a secure cookie', async () => {
    const c = cloud();
    await signedInAdmin(c);
    await c.call('POST', '/api/auth/logout');
    expect((await c.call('GET', '/api/auth/session')).status).toBe(401);
    const bad = await c.call('POST', '/api/auth/login', {
      body: { username: 'evan', password: 'nope' },
    });
    expect(bad.status).toBe(401);
    const good = await c.call('POST', '/api/auth/login', {
      body: { username: 'Evan', password: 'correct horse' },
    });
    expect(good.status).toBe(200);
    const cookie = good.headers.getSetCookie().find((x) => x.startsWith('wh_session='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect((await c.call('GET', '/api/auth/session')).status).toBe(200);
    // Only a hash of the session token is stored.
    const token = c.jar.get('wh_session')!;
    const rows = c.db.raw.prepare('SELECT id_hash FROM sessions').all() as { id_hash: string }[];
    expect(rows.some((r) => r.id_hash === token)).toBe(false);
  });

  it('rate-limits password guessing', async () => {
    const c = cloud();
    await signedInAdmin(c);
    let last = 0;
    for (let i = 0; i < 9; i++) {
      last = (
        await c.call('POST', '/api/auth/login', { body: { username: 'evan', password: 'wrong' } })
      ).status;
    }
    expect(last).toBe(403);
    // Even the right password waits until the window passes.
    const right = await c.call('POST', '/api/auth/login', {
      body: { username: 'evan', password: 'correct horse' },
    });
    expect(right.status).toBe(403);
  });

  it('invites a named person with a single-use link that expires and can be revoked', async () => {
    const c = cloud();
    await signedInAdmin(c);
    const made = await c.call('POST', '/api/admin/people', { body: { name: 'Sam', days: 3 } });
    expect(made.status).toBe(201);
    const link = (await made.json()) as {
      url: string;
      expiresAt: string;
      person: { status: string };
    };
    expect(link.person.status).toBe('pending');
    expect(Date.parse(link.expiresAt) - Date.now()).toBeGreaterThan(2.9 * 86_400_000);
    // Only a hash of the invitation token is stored.
    const hashes = c.db.raw.prepare('SELECT token_hash FROM invites').all() as {
      token_hash: string;
    }[];
    expect(hashes.some((h) => h.token_hash === token(link.url))).toBe(false);

    const info = await c.call('GET', `/api/invites/${token(link.url)}`, { cookies: false });
    expect(await info.json()).toMatchObject({ name: 'Sam', kind: 'invite' });

    const short = await c.call('POST', `/api/invites/${token(link.url)}`, {
      cookies: false,
      body: { username: 'sam', password: 'short' },
    });
    expect(short.status).toBe(400);
    const taken = await c.call('POST', `/api/invites/${token(link.url)}`, {
      cookies: false,
      body: { username: 'EVAN', password: 'long enough' },
    });
    expect(taken.status).toBe(409);
    const ok = await c.call('POST', `/api/invites/${token(link.url)}`, {
      cookies: false,
      body: { username: 'sam', password: 'long enough' },
    });
    expect(ok.status).toBe(200);
    const again = await c.call('POST', `/api/invites/${token(link.url)}`, {
      cookies: false,
      body: { username: 'sam2', password: 'long enough' },
    });
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: { message: string } }).error.message).toMatch(
      /already been used/,
    );
  });

  it('refuses expired and revoked links', async () => {
    const c = cloud();
    await signedInAdmin(c);
    const link = (await (
      await c.call('POST', '/api/admin/people', { body: { name: 'Ana' } })
    ).json()) as {
      url: string;
      person: { id: string };
    };
    c.db.raw.prepare(`UPDATE invites SET expires_at = '2000-01-01T00:00:00.000Z'`).run();
    const expired = await c.call('GET', `/api/invites/${token(link.url)}`, { cookies: false });
    expect(((await expired.json()) as { error: { message: string } }).error.message).toMatch(
      /expired/,
    );

    const fresh = (await (
      await c.call('POST', `/api/admin/people/${link.person.id}/link`, { body: {} })
    ).json()) as {
      url: string;
    };
    const people = (await (await c.call('GET', '/api/admin/people')).json()) as {
      people: { name: string; link: { id: string } | null }[];
    };
    const ana = people.people.find((p) => p.name === 'Ana')!;
    expect((await c.call('DELETE', `/api/admin/links/${ana.link!.id}`)).status).toBe(200);
    const revoked = await c.call('GET', `/api/invites/${token(fresh.url)}`, { cookies: false });
    expect(((await revoked.json()) as { error: { message: string } }).error.message).toMatch(
      /cancelled/,
    );
  });

  it('removing someone ends their sessions immediately; reset links set a new password', async () => {
    const admin = cloud();
    await signedInAdmin(admin);
    const link = (await (
      await admin.call('POST', '/api/admin/people', { body: { name: 'Kid' } })
    ).json()) as {
      url: string;
      person: { id: string };
    };
    // Kid's own browser, sharing the same database.
    const kidJar = new Map<string, string>();
    const kid = { ...admin, jar: kidJar };
    const redeem = await admin.app.fetch(
      new Request(`https://wheelhouse.example/api/invites/${token(link.url)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'wheelhouse' },
        body: JSON.stringify({ username: 'kid', password: 'kid password' }),
      }),
      admin.env,
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
    const kidCookie = redeem.headers
      .getSetCookie()
      .find((x) => x.startsWith('wh_session='))!
      .split(';')[0]!;
    const asKid = () =>
      admin.app.fetch(
        new Request('https://wheelhouse.example/api/auth/session', {
          headers: { cookie: kidCookie },
        }),
        admin.env,
        { waitUntil() {}, passThroughOnException() {} } as never,
      );
    expect((await asKid()).status).toBe(200);

    // A reset link: the old password stops working once a new one is set.
    const reset = (await (
      await admin.call('POST', `/api/admin/people/${link.person.id}/link`, { body: {} })
    ).json()) as {
      url: string;
    };
    const info = (await (
      await admin.call('GET', `/api/invites/${token(reset.url)}`, { cookies: false })
    ).json()) as {
      kind: string;
      username: string;
    };
    expect(info).toMatchObject({ kind: 'reset', username: 'kid' });
    expect(kid.jar.size).toBe(0);

    expect((await admin.call('DELETE', `/api/admin/people/${link.person.id}`)).status).toBe(200);
    expect((await asKid()).status).toBe(401);
    expect(
      (await admin.call('DELETE', `/api/admin/people/${await signedInId(admin)}`)).status,
    ).toBe(400);
  });

  it('only shows "Who\'s watching?" profiles that signed in on this browser', async () => {
    const c = cloud();
    expect(await (await c.call('GET', '/api/auth/profiles')).json()).toEqual({ profiles: [] });
    await signedInAdmin(c);
    const res = (await (await c.call('GET', '/api/auth/profiles')).json()) as {
      profiles: { name: string }[];
    };
    expect(res.profiles.map((p) => p.name)).toEqual(['Evan']);
    // Signing in by the profile's display name works too.
    await c.call('POST', '/api/auth/logout');
    expect(
      (
        await c.call('POST', '/api/auth/login', {
          body: { username: 'Evan', password: 'correct horse' },
        })
      ).status,
    ).toBe(200);
  });

  it('needs the CSRF header on changes, like the Mac version', async () => {
    const c = cloud();
    await signedInAdmin(c);
    const res = await c.call('PATCH', '/api/preferences', {
      body: {},
      headers: { 'x-requested-with': 'nope' },
    });
    expect(res.status).toBe(403);
  });

  it('keeps everything private when signed out', async () => {
    const c = cloud();
    await signedInAdmin(c);
    await addMovie(c);
    await c.call('POST', '/api/auth/logout');
    for (const url of [
      '/api/movies',
      '/api/home',
      '/api/media/movies/tmdb-680/video.mp4',
      '/api/admin/people',
    ]) {
      expect((await c.call('GET', url)).status).toBe(401);
    }
  });
});

async function signedInId(c: Cloud) {
  return ((await (await c.call('GET', '/api/auth/session')).json()) as { user: { id: string } })
    .user.id;
}

describe('cloud: library and playback', () => {
  it('lists movies added by the Mac, with details, facets and home rows', async () => {
    const c = cloud();
    await signedInAdmin(c);
    await addMovie(c);
    await addMovie(c, 'tmdb-11', 'Star Wars');
    const page = (await (await c.call('GET', '/api/movies?sort=title')).json()) as {
      items: { id: string; title: string; available: boolean; images: { poster: string } }[];
      total: number;
    };
    expect(page.total).toBe(2);
    expect(page.items[0]).toMatchObject({ title: 'Pulp Fiction', available: true });
    expect(page.items[0]!.images.poster).toBe(
      '/api/media/movies/tmdb-680/poster.jpg?v=abc123def456',
    );
    const detail = (await (await c.call('GET', '/api/movies/tmdb-680')).json()) as {
      cast: { name: string }[];
    };
    expect(detail.cast[0]!.name).toBe('John Travolta');
    const facets = (await (await c.call('GET', '/api/movies/facets')).json()) as {
      genres: { value: string }[];
    };
    expect(facets.genres.map((g) => g.value)).toContain('Crime');
    const home = (await (await c.call('GET', '/api/home')).json()) as {
      libraryCount: number;
      hero: unknown[];
    };
    expect(home.libraryCount).toBe(2);
    const search = (await (await c.call('GET', '/api/movies?q=pulp')).json()) as { total: number };
    expect(search.total).toBe(1);
    const person = await c.call('GET', `/api/people/${encodeURIComponent('Quentin Tarantino')}`);
    expect(person.status).toBe(200);
  });

  it('streams video with Range requests (seeking, resuming, TV browsers)', async () => {
    const c = cloud();
    await signedInAdmin(c);
    await addMovie(c);
    const url = '/api/media/movies/tmdb-680/video.mp4';

    const whole = await c.call('GET', url);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(whole.headers.get('content-length')).toBe('10000');
    expect(whole.headers.get('content-type')).toBe('video/mp4');
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(VIDEO);

    const part = await c.call('GET', url, { headers: { range: 'bytes=100-199' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 100-199/10000');
    expect(part.headers.get('content-length')).toBe('100');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(VIDEO.slice(100, 200));

    const open = await c.call('GET', url, { headers: { range: 'bytes=9990-' } });
    expect(open.headers.get('content-range')).toBe('bytes 9990-9999/10000');
    expect((await open.arrayBuffer()).byteLength).toBe(10);

    const suffix = await c.call('GET', url, { headers: { range: 'bytes=-500' } });
    expect(suffix.headers.get('content-range')).toBe('bytes 9500-9999/10000');

    const pastEnd = await c.call('GET', url, { headers: { range: 'bytes=20000-' } });
    expect(pastEnd.status).toBe(416);
    expect(pastEnd.headers.get('content-range')).toBe('bytes */10000');

    const clipped = await c.call('GET', url, { headers: { range: 'bytes=9000-99999' } });
    expect(clipped.headers.get('content-range')).toBe('bytes 9000-9999/10000');

    const head = await c.call('HEAD', url);
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('10000');

    const etag = whole.headers.get('etag')!;
    const cached = await c.call('GET', url, { headers: { 'if-none-match': etag } });
    expect(cached.status).toBe(304);

    // Nothing outside the media folders can be fetched this way.
    await c.media.put('backups/x.json', '{}');
    expect((await c.call('GET', '/api/media/backups/x.json')).status).toBe(404);
    expect((await c.call('GET', '/api/media/movies/..%2F..%2Fbackups/x.json')).status).toBe(404);
  });

  it('plays straight from storage, remembers where you stopped, and records history', async () => {
    const c = cloud();
    await signedInAdmin(c);
    await addMovie(c);
    const info = (await (
      await c.call('POST', '/api/movies/tmdb-680/playback', { body: { startSeconds: 0 } })
    ).json()) as {
      url: string;
      method: string;
      delivery: string;
      playSessionId: string;
      selectedSubtitleIndex: number | null;
    };
    expect(info).toMatchObject({
      method: 'DirectPlay',
      delivery: 'file',
      selectedSubtitleIndex: null,
    });
    expect(info.url).toMatch(/^\/api\/media\/movies\/tmdb-680\/video\.mp4/);
    const report = (positionSeconds: number) => ({
      itemId: 'tmdb-680',
      playSessionId: info.playSessionId,
      positionSeconds,
      isPaused: false,
    });
    await c.call('POST', '/api/playback/start', { body: report(0) });
    await c.call('POST', '/api/playback/progress', { body: report(600) });
    const status = (await (await c.call('GET', '/api/status')).json()) as {
      watching: { title: string }[];
    };
    expect(status.watching.map((w) => w.title)).toEqual(['Pulp Fiction']);
    const stop = (await (
      await c.call('POST', '/api/playback/stop', { body: report(1200) })
    ).json()) as {
      user: { positionSeconds: number; played: boolean };
    };
    expect(stop.user).toMatchObject({ positionSeconds: 1200, played: false });
    const home = (await (await c.call('GET', '/api/home')).json()) as {
      sections: { type: string; row?: { id: string } }[];
    };
    expect(home.sections.some((s) => s.row?.id === 'continueWatching')).toBe(true);

    // Finishing it marks it watched and counts for Wrapped.
    await c.call('POST', '/api/playback/start', { body: report(1200) });
    await c.call('POST', '/api/playback/stop', { body: report(9100) });
    const detail = (await (await c.call('GET', '/api/movies/tmdb-680')).json()) as {
      user: { played: boolean; positionSeconds: number; playCount: number };
    };
    expect(detail.user).toMatchObject({ played: true, positionSeconds: 0, playCount: 1 });
    const wrapped = (await (await c.call('GET', '/api/wrapped?year=all')).json()) as {
      moviesWatched: number;
    };
    expect(wrapped.moviesWatched).toBe(1);
  });

  it('keeps per-person data: favourites, ratings, watchlist and collections', async () => {
    const c = cloud();
    await signedInAdmin(c);
    await addMovie(c);
    await c.call('PUT', '/api/movies/tmdb-680/favorite', { body: { favorite: true } });
    await c.call('PUT', '/api/movies/tmdb-680/personal', {
      body: { rating: 5, notes: 'Royale with cheese' },
    });
    await c.call('PUT', '/api/movies/tmdb-680/watchlist', { body: { on: true } });
    const collections = (await (await c.call('GET', '/api/collections')).json()) as {
      id: string;
      name: string;
      itemCount: number;
    }[];
    expect(collections.find((x) => x.name === 'Personal Favorites')?.itemCount).toBe(1);
    expect(collections.find((x) => x.name === '1990s Cinema')?.itemCount).toBe(1);
    const rewatch = collections.find((x) => x.name === 'Movies to Rewatch')!;
    const added = (await (
      await c.call('POST', `/api/collections/${rewatch.id}/items`, {
        body: { itemIds: ['tmdb-680'] },
      })
    ).json()) as {
      movies: unknown[];
    };
    expect(added.movies).toHaveLength(1);
    const detail = (await (await c.call('GET', '/api/movies/tmdb-680')).json()) as {
      personal: { rating: number };
      onWatchlist: boolean;
      collections: { name: string }[];
      user: { favorite: boolean };
    };
    expect(detail).toMatchObject({
      personal: { rating: 5 },
      onWatchlist: true,
      user: { favorite: true },
    });
    expect(detail.collections.map((x) => x.name)).toEqual(['Movies to Rewatch']);
  });

  it('runs movie night, including voting from the public /vote page', async () => {
    const c = cloud();
    await signedInAdmin(c);
    await addMovie(c);
    await addMovie(c, 'tmdb-11', 'Star Wars');
    const night = (await (
      await c.call('POST', '/api/nights', { body: { count: 2, pool: 'all' } })
    ).json()) as {
      id: string;
      code: string;
    };
    const vote = await c.call('POST', `/api/public/nights/${night.code}/vote`, {
      cookies: false,
      body: { voterKey: 'guest-key-123', name: 'Guest', itemId: 'tmdb-11' },
    });
    expect(vote.status).toBe(200);
    const closed = (await (await c.call('POST', `/api/nights/${night.id}/close`)).json()) as {
      winners: string[];
    };
    expect(closed.winners).toEqual(['tmdb-11']);
  });

  it('takes requests, and marks them added when the Mac adds the movie', async () => {
    const c = cloud();
    await signedInAdmin(c);
    const made = await c.call('POST', '/api/requests', {
      body: { title: 'Pulp Fiction', year: 1994 },
    });
    expect(made.status).toBe(201);
    await addMovie(c);
    const list = (await (await c.call('GET', '/api/requests')).json()) as {
      requests: { status: string; itemId: string }[];
    };
    expect(list.requests[0]).toMatchObject({ status: 'added', itemId: 'tmdb-680' });
  });
});

describe('cloud: the Mac', () => {
  it('needs the Mac token, and checks the video is really uploaded', async () => {
    const c = cloud();
    const wrong = await c.call('GET', '/api/mac/movies', {
      cookies: false,
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.status).toBe(401);
    const res = await c.mac('PUT', '/movies/tmdb-1', {
      summary: { title: 'Ghost' },
      video: { key: 'movies/tmdb-1/video.mp4', bytes: 10, sha256: 'x' },
      images: { poster: null, backdrop: null, logo: null },
      detail: { cast: [] },
    });
    expect(res.status).toBe(400);
  });

  it('shows the Mac’s rip progress, "offline" when it stops reporting, and queues actions for it', async () => {
    const c = cloud();
    await signedInAdmin(c);
    const empty = (await (await c.call('GET', '/api/rips')).json()) as { mac: { online: boolean } };
    expect(empty.mac.online).toBe(false);
    const job = {
      id: '6f0b8e1c-1111-4222-8333-444455556666',
      status: 'needs_choice',
      kind: 'movie',
      discLabel: 'PULP_FICTION',
      progress: null,
      message: null,
      guess: 'Pulp Fiction',
      title: null,
      year: null,
      candidates: [],
      discTitles: [],
      moviePath: null,
      movieId: null,
      season: null,
      episodes: [],
      createdAt: '',
      updatedAt: '',
      finishedAt: null,
    };
    const health = { enabled: true, problems: [], warnings: [], watching: true, canSearch: true };
    expect((await c.mac('POST', '/status', { health, jobs: [job] })).status).toBe(200);
    const rips = (await (await c.call('GET', '/api/rips')).json()) as {
      mac: { online: boolean };
      jobs: unknown[];
    };
    expect(rips.mac.online).toBe(true);
    expect(rips.jobs).toHaveLength(1);

    const chose = await c.call('POST', `/api/rips/${job.id}/choose`, { body: { titleIndex: 2 } });
    expect(chose.status).toBe(200);
    const next = (await (await c.mac('POST', '/status', { health, jobs: [job] })).json()) as {
      commands: { action: string; payload: { titleIndex: number } }[];
    };
    expect(next.commands).toMatchObject([{ action: 'choose', payload: { titleIndex: 2 } }]);
    // Handed over once only.
    const after = (await (await c.mac('POST', '/status', { health, jobs: [job] })).json()) as {
      commands: unknown[];
    };
    expect(after.commands).toHaveLength(0);

    c.db.raw.prepare(`UPDATE mac_status SET updated_at = '2000-01-01T00:00:00.000Z'`).run();
    const offline = (await (await c.call('GET', '/api/rips')).json()) as {
      mac: { online: boolean };
    };
    expect(offline.mac.online).toBe(false);
    expect((await c.call('POST', `/api/rips/${job.id}/retry`, { body: {} })).status).toBe(400);
  });

  it('imports a person’s data as a pending invite, and again without duplicates', async () => {
    const c = cloud();
    await signedInAdmin(c);
    await addMovie(c);
    const person = {
      name: 'Sam',
      state: [{ itemId: 'tmdb-680', played: true, favorite: true, playCount: 2 }],
      watchlist: [{ itemId: 'tmdb-680', addedAt: '2026-01-01T00:00:00.000Z' }],
      personal: [
        { itemId: 'tmdb-680', rating: 4, notes: 'Great', updatedAt: '2026-01-01T00:00:00.000Z' },
      ],
      events: [
        { itemId: 'tmdb-680', at: '2026-02-01T00:00:00.000Z', seconds: 9000, finished: true },
      ],
      collections: [
        {
          name: 'Tarantino',
          description: '',
          kind: 'manual',
          rules: null,
          visibility: 'private',
          position: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          items: ['tmdb-680'],
        },
      ],
    };
    const first = (await (await c.mac('POST', '/import/person', person)).json()) as {
      created: boolean;
    };
    expect(first.created).toBe(true);
    const second = (await (await c.mac('POST', '/import/person', person)).json()) as {
      created: boolean;
    };
    expect(second.created).toBe(false);
    const count = (table: string) =>
      (c.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count('watch_events')).toBe(1);
    expect(count('collection_items')).toBe(1);
    const people = (await (await c.call('GET', '/api/admin/people')).json()) as {
      people: { name: string; status: string }[];
    };
    expect(people.people.find((p) => p.name === 'Sam')?.status).toBe('pending');
  });
});

describe('cloud: administration', () => {
  it('reports storage and cost, and backs up to R2 keeping the newest 14', async () => {
    const c = cloud({ BACKUPS_KEEP: '2' });
    await signedInAdmin(c);
    await addMovie(c);
    const storage = (await (await c.call('GET', '/api/admin/storage')).json()) as {
      movies: number;
      bytes: number;
      monthlyUsd: number;
    };
    expect(storage).toMatchObject({ movies: 1, monthlyUsd: 0 });
    expect(storage.bytes).toBeGreaterThan(10_000);
    for (let i = 0; i < 3; i++) {
      await c.call('POST', '/api/admin/backups');
      await new Promise((r) => setTimeout(r, 5));
    }
    const { backups } = (await (await c.call('GET', '/api/admin/backups')).json()) as {
      backups: { key: string }[];
    };
    expect(backups).toHaveLength(2);
    const body = JSON.parse(
      await ((await c.media.get(backups[0]!.key)) as unknown as { text(): Promise<string> }).text(),
    ) as {
      tables: { users: Record<string, unknown>[] };
    };
    expect(body.tables.users[0]).not.toHaveProperty('password_hash');
  });

  it('lets only administrators manage people', async () => {
    const c = cloud();
    await signedInAdmin(c);
    const link = (await (
      await c.call('POST', '/api/admin/people', { body: { name: 'Sam' } })
    ).json()) as { url: string };
    await c.call('POST', '/api/auth/logout');
    await c.call('POST', `/api/invites/${token(link.url)}`, {
      body: { username: 'sam', password: 'long enough' },
    });
    expect((await c.call('GET', '/api/admin/people')).status).toBe(403);
    expect((await c.call('GET', '/api/rips')).status).toBe(403);
  });
});
