import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/server/db';
import { MockProvider } from '../../src/server/providers/mock';
import { SAMPLE_FILMS } from '../../src/server/providers/mockLibrary';
import type { UserContext } from '../../src/server/providers/types';
import { findInLibrary, MovieRequests, titleKey } from '../../src/server/requests';
import type { Notification } from '../../src/server/ripper/services';
import { effectiveBitrate, networkPlace, NowPlaying, shareInfo } from '../../src/server/sharing';
import type { Movie, MovieRequest, NowWatching, PlaybackRequest } from '../../src/shared/types';
import { Client, startServer, type TestServer } from './helpers';

describe('home or away', () => {
  it.each([
    ['127.0.0.1', 'home'],
    ['::ffff:192.168.1.20', 'home'],
    ['10.0.0.4', 'home'],
    ['172.20.1.1', 'home'],
    ['::1', 'home'],
    ['100.101.102.103', 'away'],
    ['fd7a:115c:a1e0::1', 'away'],
    ['100.20.0.1', 'away'],
    ['8.8.8.8', 'away'],
  ])('%s is %s', (ip, place) => expect(networkPlace(ip)).toBe(place));

  it('lists Tailscale addresses first', () => {
    const info = shareInfo(
      8787,
      {
        en0: [{ address: '192.168.1.5', family: 'IPv4', internal: false } as never],
        utun4: [{ address: '100.88.1.2', family: 'IPv4', internal: false } as never],
        lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
      },
      'Evans-Mac.local',
    );
    expect(info).toMatchObject({
      hostname: 'Evans-Mac',
      tailscale: true,
      addresses: [
        { url: 'http://100.88.1.2:8787', kind: 'tailscale' },
        { url: 'http://192.168.1.5:8787', kind: 'home' },
      ],
    });
  });

  it('uses the lower of the person’s own setting and the limit', () => {
    expect(effectiveBitrate(null, 4e6)).toBe(4e6);
    expect(effectiveBitrate(1.5e6, 4e6)).toBe(1.5e6);
    expect(effectiveBitrate(10e6, null)).toBe(10e6);
  });

  it('forgets viewers it hasn’t heard from', () => {
    const now = new NowPlaying();
    now.update('a', { userName: 'Sam' } as Omit<NowWatching, 'startedAt'>);
    expect(now.list()).toHaveLength(1);
    (now as unknown as { sessions: Map<string, { updatedAt: number }> }).sessions.get(
      'a',
    )!.updatedAt = 0;
    expect(now.list()).toHaveLength(0);
  });
});

describe('request matching', () => {
  const movie = (title: string, year: number) => ({ id: title, title, year }) as Movie;
  it('ignores case, punctuation and a leading article', () => {
    expect(titleKey('The Princess Bride!')).toBe(titleKey('princess bride'));
    expect(titleKey('Amélie')).toBe('amelie');
    expect(findInLibrary([movie('Star Wars', 1977)], 'star wars', 1977)?.id).toBe('Star Wars');
    expect(findInLibrary([movie('Star Wars', 1977)], 'Star Wars', 1999)).toBeNull();
  });

  it('marks requests added when the movie arrives', () => {
    const requests = new MovieRequests(openDatabase(':memory:'));
    requests.create({ id: 'u1', name: 'Sam' }, { title: 'Jaws', year: 1975 }, []);
    expect(requests.fulfil([movie('Something else', 2001)])).toHaveLength(0);
    const [done] = requests.fulfil([movie('JAWS', 1975)]);
    expect(done).toMatchObject({ title: 'Jaws', status: 'added', itemId: 'JAWS' });
  });
});

/** The sample library, where names starting with "guest" aren't administrators. */
class FamilyProvider extends MockProvider {
  lastBitrate: number | null | undefined;
  override async authenticate(username: string, password: string) {
    const result = await super.authenticate(username, password);
    return {
      ...result,
      user: { ...result.user, isAdmin: !username.startsWith('guest') },
    };
  }
  override async getPlayback(
    ctx: UserContext,
    id: string,
    request: PlaybackRequest,
    prefs?: { maxBitrate: number | null; preferDirectPlay: boolean },
  ) {
    this.lastBitrate = prefs?.maxBitrate;
    return super.getPlayback(ctx, id, request);
  }
}

let server: TestServer;
const provider = new FamilyProvider(openDatabase(':memory:'), 'demo');
const sent: Notification[] = [];
const film = SAMPLE_FILMS[0]!;

beforeAll(async () => {
  server = await startServer({}, provider, {
    ripperNotifier: { send: async (n) => void sent.push(n) },
  });
});
afterAll(() => server.close());

async function people() {
  const owner = new Client(server.url);
  await owner.login('owner');
  const guest = new Client(server.url);
  await guest.login('guest-sam');
  return { owner, guest };
}

describe('sharing with family', () => {
  it('handles movie requests from start to finish', async () => {
    const { owner, guest } = await people();
    const created = await guest.post('/api/requests', { title: 'Jaws', year: 1975, note: 'Pls' });
    expect(created.status).toBe(201);
    const id = (created.json as MovieRequest).id;
    expect(sent.at(-1)).toMatchObject({ title: 'Movie request: Jaws (1975)' });
    expect(sent.at(-1)!.message).toContain('guest-sam');

    expect((await owner.post('/api/requests', { title: 'jaws' })).json).toMatchObject({
      error: { message: expect.stringMatching(/guest-sam has already asked/) },
    });
    expect((await guest.post('/api/requests', { title: film.title })).json).toMatchObject({
      error: { message: expect.stringMatching(/already in the library/) },
    });
    await owner.post('/api/requests', { title: 'Alien' });

    const mine = (await guest.get('/api/requests')).json as { requests: MovieRequest[] };
    expect(mine.requests.map((r) => r.title)).toEqual(['Jaws']);
    const all = (await owner.get('/api/requests')).json as { requests: MovieRequest[] };
    expect(all.requests.map((r) => r.title).sort()).toEqual(['Alien', 'Jaws']);

    expect((await guest.patch(`/api/requests/${id}`, { status: 'added' })).status).toBe(403);
    expect((await owner.patch(`/api/requests/${id}`, { status: 'declined' })).json).toMatchObject({
      status: 'declined',
    });
    expect((await guest.delete(`/api/requests/${id}`)).status).toBe(204);
  });

  it('applies an administrator’s streaming limit to that person only', async () => {
    const { owner, guest } = await people();
    expect((await guest.get('/api/limits')).status).toBe(403);
    const list = (await owner.get('/api/limits')).json as {
      people: { userId: string; userName: string }[];
    };
    const sam = list.people.find((p) => p.userName === 'guest-sam')!;
    expect(sam).toBeTruthy();

    await owner.put(`/api/limits/${sam.userId}`, { maxBitrate: 4_000_000, awayOnly: false });
    await guest.post(`/api/movies/${film.id}/playback`, {});
    expect(provider.lastBitrate).toBe(4_000_000);
    await owner.post(`/api/movies/${film.id}/playback`, {});
    expect(provider.lastBitrate).toBeNull();

    // "Only when away": these test requests come from this computer, which is home.
    await owner.put(`/api/limits/${sam.userId}`, { maxBitrate: 4_000_000, awayOnly: true });
    await guest.post(`/api/movies/${film.id}/playback`, {});
    expect(provider.lastBitrate).toBeNull();

    await owner.put(`/api/limits/${sam.userId}`, { maxBitrate: null });
    expect((await owner.put('/api/limits/nobody', { maxBitrate: 4e6 })).status).toBe(404);
  });

  it('shows administrators who is watching', async () => {
    const { owner, guest } = await people();
    await owner.get('/api/movies'); // load the index so titles are known
    await guest.get('/api/movies');
    await guest.post('/api/playback/start', {
      itemId: film.id,
      playSessionId: 'ps-1',
      positionSeconds: 30,
    });
    const status = (await owner.get('/api/status')).json as { watching: NowWatching[] };
    expect(status.watching).toEqual([
      expect.objectContaining({ userName: 'guest-sam', title: film.title, place: 'home' }),
    ]);
    expect(((await guest.get('/api/status')).json as { watching: unknown }).watching).toBeNull();
    await guest.post('/api/playback/stop', {
      itemId: film.id,
      playSessionId: 'ps-1',
      positionSeconds: 40,
    });
    expect(((await owner.get('/api/status')).json as { watching: unknown[] }).watching).toEqual([]);
  });

  it('gives administrators the addresses to share', async () => {
    const { owner, guest } = await people();
    expect((await owner.get('/api/system/share')).json).toMatchObject({ port: 0 });
    expect((await guest.get('/api/system/share')).status).toBe(403);
  });
});
