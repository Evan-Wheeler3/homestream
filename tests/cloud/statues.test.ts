import { describe, expect, it } from 'vitest';
import { Sql } from '../../src/cloud/db';
import {
  allStatues,
  designMissing,
  designStatue,
  missingStatues,
  parseStatue,
  statuePrompt,
} from '../../src/cloud/statues';
import { cloud } from './fakes';

/** A movie row, as the Mac would have added it. */
function addMovie(c: ReturnType<typeof cloud>, id: string, title: string, dateAdded: string) {
  c.db.raw
    .prepare(
      `INSERT INTO movies (id, title, year, summary, date_added, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      title,
      1975,
      JSON.stringify({
        title,
        year: 1975,
        genres: ['Thriller'],
        overview: 'A police chief hunts a shark off a summer beach town.',
        tagline: null,
      }),
      dateAdded,
      dateAdded,
    );
}

const fin = JSON.stringify({
  name: 'The Fin',
  boxes: [
    { x0: 0, y0: 0, z0: 0, x1: 16, y1: 2, z1: 16, color: '#1e5aa0', glow: false },
    { x0: 6, y0: 2, z0: 6, x1: 10, y1: 12, z1: 9, color: '#5a6470', glow: false },
    { x0: 7, y0: 12, z0: 7, x1: 9, y1: 16, z1: 8, color: '#5a6470', glow: false },
  ],
});

describe('statues designed for each movie', () => {
  it('keeps a design inside the grid, drops broken boxes, and stands it on the floor', () => {
    const spec = parseStatue(
      JSON.stringify({
        name: '  The Red Balloon  ',
        boxes: [
          { x0: 6, y0: 4, z0: 6, x1: 10, y1: 12, z1: 10, color: '#e02020', glow: false },
          // Off the grid: squeezed in.
          { x0: 7, y0: 2, z0: 7, x1: 30, y1: 4, z1: 9, color: '#ffffff', glow: true },
          // Backwards corners: put right.
          { x0: 9, y0: 30, z0: 9, x1: 7, y1: 12, z1: 7, color: '#202020', glow: false },
          // Flat, or no colour: dropped.
          { x0: 1, y0: 1, z0: 1, x1: 1, y1: 5, z1: 5, color: '#123456', glow: false },
          { x0: 1, y0: 1, z0: 1, x1: 4, y1: 5, z1: 5, color: 'red', glow: false },
        ],
      }),
    );
    expect(spec.name).toBe('The Red Balloon');
    expect(spec.boxes).toEqual([
      [6, 2, 6, 10, 10, 10, 0xe02020, 0],
      [7, 0, 7, 16, 2, 9, 0xffffff, 1],
      [7, 10, 7, 9, 22, 9, 0x202020, 0],
    ]);
    expect(() => parseStatue('{"name":"x","boxes":[]}')).toThrow(/too few/);
  });

  it('asks about the movie’s own story', () => {
    const prompt = statuePrompt({
      title: 'Jaws',
      year: 1975,
      genres: ['Thriller'],
      overview: 'A shark terrorizes a beach town.',
      tagline: null,
    });
    expect(prompt).toContain('Movie: Jaws (1975)');
    expect(prompt).toContain('Story: A shark terrorizes a beach town.');
  });

  it('designs the newest movies first, saves them, and gives up after three failures', async () => {
    const c = cloud();
    const sql = new Sql(c.env.DB);
    addMovie(c, 'm-old', 'Old', '2020-01-01T00:00:00.000Z');
    addMovie(c, 'm-new', 'New', '2026-01-01T00:00:00.000Z');
    expect(await missingStatues(sql)).toEqual(['m-new', 'm-old']);

    const asked: string[] = [];
    expect(
      await designStatue(sql, 'm-new', async (system, prompt) => {
        asked.push(prompt);
        expect(system).toMatch(/Never depict a person or a character/);
        return fin;
      }),
    ).toMatchObject({ name: 'The Fin' });
    expect(asked[0]).toContain('Movie: New (1975)');
    expect(await missingStatues(sql)).toEqual(['m-old']);

    const broken = async () => {
      throw new Error('overloaded');
    };
    for (let i = 0; i < 3; i++) expect(await designStatue(sql, 'm-old', broken)).toBeNull();
    expect(await missingStatues(sql)).toEqual([]);
    expect(Object.keys(await allStatues(sql))).toEqual(['m-new']);
  });

  it('the scheduled run does nothing without a Claude API key', async () => {
    const c = cloud();
    const sql = new Sql(c.env.DB);
    addMovie(c, 'm-1', 'One', '2026-01-01T00:00:00.000Z');
    expect(await designMissing(c.env, sql)).toBe(0);
    expect(await designMissing(c.env, sql, async () => fin)).toBe(1);
    expect(await missingStatues(sql)).toEqual([]);
  });
});
