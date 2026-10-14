import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, startServer, type TestServer } from './helpers';

describe('movie night', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(() => server.close());

  async function host(name = `host-${Date.now()}`) {
    const c = new Client(server.url);
    await c.login(name);
    return c;
  }

  it('runs a vote from shortlist to winner, with guests voting by code', async () => {
    const h = await host();
    const created = await h.post('/api/nights', { pool: 'all', count: 4 });
    expect(created.status).toBe(200);
    const night = created.json;
    expect(night.code).toMatch(/^[A-HJ-NP-Z]{4}$/);
    expect(night.candidates).toHaveLength(4);
    const [a, b] = night.candidates as { id: string }[];

    // Guests have no account: just the code, a name and a per-phone key.
    const guest = new Client(server.url);
    const view = await guest.get(`/api/public/nights/${night.code.toLowerCase()}`);
    expect(view.json.night.candidates.map((c: { id: string }) => c.id)).toContain(a!.id);

    const vote = (key: string, name: string, itemId: string) =>
      guest.post(`/api/public/nights/${night.code}/vote`, { voterKey: key, name, itemId });
    expect((await vote('voter-key-aaaa', 'Sam', a!.id)).status).toBe(200);
    expect((await vote('voter-key-bbbb', 'Alex', b!.id)).status).toBe(200);
    expect((await vote('voter-key-cccc', 'Jo', a!.id)).status).toBe(200);
    // Changing your mind replaces your vote rather than adding one.
    const changed = await vote('voter-key-bbbb', 'Alex', a!.id);
    expect(changed.json.myVote).toBe(a!.id);
    expect(
      (await guest.get(`/api/public/nights/${night.code}?voter=voter-key-bbbb`)).json.myVote,
    ).toBe(a!.id);

    expect((await vote('voter-key-dddd', 'Bad', 'not-a-choice')).status).toBe(400);
    expect((await vote('voter-key-dddd', '', a!.id)).status).toBe(400);
    expect((await guest.get('/api/public/nights/ZZZZ')).status).toBe(404);

    const live = (await h.get('/api/nights/current')).json.night;
    expect(live.candidates.find((c: { id: string }) => c.id === a!.id).votes).toBe(3);
    expect(live.voters.map((v: { name: string }) => v.name).sort()).toEqual(['Alex', 'Jo', 'Sam']);

    const closed = (await h.post(`/api/nights/${night.id}/close`)).json;
    expect(closed.status).toBe('closed');
    expect(closed.winners).toEqual([a!.id]);
    expect((await vote('voter-key-eeee', 'Late', a!.id)).status).toBe(400);
  });

  it('reports a tie, which the wheel can settle', async () => {
    const h = await host();
    const night = (await h.post('/api/nights', { pool: 'all', count: 3 })).json;
    const [a, b] = night.candidates as { id: string }[];
    const guest = new Client(server.url);
    await guest.post(`/api/public/nights/${night.code}/vote`, {
      voterKey: 'tie-key-1111',
      name: 'A',
      itemId: a!.id,
    });
    await guest.post(`/api/public/nights/${night.code}/vote`, {
      voterKey: 'tie-key-2222',
      name: 'B',
      itemId: b!.id,
    });
    const closed = (await h.post(`/api/nights/${night.id}/close`)).json;
    expect(closed.winners.sort()).toEqual([a!.id, b!.id].sort());
    // The tie goes to the wheel with just those movies.
    const wheel = await h.get(`/api/movies/sample?count=12&ids=${a!.id}|${b!.id}`);
    expect(wheel.json.movies.map((m: { id: string }) => m.id).sort()).toEqual(
      [a!.id, b!.id].sort(),
    );
  });

  it('only lets the host close their night, and needs a session to host', async () => {
    const h = await host();
    const night = (await h.post('/api/nights', { pool: 'all', count: 3 })).json;
    const other = await host(`other-${Date.now()}`);
    expect((await other.post(`/api/nights/${night.id}/close`)).status).toBe(404);
    expect((await new Client(server.url).post('/api/nights', { pool: 'all' })).status).toBe(401);
  });
});
