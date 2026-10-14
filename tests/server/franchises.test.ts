import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/server/db';
import { MockProvider } from '../../src/server/providers/mock';
import { SAMPLE_FILMS } from '../../src/server/providers/mockLibrary';
import type { Franchise } from '../../src/shared/types';
import { Client, startServer, type TestServer } from './helpers';

const [a, b, c] = SAMPLE_FILMS;

/** The sample library, plus film series like Jellyfin's box sets. */
class SeriesProvider extends MockProvider {
  calls = 0;
  override async listFranchises(): Promise<Franchise[]> {
    this.calls++;
    return [
      {
        id: 'set-1',
        name: 'Sample Trilogy',
        movieIds: [c!.id, a!.id, 'not-in-library'],
        poster: null,
        backdrop: null,
      },
      // Only one of its films is here, so it isn't shown.
      { id: 'set-2', name: 'Lonely Saga', movieIds: [b!.id], poster: null, backdrop: null },
    ];
  }
}

let server: TestServer;
const provider = new SeriesProvider(openDatabase(':memory:'), 'demo');

beforeAll(async () => {
  server = await startServer({}, provider);
});
afterAll(() => server.close());

describe('film series', () => {
  it('lists series with at least two films in the library, in release order', async () => {
    const client = new Client(server.url);
    await client.login();
    const list = await client.get('/api/franchises');
    expect(list.json).toMatchObject({ franchises: [{ id: 'set-1', count: 2 }] });

    const detail = (await client.get('/api/franchises/set-1')).json as {
      movies: { id: string; year: number }[];
    };
    expect(detail.movies.map((m) => m.id).sort()).toEqual([a!.id, c!.id].sort());
    const years = detail.movies.map((m) => m.year);
    expect(years).toEqual([...years].sort((x, y) => x - y));

    expect((await client.get('/api/franchises/set-2')).status).toBe(404);
  });

  it('shows the series on the movie page and on Home', async () => {
    const client = new Client(server.url);
    await client.login();
    const movie = await client.get(`/api/movies/${a!.id}`);
    expect(movie.json).toMatchObject({ franchises: [{ id: 'set-1', name: 'Sample Trilogy' }] });
    const home = (await client.get('/api/home')).json as { sections: { type: string }[] };
    expect(home.sections.some((s) => s.type === 'franchises')).toBe(true);
    // Cached between requests.
    expect(provider.calls).toBe(1);
  });
});
