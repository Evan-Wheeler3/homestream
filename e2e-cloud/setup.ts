import { createHash } from 'node:crypto';
import fs from 'node:fs';

/** Seeds the local test instance: an administrator and two movies (via the Mac API). */
export default async function setup() {
  if (process.env.CLOUD_URL) {
    if (!process.env.E2E_USERNAME || !process.env.E2E_PASSWORD) {
      throw new Error('Set E2E_USERNAME and E2E_PASSWORD for an account on the deployed site.');
    }
    return;
  }
  const base = 'http://127.0.0.1:8790';
  const vars = fs.readFileSync('.dev.vars', 'utf8');
  const token = /^MAC_TOKEN=(.+)$/m.exec(vars)?.[1]?.trim();
  if (!token) throw new Error('No MAC_TOKEN in .dev.vars');
  const mac = (method: string, url: string, body: unknown) =>
    fetch(`${base}/api/mac${url}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const boot = await mac('POST', '/bootstrap', { name: 'Evan' });
  if (!boot.ok) throw new Error(`bootstrap: ${boot.status} ${await boot.text()}`);
  const { url } = (await boot.json()) as { url: string };
  const redeem = await fetch(`${base}/api/invites/${url.split('/invite/')[1]}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'wheelhouse' },
    body: JSON.stringify({ username: 'evan', password: 'e2e password' }),
  });
  if (!redeem.ok) throw new Error(`invite: ${redeem.status} ${await redeem.text()}`);

  const video = fs.readFileSync('assets/sample/sample.mp4');
  const sha256 = createHash('sha256').update(video).digest('hex');
  const movies = [
    {
      id: 'e2e-1',
      title: 'Pulp Fiction',
      year: 1994,
      genres: ['Crime', 'Thriller'],
      subtitles: true,
    },
    { id: 'e2e-2', title: 'Young Frankenstein', year: 1974, genres: ['Comedy'], subtitles: false },
  ];
  for (const m of movies) {
    const res = await mac('PUT', `/movies/${m.id}`, {
      tmdbId: null,
      imdbId: null,
      summary: {
        title: m.title,
        sortTitle: m.title.toLowerCase(),
        originalTitle: null,
        year: m.year,
        premiereDate: null,
        runtimeMinutes: 1,
        genres: m.genres,
        directors: ['Test Director'],
        actors: ['Test Actor'],
        studios: [],
        tags: [],
        countries: [],
        officialRating: 'R',
        communityRating: 8,
        criticRating: null,
        overview: `${m.title}, a test entry.`,
        tagline: null,
        dateAdded: new Date().toISOString(),
      },
      detail: {
        cast: [],
        trailers: [],
        writers: [],
        producers: [],
        mediaInfo: null,
        externalLinks: [],
      },
      images: { poster: null, backdrop: null, logo: null },
      video: { key: `movies/${m.id}/video.mp4`, bytes: video.length, sha256, durationSeconds: 30 },
      subtitles: m.subtitles
        ? [
            {
              language: 'eng',
              label: 'English',
              key: `movies/${m.id}/subtitles.eng.disc.vtt`,
              source: 'disc',
            },
          ]
        : [],
      subtitleStatus: m.subtitles ? 'disc' : 'none',
      franchise: null,
      sourcePath: null,
    });
    if (!res.ok) throw new Error(`movie ${m.id}: ${res.status} ${await res.text()}`);
  }
  // A TV show with two episodes.
  const show = await mac('PUT', '/shows/tmdbtv-e2e', {
    tmdbId: null,
    show: {
      title: 'Test Show',
      sortTitle: 'test show',
      year: 2008,
      endYear: null,
      genres: ['Drama'],
      officialRating: 'TV-14',
      communityRating: 8.5,
      overview: 'A show for tests.',
      cast: [],
      seasons: [{ number: 1, name: 'Season 1', posterKey: null }],
    },
    images: { poster: null, backdrop: null, logo: null },
  });
  if (!show.ok) throw new Error(`show: ${show.status} ${await show.text()}`);
  for (const n of [1, 2]) {
    const id = `tmdbtv-e2e-s01e0${n}`;
    const res = await mac('PUT', `/episodes/${id}`, {
      showId: 'tmdbtv-e2e',
      seasonNumber: 1,
      number: n,
      endNumber: null,
      title: n === 1 ? 'Pilot' : 'The Second One',
      overview: null,
      runtimeMinutes: 1,
      premiereDate: null,
      imageKey: null,
      video: {
        key: `shows/tmdbtv-e2e/${id}.mp4`,
        bytes: video.length,
        sha256,
        durationSeconds: 30,
      },
      subtitles: [],
      subtitleStatus: 'none',
      sourcePath: null,
    });
    if (!res.ok) throw new Error(`episode ${id}: ${res.status} ${await res.text()}`);
  }
  process.env.E2E_USERNAME = 'evan';
  process.env.E2E_PASSWORD = 'e2e password';
}
