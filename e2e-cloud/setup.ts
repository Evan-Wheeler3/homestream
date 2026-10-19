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
  process.env.E2E_USERNAME = 'evan';
  process.env.E2E_PASSWORD = 'e2e password';
}
