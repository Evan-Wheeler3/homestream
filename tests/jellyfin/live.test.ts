// Live tests against a real Jellyfin server. Run with:
//   JELLYFIN_TEST_URL=http://127.0.0.1:8096 JELLYFIN_TEST_USER=me JELLYFIN_TEST_PASSWORD=... npm run test:jellyfin
// They read the library and make reversible changes only (toggle favorite back,
// remove a temporary collection). They need at least one movie in the library.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, startServer, type TestServer } from '../server/helpers';

const url = process.env.JELLYFIN_TEST_URL;
const user = process.env.JELLYFIN_TEST_USER ?? '';
const password = process.env.JELLYFIN_TEST_PASSWORD ?? '';

describe.skipIf(!url)('live Jellyfin integration', () => {
  let server: TestServer;
  let client: Client;
  let movies: { id: string; title: string; images: { poster: string | null } }[] = [];

  beforeAll(async () => {
    server = await startServer({ source: 'jellyfin', jellyfinUrl: url!.replace(/\/+$/, '') });
    client = new Client(server.url);
  });
  afterAll(() => server?.close());

  it('rejects a wrong password', async () => {
    const res = await client.post('/api/auth/login', {
      username: user,
      password: `${password}-wrong`,
    });
    expect(res.status).toBe(401);
  });

  it('signs in with Jellyfin credentials', async () => {
    const res = await client.login(user, password);
    expect(res.json.source).toBe('jellyfin');
    expect(res.json.user.name.toLowerCase()).toBe(user.toLowerCase());
  });

  it('reports the server as reachable', async () => {
    const status = await client.get('/api/status');
    expect(status.json.mediaServer.reachable).toBe(true);
    expect(status.json.mediaServer.version).toBeTruthy();
  });

  it('lists the real movie library', async () => {
    const res = await client.get('/api/movies?limit=200');
    expect(res.status).toBe(200);
    movies = res.json.items;
    expect(movies.length).toBeGreaterThan(0);
    expect(movies[0]!.id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('serves artwork through the authenticated proxy', async () => {
    const withPoster = movies.find((m) => m.images.poster);
    if (!withPoster) return;
    const res = await fetch(server.url + withPoster.images.poster + '&maxWidth=200', {
      headers: { Cookie: client.cookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^image\//);
    const anon = await fetch(server.url + withPoster.images.poster);
    expect(anon.status).toBe(401);
  });

  it('loads detail, toggles a favorite in Jellyfin and restores it', async () => {
    const id = movies[0]!.id;
    const detail = await client.get(`/api/movies/${id}`);
    expect(detail.status).toBe(200);
    const original = detail.json.user.favorite as boolean;
    const toggled = await client.put(`/api/movies/${id}/favorite`, { favorite: !original });
    expect(toggled.json.favorite).toBe(!original);
    const restored = await client.put(`/api/movies/${id}/favorite`, { favorite: original });
    expect(restored.json.favorite).toBe(original);
  });

  it('negotiates playback and streams bytes with HTTP range support', async () => {
    const id = movies[0]!.id;
    const info = await client.post(`/api/movies/${id}/playback`, {
      capabilities: {
        mp4VideoCodecs: ['h264'],
        audioCodecs: ['aac', 'mp3'],
        mse: true,
        maxAudioChannels: 2,
      },
    });
    expect(info.status).toBe(200);
    expect(info.json.isSample).toBe(false);
    expect(info.json.url).not.toMatch(/api_?key/i);
    const media = await fetch(server.url + info.json.url, {
      headers: { Cookie: client.cookie, Range: 'bytes=0-1023' },
    });
    if (info.json.delivery === 'file') {
      expect(media.status).toBe(206);
      expect(media.headers.get('content-range')).toMatch(/^bytes 0-1023\//);
      await media.body?.cancel();
    } else {
      expect(media.status).toBe(200);
      expect(await media.text()).toContain('#EXTM3U');
    }
  });

  it('keeps app-owned collections referencing real Jellyfin ids', async () => {
    const created = await client.post('/api/collections', { name: `Live test ${Date.now()}` });
    expect(created.status).toBe(201);
    const added = await client.post(`/api/collections/${created.json.id}/items`, {
      itemIds: [movies[0]!.id],
    });
    expect(added.json.movies[0].id).toBe(movies[0]!.id);
    expect((await client.delete(`/api/collections/${created.json.id}`)).status).toBe(200);
  });

  it('keeps the Jellyfin token out of every response', async () => {
    for (const path of [
      '/api/auth/session',
      '/api/status',
      '/api/home',
      `/api/movies/${movies[0]!.id}`,
    ]) {
      const res = await client.get(path);
      expect(JSON.stringify(res.json)).not.toMatch(/accessToken|api_key|ApiKey/i);
    }
  });
});
