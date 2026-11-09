// Each movie's statue in the 3D cinema, designed once by Claude from the movie's
// story: an original object or prop from the film (never a character's likeness
// or a logo), built from coloured boxes on a small grid. Designed when the Mac
// adds a movie, and every 20 minutes for any movie still without one.
import Anthropic from '@anthropic-ai/sdk';
import { STATUE_GRID, type StatueBox, type StatueSpec } from '../shared/theater.js';
import { nowIso, type Sql } from './db.js';
import type { CloudEnv } from './env.js';

/** Tries per movie before giving up on it (it keeps its genre statue). */
const MAX_ATTEMPTS = 3;
/** Movies designed per scheduled run (they run one after another). */
const PER_RUN = 4;
const MAX_BOXES = 90;

export interface StatueMovie {
  title: string;
  year: number | null;
  genres: string[];
  overview: string | null;
  tagline: string | null;
}

const SYSTEM = `You design small statues for a cinema built from blocks, in the style of a blocky voxel game. Each movie's theater has one on a pedestal beside its door, so people walking past can tell what's showing.

Design ONE statue for the movie you're given: a single object, prop, vehicle, machine, plant, animal, piece of scenery or symbol that clearly calls this particular film to mind for someone who has seen it. Pick something specific to its story rather than to its genre in general.

Rules:
- Never depict a person or a character (no faces, bodies, costumes or likenesses of anyone in the film), and no logos, brand marks, lettering or text of any kind. If the film is famous for a character, pick an object from their story instead.
- It must be your own simple design, not a copy of a particular studio's artwork.
- Build it from boxes on a grid ${STATUE_GRID.x} wide (x, left to right as you face it), ${STATUE_GRID.y} tall (y, up) and ${STATUE_GRID.z} deep (z, back to front; the front faces the viewer at z = ${STATUE_GRID.z}). One unit is 1/16 of a metre, so the whole statue is at most 1 m wide and 1.5 m tall.
- Each box is x0..x1, y0..y1, z0..z1 in whole units, with x0 < x1, y0 < y1, z0 < z1, inside the grid. Boxes may overlap.
- It stands on the pedestal: something must touch y = 0, and nothing should float.
- Use between 12 and ${MAX_BOXES} boxes. Chunky shapes read best from 3 metres away; give it depth (not a flat cut-out) and recognisable proportions.
- Colours are "#rrggbb". Use a small palette with lighter and darker shades of each colour for detail. Mark lights, flames, screens, magic or anything that should glow with glow: true; everything else glow: false.
- name: a short title for the plaque (2 to 4 words, e.g. "The Red Balloon"), not a quote from the film.`;

const SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    boxes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          x0: { type: 'integer' },
          y0: { type: 'integer' },
          z0: { type: 'integer' },
          x1: { type: 'integer' },
          y1: { type: 'integer' },
          z1: { type: 'integer' },
          color: { type: 'string' },
          glow: { type: 'boolean' },
        },
        required: ['x0', 'y0', 'z0', 'x1', 'y1', 'z1', 'color', 'glow'],
        additionalProperties: false,
      },
    },
  },
  required: ['name', 'boxes'],
  additionalProperties: false,
} as const;

/** Sends one design request; returns the model's JSON text (or throws). */
export type DesignCall = (system: string, prompt: string) => Promise<string>;

export function claudeDesigner(apiKey: string): DesignCall {
  const client = new Anthropic({ apiKey });
  return async (system, prompt) => {
    const response = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      // If the request is declined, the API retries it on another model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: prompt }],
    } as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming);
    if (response.stop_reason === 'refusal') throw new Error('Declined to design this statue.');
    if (response.stop_reason === 'max_tokens') throw new Error('The design was cut off.');
    const text = response.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') throw new Error('No design came back.');
    return text.text;
  };
}

export function statuePrompt(m: StatueMovie): string {
  return [
    `Movie: ${m.title}${m.year ? ` (${m.year})` : ''}`,
    m.genres.length ? `Genres: ${m.genres.join(', ')}` : '',
    m.tagline ? `Tagline: ${m.tagline}` : '',
    m.overview ? `Story: ${m.overview}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const int = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : NaN);
const clamp = (n: number, max: number) => Math.max(0, Math.min(max, n));

/** Checks a design and squeezes it into the grid; throws if there's nothing usable. */
export function parseStatue(json: string): StatueSpec {
  const raw = JSON.parse(json) as { name?: unknown; boxes?: unknown };
  const boxes: StatueBox[] = [];
  for (const b of Array.isArray(raw.boxes) ? raw.boxes.slice(0, MAX_BOXES) : []) {
    const v = (b ?? {}) as Record<string, unknown>;
    const [x0, x1] = [int(v.x0), int(v.x1)]
      .map((n) => clamp(n, STATUE_GRID.x))
      .sort((a, c) => a - c);
    const [y0, y1] = [int(v.y0), int(v.y1)]
      .map((n) => clamp(n, STATUE_GRID.y))
      .sort((a, c) => a - c);
    const [z0, z1] = [int(v.z0), int(v.z1)]
      .map((n) => clamp(n, STATUE_GRID.z))
      .sort((a, c) => a - c);
    const color = typeof v.color === 'string' && /^#[0-9a-f]{6}$/i.test(v.color) ? v.color : null;
    if ([x0, x1, y0, y1, z0, z1].some(Number.isNaN) || !color) continue;
    if (x0 === x1 || y0 === y1 || z0 === z1) continue;
    boxes.push([
      x0!,
      y0!,
      z0!,
      x1!,
      y1!,
      z1!,
      parseInt(color.slice(1), 16),
      v.glow === true ? 1 : 0,
    ]);
  }
  if (boxes.length < 3) throw new Error('The design had too few usable boxes.');
  // Sitting on the pedestal: drop the whole thing to the floor.
  const lowest = Math.min(...boxes.map((b) => b[1]));
  if (lowest > 0) for (const b of boxes) [b[1], b[4]] = [b[1] - lowest, b[4] - lowest];
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 40) : '';
  return { name, boxes };
}

/** Designs a statue for one movie and saves it (or the error, to try again later). */
export async function designStatue(
  sql: Sql,
  movieId: string,
  call: DesignCall,
): Promise<StatueSpec | null> {
  const row = await sql.get<{ summary: string }>(
    'SELECT summary FROM movies WHERE id = ?',
    movieId,
  );
  if (!row) return null;
  const s = JSON.parse(row.summary) as Partial<StatueMovie>;
  const movie: StatueMovie = {
    title: s.title ?? 'Untitled',
    year: s.year ?? null,
    genres: s.genres ?? [],
    overview: s.overview ?? null,
    tagline: s.tagline ?? null,
  };
  try {
    const spec = parseStatue(await call(SYSTEM, statuePrompt(movie)));
    await sql.run(
      `INSERT INTO statues (movie_id, spec, attempts, error, updated_at) VALUES (?, ?, 1, NULL, ?)
       ON CONFLICT(movie_id) DO UPDATE SET spec = excluded.spec, attempts = attempts + 1, error = NULL,
         updated_at = excluded.updated_at`,
      movieId,
      JSON.stringify(spec),
      nowIso(),
    );
    return spec;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql.run(
      `INSERT INTO statues (movie_id, spec, attempts, error, updated_at) VALUES (?, NULL, 1, ?, ?)
       ON CONFLICT(movie_id) DO UPDATE SET attempts = attempts + 1, error = excluded.error,
         updated_at = excluded.updated_at`,
      movieId,
      message.slice(0, 300),
      nowIso(),
    );
    console.warn(`Statue for ${movieId} failed:`, message);
    return null;
  }
}

/** Movies with no statue yet (newest first), skipping ones that failed too often. */
export async function missingStatues(sql: Sql, limit = PER_RUN): Promise<string[]> {
  const rows = await sql.all<{ id: string }>(
    `SELECT m.id FROM movies m LEFT JOIN statues s ON s.movie_id = m.id
     WHERE s.spec IS NULL AND COALESCE(s.attempts, 0) < ?
     ORDER BY m.date_added DESC LIMIT ?`,
    MAX_ATTEMPTS,
    limit,
  );
  return rows.map((r) => r.id);
}

/** The scheduled run: design a few missing statues, one after another. */
export async function designMissing(env: CloudEnv, sql: Sql, call?: DesignCall) {
  const design = call ?? (env.ANTHROPIC_API_KEY ? claudeDesigner(env.ANTHROPIC_API_KEY) : null);
  if (!design) return 0;
  let made = 0;
  for (const id of await missingStatues(sql)) {
    if (await designStatue(sql, id, design)) made++;
  }
  return made;
}

/** Every designed statue, by movie id (what the 3D cinema draws). */
export async function allStatues(sql: Sql): Promise<Record<string, StatueSpec>> {
  const rows = await sql.all<{ movie_id: string; spec: string }>(
    'SELECT movie_id, spec FROM statues WHERE spec IS NOT NULL',
  );
  return Object.fromEntries(rows.map((r) => [r.movie_id, JSON.parse(r.spec) as StatueSpec]));
}
