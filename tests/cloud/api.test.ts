import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyRatings, parseOmdb, refreshRatings } from '../../src/cloud/ratings';
import { Sql } from '../../src/cloud/db';
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

describe('cloud: IMDb ratings', () => {
  afterEach(() => vi.unstubAllGlobals());

  const omdb = (imdbRating: string, rt?: string) => ({
    Response: 'True',
    imdbRating,
    Ratings: [
      { Source: 'Internet Movie Database', Value: `${imdbRating}/10` },
      ...(rt ? [{ Source: 'Rotten Tomatoes', Value: rt }] : []),
    ],
  });

  it('reads IMDb and Rotten Tomatoes scores from OMDb', () => {
    expect(parseOmdb(omdb('8.9', '92%'))).toEqual({ imdb: 8.9, rottenTomatoes: 92 });
    expect(parseOmdb(omdb('N/A'))).toEqual({ imdb: null, rottenTomatoes: null });
    expect(parseOmdb({ Response: 'False', Error: 'Movie not found!' })).toBeNull();
    const summary = { communityRating: 8.5, criticRating: null } as never;
    expect(applyRatings(summary, { imdb: null, rottenTomatoes: null })).toMatchObject({
      communityRating: 8.5,
      ratingSource: 'TMDB',
    });
  });

  it('uses IMDb ratings when a movie is added, and keeps TMDB’s without a key', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      requests.push(url);
      return new Response(JSON.stringify(omdb('8.9', '92%')));
    });
    const c = cloud({ OMDB_API_KEY: 'omdb-key' });
    await signedInAdmin(c);
    await addMovie(c);
    expect(requests[0]).toContain('i=tt0110912');
    const movie = (await (await c.call('GET', '/api/movies/tmdb-680')).json()) as {
      communityRating: number;
      criticRating: number;
      ratingSource: string;
    };
    expect(movie).toMatchObject({ communityRating: 8.9, criticRating: 92, ratingSource: 'IMDb' });

    const plain = cloud();
    await signedInAdmin(plain);
    await addMovie(plain);
    const tmdb = (await (await plain.call('GET', '/api/movies/tmdb-680')).json()) as {
      communityRating: number;
    };
    expect(tmdb.communityRating).toBe(8.5);
    expect((await plain.call('POST', '/api/admin/ratings/refresh')).status).toBe(400);
  });

  it('still adds the movie when OMDb is down, and catches up later', async () => {
    let up = false;
    vi.stubGlobal('fetch', async () =>
      up ? new Response(JSON.stringify(omdb('8.9', '92%'))) : new Response('', { status: 503 }),
    );
    const c = cloud({ OMDB_API_KEY: 'omdb-key' });
    await signedInAdmin(c);
    await addMovie(c);
    up = true;
    const res = await c.call('POST', '/api/admin/ratings/refresh');
    expect(await res.json()).toMatchObject({ checked: 1, updated: 1, remaining: 0 });
    // Checked recently: nothing to do until next month.
    expect(await refreshRatings(c.env, new Sql(c.env.DB))).toMatchObject({ checked: 0 });
    const movie = (await (await c.call('GET', '/api/movies/tmdb-680')).json()) as {
      communityRating: number;
    };
    expect(movie.communityRating).toBe(8.9);
  });
});

describe('cloud: profiles', () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

  it('lets people choose a photo or emoji, colour, tagline and favourite movie', async () => {
    const c = cloud();
    const me = (await signedInAdmin(c)) as { user: { id: string } };
    await addMovie(c);

    const updated = await c.call('PATCH', '/api/profile', {
      body: {
        emoji: '🦖',
        color: '#2A9D8F',
        tagline: '  Horror after midnight ',
        favoriteMovieId: 'tmdb-680',
      },
    });
    expect(await updated.json()).toMatchObject({
      look: { emoji: '🦖', color: '#2a9d8f', image: null },
      tagline: 'Horror after midnight',
      favoriteMovie: { id: 'tmdb-680', title: 'Pulp Fiction' },
    });
    expect((await c.call('PATCH', '/api/profile', { body: { emoji: '💩' } })).status).toBe(400);
    expect(
      (await c.call('PATCH', '/api/profile', { body: { favoriteMovieId: 'nope' } })).status,
    ).toBe(400);

    // A photo: stored privately, shown in the session and on "Who's watching?".
    const put = await c.call('PUT', '/api/profile/avatar', {
      headers: { 'content-type': 'image/jpeg' },
      rawBody: JPEG,
    });
    expect(put.status).toBe(200);
    const { look } = (await put.json()) as { look: { image: string } };
    expect(look.image).toMatch(new RegExp(`^/api/auth/profiles/${me.user.id}/avatar\\?v=`));
    const session = (await (await c.call('GET', '/api/auth/session')).json()) as {
      user: { look: { image: string; emoji: string } };
    };
    expect(session.user.look).toMatchObject({ image: look.image, emoji: '🦖' });

    const profiles = (await (await c.call('GET', '/api/auth/profiles')).json()) as {
      profiles: { look: { image: string }; tagline: string; backdrop: string }[];
    };
    expect(profiles.profiles[0]).toMatchObject({ tagline: 'Horror after midnight' });
    // Signed out, this browser still sees its own profiles' pictures…
    await c.call('POST', '/api/auth/logout');
    const avatar = await c.call('GET', look.image);
    expect(avatar.status).toBe(200);
    expect(new Uint8Array(await avatar.arrayBuffer())).toEqual(JPEG);
    // No backdrop on the test movie: its poster is used instead.
    expect((await c.call('GET', profiles.profiles[0]!.backdrop)).status).toBe(200);
    // …but another browser doesn't.
    expect((await c.call('GET', look.image, { cookies: false })).status).toBe(404);
  });

  it('refuses non-images and oversized photos, and removes the old one', async () => {
    const c = cloud();
    await signedInAdmin(c);
    const bad = await c.call('PUT', '/api/profile/avatar', {
      headers: { 'content-type': 'text/html' },
      rawBody: JPEG,
    });
    expect(bad.status).toBe(400);
    const big = await c.call('PUT', '/api/profile/avatar', {
      headers: { 'content-type': 'image/jpeg' },
      rawBody: new Uint8Array(2 * 1024 * 1024 + 1),
    });
    expect(big.status).toBe(400);
    await c.call('PUT', '/api/profile/avatar', {
      headers: { 'content-type': 'image/jpeg' },
      rawBody: JPEG,
    });
    await c.call('PUT', '/api/profile/avatar', {
      headers: { 'content-type': 'image/png' },
      rawBody: JPEG,
    });
    const stored = (await c.media.list({ prefix: 'avatars/' })).objects;
    expect(stored).toHaveLength(1);
    const removed = await c.call('DELETE', '/api/profile/avatar');
    expect(((await removed.json()) as { look: { image: null } }).look.image).toBeNull();
    expect((await c.media.list({ prefix: 'avatars/' })).objects).toHaveLength(0);
  });
});

describe('cloud: TV shows', () => {
  async function addShow(c: Cloud) {
    await c.media.put('shows/tmdbtv-1396/poster.jpg', new Uint8Array([0xff, 0xd8, 0xff, 9]));
    const show = await c.mac('PUT', '/shows/tmdbtv-1396', {
      tmdbId: '1396',
      show: {
        title: 'Breaking Bad',
        sortTitle: 'breaking bad',
        year: 2008,
        endYear: 2013,
        genres: ['Drama'],
        officialRating: 'TV-MA',
        communityRating: 8.9,
        overview: 'A chemistry teacher…',
        cast: [
          {
            id: '17419',
            name: 'Bryan Cranston',
            role: 'Walter White',
            type: 'Actor',
            imageKey: null,
          },
        ],
        seasons: [
          { number: 1, name: 'Season 1', posterKey: 'shows/tmdbtv-1396/poster.jpg' },
          { number: 2, name: 'Season 2', posterKey: null },
        ],
      },
      images: { poster: 'shows/tmdbtv-1396/poster.jpg', backdrop: null, logo: null },
    });
    expect(show.status).toBe(200);
    for (const [season, number] of [
      [1, 1],
      [1, 2],
      [2, 1],
    ] as const) {
      const id = `tmdbtv-1396-s0${season}e0${number}`;
      await c.media.put(`shows/tmdbtv-1396/${id}.mp4`, VIDEO, {
        httpMetadata: { contentType: 'video/mp4' },
      });
      const res = await c.mac('PUT', `/episodes/${id}`, {
        showId: 'tmdbtv-1396',
        seasonNumber: season,
        number,
        endNumber: null,
        title: `Episode ${season}.${number}`,
        overview: null,
        runtimeMinutes: 47,
        premiereDate: null,
        imageKey: null,
        video: {
          key: `shows/tmdbtv-1396/${id}.mp4`,
          bytes: VIDEO.length,
          sha256: 'feedfacecafe0000',
          durationSeconds: 2820,
        },
        subtitles: [],
        subtitleStatus: 'none',
        sourcePath: null,
      });
      expect(res.status).toBe(200);
    }
  }

  it('lists shows with seasons and episodes, and plays episodes from storage', async () => {
    const c = cloud();
    await signedInAdmin(c);
    await addShow(c);
    const list = (await (await c.call('GET', '/api/shows')).json()) as {
      shows: { id: string; seasonCount: number; episodeCount: number; unwatchedCount: number }[];
      nextUp: unknown[];
    };
    expect(list.shows).toEqual([
      expect.objectContaining({
        id: 'tmdbtv-1396',
        seasonCount: 2,
        episodeCount: 3,
        unwatchedCount: 3,
      }),
    ]);
    expect(list.nextUp).toEqual([]);

    const detail = (await (await c.call('GET', '/api/shows/tmdbtv-1396')).json()) as {
      seasons: { number: number; episodeCount: number; poster: string | null }[];
      episodes: { id: string }[];
      nextUp: { id: string };
      cast: { name: string }[];
    };
    expect(detail.seasons.map((s) => [s.number, s.episodeCount])).toEqual([
      [1, 2],
      [2, 1],
    ]);
    expect(detail.seasons[0]!.poster).toMatch(/^\/api\/media\/shows\/tmdbtv-1396\/poster\.jpg/);
    expect(detail.nextUp.id).toBe('tmdbtv-1396-s01e01');
    expect(detail.cast[0]!.name).toBe('Bryan Cranston');

    const ep = (await (await c.call('GET', '/api/episodes/tmdbtv-1396-s01e02')).json()) as {
      previousId: string;
      nextId: string;
      showTitle: string;
    };
    expect(ep).toMatchObject({
      previousId: 'tmdbtv-1396-s01e01',
      nextId: 'tmdbtv-1396-s02e01',
      showTitle: 'Breaking Bad',
    });

    const info = (await (
      await c.call('POST', '/api/movies/tmdbtv-1396-s01e01/playback', { body: {} })
    ).json()) as { url: string; delivery: string };
    expect(info).toMatchObject({ delivery: 'file' });
    const video = await c.call('GET', info.url, { headers: { range: 'bytes=0-9' } });
    expect(video.status).toBe(206);
  });

  it('remembers watching: next up moves on, and episodes can be marked watched', async () => {
    const c = cloud();
    await signedInAdmin(c);
    await addShow(c);
    const report = { itemId: 'tmdbtv-1396-s01e01', playSessionId: 'p1', positionSeconds: 0 };
    await c.call('POST', '/api/playback/start', { body: report });
    await c.call('POST', '/api/playback/stop', { body: { ...report, positionSeconds: 2800 } });
    const list = (await (await c.call('GET', '/api/shows')).json()) as {
      shows: { unwatchedCount: number }[];
      nextUp: { id: string }[];
    };
    expect(list.shows[0]!.unwatchedCount).toBe(2);
    expect(list.nextUp.map((e) => e.id)).toEqual(['tmdbtv-1396-s01e02']);

    const played = await c.call('PUT', '/api/episodes/tmdbtv-1396-s01e02/played', {
      body: { played: true },
    });
    expect(await played.json()).toMatchObject({ played: true });
    const detail = (await (await c.call('GET', '/api/shows/tmdbtv-1396')).json()) as {
      nextUp: { id: string };
    };
    expect(detail.nextUp.id).toBe('tmdbtv-1396-s02e01');
  });

  it('refuses episodes whose show or video is missing', async () => {
    const c = cloud();
    const res = await c.mac('PUT', '/episodes/tmdbtv-9-s01e01', {
      showId: 'tmdbtv-9',
      seasonNumber: 1,
      number: 1,
      title: 'Pilot',
      video: { key: 'shows/tmdbtv-9/x.mp4', bytes: 1, sha256: 'x', durationSeconds: 1 },
      subtitleStatus: 'none',
    });
    expect(res.status).toBe(400);
  });
});
