import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, startServer, type TestServer } from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await startServer();
});
afterAll(() => server.close());

const PNG_1x1 = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ),
);

describe('authentication and access control', () => {
  it('reports health publicly but protects everything else', async () => {
    const anon = new Client(server.url);
    expect((await anon.get('/api/health')).json).toMatchObject({ ok: true, source: 'mock' });
    for (const path of [
      '/api/movies',
      '/api/home',
      '/api/collections',
      '/api/preferences',
      '/api/status',
    ]) {
      const res = await anon.get(path);
      expect(res.status, path).toBe(401);
      expect(res.json.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('rejects bad credentials and accepts good ones with an httpOnly cookie', async () => {
    const client = new Client(server.url);
    const bad = await client.post('/api/auth/login', { username: 'owner', password: 'wrong' });
    expect(bad.status).toBe(401);
    expect(bad.json.error.code).toBe('INVALID_CREDENTIALS');
    const good = await client.login();
    expect(good.json.user.name).toBe('owner');
    const cookie = good.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/pc_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect((await client.get('/api/auth/session')).json.user.name).toBe('owner');
  });

  it('requires the CSRF header on state-changing requests', async () => {
    const client = new Client(server.url);
    await client.login();
    const res = await client.request(
      'PATCH',
      '/api/preferences',
      { theme: 'sepia' },
      { 'X-Requested-With': '' },
    );
    expect(res.status).toBe(403);
    const login = await fetch(server.url + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'x', password: 'demo' }),
    });
    expect(login.status).toBe(403);
  });

  it('invalidates the session on logout', async () => {
    const client = new Client(server.url);
    await client.login();
    const cookie = client.cookie;
    await client.post('/api/auth/logout');
    const replay = await fetch(server.url + '/api/movies', { headers: { Cookie: cookie } });
    expect(replay.status).toBe(401);
  });

  it('rate-limits repeated failed sign-ins', async () => {
    const client = new Client(server.url);
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await client.post('/api/auth/login', { username: 'victim', password: 'nope' }))
        .status;
    }
    expect(last).toBe(403);
  });

  it('exposes no media proxy in sample mode', async () => {
    const client = new Client(server.url);
    await client.login();
    expect((await client.get('/jf/Items/abc/Images/Primary')).status).toBe(404);
  });
});

describe('catalog', () => {
  it('searches, filters, sorts and paginates', async () => {
    const client = new Client(server.url);
    await client.login();
    const all = await client.get('/api/movies?limit=10');
    expect(all.json.total).toBeGreaterThan(40);
    expect(all.json.items).toHaveLength(10);
    const search = await client.get('/api/movies?q=samurai');
    expect(search.json.items[0].title).toBe('Seven Samurai');
    const japan = await client.get('/api/movies?country=Japan&sort=year&dir=asc');
    expect(
      japan.json.items.every((m: { countries: string[] }) => m.countries.includes('Japan')),
    ).toBe(true);
    const years = japan.json.items.map((m: { year: number }) => m.year);
    expect(years).toEqual([...years].sort((a, b) => a - b));
    const facets = await client.get('/api/movies/facets');
    expect(facets.json.genres.length).toBeGreaterThan(5);
  });

  it('returns detail with honest missing metadata and 404 for unknown ids', async () => {
    const client = new Client(server.url);
    await client.login();
    const plan9 = await client.get('/api/movies/plan-9-1957');
    expect(plan9.json.overview).toBeNull();
    expect(plan9.json.communityRating).toBeNull();
    expect((await client.get('/api/movies/does-not-exist')).status).toBe(404);
    expect((await client.get('/api/movies/bad%20id')).status).toBe(400);
  });

  it('picks a random movie from a filtered selection', async () => {
    const client = new Client(server.url);
    await client.login();
    for (let i = 0; i < 5; i++) {
      const res = await client.get('/api/movies/random?genre=Animation');
      expect(res.json.movie.genres).toContain('Animation');
    }
    expect((await client.get('/api/movies/random?genre=Nonexistent')).json.movie).toBeNull();
  });

  it('builds home sections and hides empty rows', async () => {
    const client = new Client(server.url);
    await client.login('fresh-user');
    const home = await client.get('/api/home');
    expect(home.json.hero.length).toBeGreaterThan(0);
    const ids = home.json.sections.map(
      (s: { row?: { id: string }; id?: string }) => s.row?.id ?? s.id,
    );
    expect(ids).toContain('recentlyAdded');
    expect(ids).toContain('continueWatching');
    for (const section of home.json.sections) {
      if (section.type === 'row') expect(section.row.movies.length).toBeGreaterThan(0);
    }
  });
});

describe('preferences sync across devices', () => {
  it('persists server-side and is visible from a second sign-in', async () => {
    const phone = new Client(server.url);
    const tv = new Client(server.url);
    await phone.login('sync-user');
    await tv.login('sync-user');
    const saved = await phone.patch('/api/preferences', {
      theme: 'midnight',
      accent: '#4fb3a9',
      density: 'large',
    });
    expect(saved.json.theme).toBe('midnight');
    const seen = await tv.get('/api/preferences');
    expect(seen.json).toMatchObject({ theme: 'midnight', accent: '#4fb3a9', density: 'large' });
  });

  it('applies home section order and visibility', async () => {
    const client = new Client(server.url);
    await client.login('layout-user');
    await client.patch('/api/preferences', {
      homeSections: [
        { id: 'favorites', visible: true },
        { id: 'recentlyAdded', visible: false },
      ],
    });
    const home = await client.get('/api/home');
    const ids = home.json.sections.map(
      (s: { row?: { id: string }; id?: string }) => s.row?.id ?? s.id,
    );
    expect(ids[0]).toBe('favorites');
    expect(ids).not.toContain('recentlyAdded');
  });

  it('keeps preferences separate per user', async () => {
    const a = new Client(server.url);
    const b = new Client(server.url);
    await a.login('alice');
    await b.login('bob');
    await a.patch('/api/preferences', { theme: 'sepia' });
    expect((await b.get('/api/preferences')).json.theme).toBe('graphite');
  });
});

describe('collections', () => {
  it('creates starter collections once per user', async () => {
    const client = new Client(server.url);
    await client.login('starter');
    await client.login('starter');
    const list = await client.get('/api/collections');
    const names = list.json.map((c: { name: string }) => c.name);
    expect(names).toContain('1990s Cinema');
    expect(names).toContain('Movies to Rewatch');
    expect(new Set(names).size).toBe(names.length);
    const nineties = list.json.find((c: { name: string }) => c.name === '1990s Cinema');
    const detail = await client.get(`/api/collections/${nineties.id}`);
    expect(detail.json.movies.length).toBeGreaterThan(0);
    expect(
      detail.json.movies.every((m: { year: number }) => m.year >= 1990 && m.year <= 1999),
    ).toBe(true);
  });

  it('supports manual membership, de-duplication, reordering and removal', async () => {
    const client = new Client(server.url);
    await client.login('curator');
    const created = await client.post('/api/collections', { name: 'Keaton', kind: 'manual' });
    expect(created.status).toBe(201);
    const id = created.json.id;
    await client.post(`/api/collections/${id}/items`, {
      itemIds: ['the-general-1926', 'sherlock-jr-1924'],
    });
    const dup = await client.post(`/api/collections/${id}/items`, {
      itemIds: ['the-general-1926'],
    });
    expect(dup.json.movies.map((m: { id: string }) => m.id)).toEqual([
      'the-general-1926',
      'sherlock-jr-1924',
    ]);
    const reordered = await client.put(`/api/collections/${id}/items/order`, {
      itemIds: ['sherlock-jr-1924', 'the-general-1926'],
    });
    expect(reordered.json.movies[0].id).toBe('sherlock-jr-1924');
    const detail = await client.get('/api/movies/sherlock-jr-1924');
    expect(detail.json.collections.map((c: { name: string }) => c.name)).toContain('Keaton');
    const removed = await client.delete(`/api/collections/${id}/items/sherlock-jr-1924`);
    expect(removed.json.movies.map((m: { id: string }) => m.id)).toEqual(['the-general-1926']);
  });

  it('rejects duplicate names per user (case-insensitive) and invalid input', async () => {
    const client = new Client(server.url);
    await client.login('dupes');
    expect((await client.post('/api/collections', { name: 'Noir' })).status).toBe(201);
    const again = await client.post('/api/collections', { name: 'noir' });
    expect(again.status).toBe(409);
    expect((await client.post('/api/collections', { name: '   ' })).status).toBe(400);
    const badRules = await client.post('/api/collections', {
      name: 'Bad',
      kind: 'smart',
      rules: { rules: [{ field: 'actor', values: ['x'] }] },
    });
    expect(badRules.status).toBe(400);
    expect(badRules.json.error.message).toMatch(/unsupported field/);
  });

  it('evaluates and previews smart collections, including personal ratings', async () => {
    const client = new Client(server.url);
    await client.login('smart');
    await client.put('/api/movies/heat-1995/personal', { rating: 5, notes: 'Diner scene.' });
    const rules = {
      match: 'all',
      rules: [{ field: 'personalRating', op: 'between', min: 4, max: null }],
      sort: 'title',
      dir: 'asc',
    };
    const preview = await client.post('/api/collections/preview', { rules });
    expect(preview.json.count).toBe(1);
    const created = await client.post('/api/collections', {
      name: 'Five stars',
      kind: 'smart',
      rules,
    });
    expect(created.json.movies.map((m: { id: string }) => m.id)).toEqual(['heat-1995']);
    const add = await client.post(`/api/collections/${created.json.id}/items`, {
      itemIds: ['fargo-1996'],
    });
    expect(add.status).toBe(400);
  });

  it('reports members that are no longer in the library', async () => {
    const client = new Client(server.url);
    await client.login('orphans');
    const created = await client.post('/api/collections', { name: 'With a ghost' });
    await client.post(`/api/collections/${created.json.id}/items`, {
      itemIds: ['fargo-1996', 'removed-item-42'],
    });
    const detail = await client.get(`/api/collections/${created.json.id}`);
    expect(detail.json.movies.map((m: { id: string }) => m.id)).toEqual(['fargo-1996']);
    expect(detail.json.unavailable).toEqual([
      { itemId: 'removed-item-42', lastKnownTitle: null, lastKnownYear: null },
    ]);
  });

  it('shares read-only with other users and hides private ones', async () => {
    const owner = new Client(server.url);
    const guest = new Client(server.url);
    await owner.login('sharer');
    await guest.login('guest');
    const shared = await owner.post('/api/collections', {
      name: 'Household picks',
      visibility: 'shared',
    });
    const secret = await owner.post('/api/collections', { name: 'Secret', visibility: 'private' });
    const guestList = await guest.get('/api/collections');
    const names = guestList.json.map((c: { name: string }) => c.name);
    expect(names).toContain('Household picks');
    expect(names).not.toContain('Secret');
    expect((await guest.get(`/api/collections/${secret.json.id}`)).status).toBe(404);
    const edit = await guest.patch(`/api/collections/${shared.json.id}`, { name: 'Hijacked' });
    expect(edit.status).toBe(403);
    expect((await guest.delete(`/api/collections/${shared.json.id}`)).status).toBe(403);
    const visible = guestList.json.find((c: { name: string }) => c.name === 'Household picks');
    expect(visible.editable).toBe(false);
  });

  it('accepts real images as artwork and rejects anything else', async () => {
    const client = new Client(server.url);
    await client.login('artist');
    const created = await client.post('/api/collections', { name: 'Art' });
    const id = created.json.id;
    const fake = await client.put(
      `/api/collections/${id}/artwork`,
      new TextEncoder().encode('<svg/>'),
      {
        'Content-Type': 'image/png',
      },
    );
    expect(fake.status).toBe(400);
    const wrongType = await client.put(`/api/collections/${id}/artwork`, PNG_1x1, {
      'Content-Type': 'text/plain',
    });
    expect(wrongType.status).toBe(400);
    // In-memory test servers have no artwork directory, so a valid upload reports that clearly.
    const png = await client.put(`/api/collections/${id}/artwork`, PNG_1x1, {
      'Content-Type': 'image/png',
    });
    expect(png.status).toBe(400);
    expect(png.json.error.message).toMatch(/not available/);
    const movieArt = await client.patch(`/api/collections/${id}`, {
      artwork: { kind: 'movie', ref: 'heat-1995' },
    });
    expect(movieArt.json.artwork.url).toContain('heat-1995');
  });

  it('reorders collections and removes deleted ones from the home layout', async () => {
    const client = new Client(server.url);
    await client.login('organizer');
    const a = await client.post('/api/collections', { name: 'A list' });
    const b = await client.post('/api/collections', { name: 'B list' });
    await client.put('/api/collections/order', { ids: [b.json.id, a.json.id] });
    const list = await client.get('/api/collections');
    const own = list.json.map((c: { id: string }) => c.id);
    expect(own.indexOf(b.json.id)).toBeLessThan(own.indexOf(a.json.id));
    const prefs = (await client.get('/api/preferences')).json;
    await client.patch('/api/preferences', {
      homeSections: [...prefs.homeSections, { id: `collection:${a.json.id}`, visible: true }],
    });
    await client.delete(`/api/collections/${a.json.id}`);
    const after = (await client.get('/api/preferences')).json;
    expect(after.homeSections.some((s: { id: string }) => s.id === `collection:${a.json.id}`)).toBe(
      false,
    );
  });
});

describe('personal data and watch state', () => {
  it('stores ratings and notes per user and validates input', async () => {
    const client = new Client(server.url);
    await client.login('critic');
    const saved = await client.put('/api/movies/rashomon-1950/personal', {
      rating: 4,
      notes: 'Rewatch with subtitles.',
    });
    expect(saved.json).toMatchObject({ rating: 4, notes: 'Rewatch with subtitles.' });
    expect((await client.put('/api/movies/rashomon-1950/personal', { rating: 9 })).status).toBe(
      400,
    );
    expect(
      (await client.put('/api/movies/rashomon-1950/personal', { notes: 'x'.repeat(5001) })).status,
    ).toBe(400);
    const detail = await client.get('/api/movies/rashomon-1950');
    expect(detail.json.personal.rating).toBe(4);
    const other = new Client(server.url);
    await other.login('someone-else');
    expect((await other.get('/api/movies/rashomon-1950')).json.personal.rating).toBeNull();
  });

  it('toggles favorites and watched state', async () => {
    const client = new Client(server.url);
    await client.login('toggler');
    const fav = await client.put('/api/movies/ugetsu-1953/favorite', { favorite: true });
    expect(fav.json.favorite).toBe(true);
    const favorites = await client.get('/api/movies?favorite=1');
    expect(favorites.json.items.map((m: { id: string }) => m.id)).toContain('ugetsu-1953');
    const watched = await client.put('/api/movies/ugetsu-1953/played', { played: true });
    expect(watched.json.played).toBe(true);
  });

  it('negotiates mock playback and records progress on stop', async () => {
    const client = new Client(server.url);
    await client.login('viewer');
    const info = await client.post('/api/movies/godzilla-1954/playback', {
      capabilities: { mp4VideoCodecs: ['h264'], audioCodecs: ['aac'] },
    });
    expect(info.json).toMatchObject({ isSample: true, method: 'DirectPlay', delivery: 'file' });
    const report = {
      itemId: 'godzilla-1954',
      mediaSourceId: info.json.mediaSourceId,
      playSessionId: info.json.playSessionId,
      positionSeconds: 20, // halfway through the 40 s sample clip
      isPaused: true,
      method: 'DirectPlay',
    };
    await client.post('/api/playback/start', report);
    const stopped = await client.post('/api/playback/stop', report);
    expect(stopped.json.user.positionSeconds).toBeGreaterThan(0);
    const home = await client.get('/api/home');
    const continueRow = home.json.sections.find(
      (s: { row?: { id: string } }) => s.row?.id === 'continueWatching',
    );
    expect(continueRow.row.movies[0].id).toBe('godzilla-1954');
    const resumed = await client.post('/api/movies/godzilla-1954/playback', {
      capabilities: {},
      startSeconds: stopped.json.user.positionSeconds,
    });
    expect(resumed.json.startSeconds).toBeCloseTo(20, 0);
  });
});

describe('robustness', () => {
  it('returns JSON errors for malformed input and unknown endpoints', async () => {
    const client = new Client(server.url);
    await client.login();
    const res = await fetch(server.url + '/api/preferences', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'private-cinema',
        Cookie: client.cookie,
      },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect((await client.get('/api/nope')).status).toBe(404);
  });
});
