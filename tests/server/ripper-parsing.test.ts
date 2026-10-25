import { describe, expect, it } from 'vitest';
import {
  encodeArgs,
  parseEncodeProgress,
  parseScanDuration,
} from '../../src/server/ripper/handbrake';
import { loadRipperConfig } from '../../src/server/config';
import {
  chooseMainTitle,
  classifyDisc,
  parseDiscInfo,
  parseDrives,
  parseProgress,
  parseProgressTitle,
  readErrorHint,
  splitFields,
  type DiscTitle,
} from '../../src/server/ripper/makemkv';
import {
  episodeFileNames,
  guessTitle,
  guessTv,
  identify,
  movieFileNames,
  safeFileName,
} from '../../src/server/ripper/naming';
import { runProcess } from '../../src/server/ripper/process';

describe('MakeMKV robot output', () => {
  it('splits quoted fields, including commas and escaped quotes', () => {
    expect(splitFields('0,2,"Say \\"Hi\\", Bob",')).toEqual(['0', '2', 'Say "Hi", Bob', '']);
    expect(splitFields('1,27,0,"title_t00.mkv"')).toEqual(['1', '27', '0', 'title_t00.mkv']);
  });

  it('finds drives with a disc inserted', () => {
    const drives = parseDrives(
      [
        'DRV:0,2,999,1,"HL-DT-ST DVDRAM GP65NB60","YOUNG_FRANKENSTEIN","/dev/rdisk4"',
        'DRV:1,256,999,0,"","",""',
        'DRV:2,0,999,1,"Other drive","",""',
      ].join('\n'),
    );
    expect(drives).toHaveLength(2);
    expect(drives[0]).toMatchObject({ index: 0, state: 2, discName: 'YOUNG_FRANKENSTEIN' });
  });

  it('reads disc and title details', () => {
    const info = parseDiscInfo(
      [
        'CINFO:1,6209,"DVD disc"',
        'CINFO:2,0,"Young Frankenstein"',
        'CINFO:32,0,"YOUNG_FRANKENSTEIN"',
        'TCOUNT:2',
        'TINFO:0,8,0,"24"',
        'TINFO:0,9,0,"1:45:12"',
        'TINFO:0,10,0,"4.6 GB"',
        'TINFO:0,11,0,"4939726848"',
        'TINFO:0,27,0,"title_t00.mkv"',
        'SINFO:0,0,1,6201,"Video"',
        'TINFO:1,9,0,"0:02:10"',
      ].join('\n'),
    );
    expect(info.name).toBe('Young Frankenstein');
    expect(info.volumeName).toBe('YOUNG_FRANKENSTEIN');
    expect(info.titles[0]).toMatchObject({
      index: 0,
      durationSeconds: 6312,
      sizeBytes: 4939726848,
      chapters: 24,
      outputFile: 'title_t00.mkv',
    });
    expect(info.titles[1]!.durationSeconds).toBe(130);
  });

  it('reads overall progress', () => {
    expect(parseProgress('PRGV:100,32768,65536')).toBe(0.5);
    expect(parseProgress('PRGT:5018,0,"Saving"')).toBeNull();
  });

  it('reads the start of each phase, whose progress counts from 0 again', () => {
    expect(parseProgressTitle('PRGT:5018,0,"Saving to MKV file"')).toBe('Saving to MKV file');
    expect(parseProgressTitle('PRGV:100,32768,65536')).toBeNull();
  });

  const title = (index: number, minutes: number, segments = String(index)): DiscTitle => ({
    index,
    name: '',
    durationSeconds: minutes * 60,
    sizeBytes: minutes * 1e7,
    chapters: 10,
    segments,
    outputFile: `title_t0${index}.mkv`,
  });

  it('tells TV season discs from movies', () => {
    const disc = (...minutes: number[]) => minutes.map((m, i) => title(i, m));
    const indexes = (kind: ReturnType<typeof classifyDisc>) =>
      kind.kind === 'tv' ? kind.episodes.map((t) => t.index) : kind.kind;

    // Sitcom: four episodes, a "play all" of them, and a short extra.
    expect(indexes(classifyDisc(disc(88.5, 22, 22.5, 21.8, 22.2, 3)))).toEqual([1, 2, 3, 4]);
    // Hour-long drama with a "play all".
    expect(indexes(classifyDisc(disc(44, 43, 45, 132)))).toEqual([0, 1, 2]);
    // Movie with episode-length featurettes is still a movie.
    expect(indexes(classifyDisc(disc(118, 24, 21, 26)))).toBe('movie');
    // Two cuts of a movie.
    expect(indexes(classifyDisc(disc(101, 112)))).toBe('movie');
    // A lone episode-length title isn't a season.
    expect(indexes(classifyDisc(disc(48, 3)))).toBe('movie');
    // Same episode twice (another angle): counted once.
    expect(
      indexes(classifyDisc([title(0, 22, 'a'), title(1, 22, 'a'), title(2, 23, 'b')])),
    ).toEqual([0, 2]);
  });

  it('picks the longest title as the main feature', () => {
    const choice = chooseMainTitle([title(0, 3), title(1, 105), title(2, 12)]);
    expect(choice).toMatchObject({ kind: 'main', title: { index: 1 } });
  });

  it('accepts a couple of same-length versions (e.g. widescreen and full screen)', () => {
    const choice = chooseMainTitle([title(0, 105), title(1, 105)]);
    expect(choice.kind).toBe('main');
  });

  it('asks for help with copy-protection decoys or no feature-length title', () => {
    const decoys = [0, 1, 2, 3, 4].map((i) => title(i, 105, `1,${i + 5}`));
    expect(chooseMainTitle(decoys).kind).toBe('ambiguous');
    expect(chooseMainTitle([title(0, 22), title(1, 23)]).kind).toBe('ambiguous');
  });

  it('recognises TV series discs, with or without a "play all" title', () => {
    const episodes = [0, 1, 2, 3].map((i) => title(i, 44 + i));
    const plain = classifyDisc(episodes);
    expect(plain.kind === 'tv' && plain.episodes.map((t) => t.index)).toEqual([0, 1, 2, 3]);
    const playAll = classifyDisc([...episodes, title(9, 44 + 45 + 46 + 47)]);
    expect(playAll.kind === 'tv' && playAll.episodes.map((t) => t.index)).toEqual([0, 1, 2, 3]);
  });

  it('spots a season disc whose "play all" doesn’t add up exactly', () => {
    const tv = (kind: ReturnType<typeof classifyDisc>) =>
      kind.kind === 'tv' ? kind.episodes.map((t) => t.index) : kind.kind;
    // A sitcom season disc: the "play all" adds a recap and menus (8 minutes more than
    // the episodes), but plays the same video segments.
    const eps = [1, 2, 3, 4, 5, 6].map((i) =>
      title(i, 21 + (i % 3) * 0.4, `${i * 10},${i * 10 + 1}`),
    );
    const playAll = title(0, 140, eps.map((e) => e.segments).join(',') + ',99');
    expect(tv(classifyDisc([playAll, ...eps, title(7, 4)]))).toEqual([1, 2, 3, 4, 5, 6]);
    // The episodes aren't next to each other (a featurette in between) and there are no
    // segment maps: the total still adds up to the long title, give or take a little.
    const loose = [title(0, 131, ''), title(1, 22, ''), title(2, 6, ''), title(3, 22, '')].concat(
      [4, 5, 6, 7].map((i) => title(i, 22, '')),
    );
    expect(tv(classifyDisc(loose))).toEqual([1, 3, 4, 5, 6, 7]);
    // A label that says it's a season wins over a long bonus title.
    const bonus = [title(0, 95), ...[1, 2, 3, 4].map((i) => title(i, 22))];
    expect(tv(classifyDisc(bonus))).toBe('movie');
    expect(tv(classifyDisc(bonus, { tvHint: true }))).toEqual([1, 2, 3, 4]);
    // …but a movie with featurettes and no such label stays a movie.
    expect(tv(classifyDisc([title(0, 118), title(1, 24), title(2, 21), title(3, 26)]))).toBe(
      'movie',
    );
  });

  it('still picks the movie when a disc also has episode-length extras', () => {
    const extras = [1, 2, 3].map((i) => title(i, 25));
    expect(chooseMainTitle([title(0, 118), ...extras])).toMatchObject({
      kind: 'main',
      title: { index: 0 },
    });
  });

  it('explains MakeMKV errors people can fix', () => {
    expect(readErrorHint('Drive opened in OS access mode. Failed to open disc')).toMatch(
      /Full Disk Access/,
    );
    expect(readErrorHint('This application version is too old.')).toMatch(/Register/);
    expect(readErrorHint('The evaluation period has expired.')).toMatch(/beta key/);
    expect(
      readErrorHint(
        "Error 'Scsi error - MEDIUM ERROR:UNRECOVERED READ ERROR' occurred while reading '/VIDEO_TS/VTS_02_1.VOB'",
      ),
    ).toMatch(/soft cloth/);
    expect(readErrorHint('Read error')).toBe('');
  });
});

describe('HandBrake settings', () => {
  it('keeps subtitle tracks in the chosen languages, switched off', () => {
    expect(loadRipperConfig({}).subtitleLanguages).toEqual(['eng']);
    expect(loadRipperConfig({ HANDBRAKE_SUBTITLES: 'eng, spa' }).subtitleLanguages).toEqual([
      'eng',
      'spa',
    ]);
    expect(loadRipperConfig({ HANDBRAKE_SUBTITLES: 'none' }).subtitleLanguages).toEqual([]);
    const args = encodeArgs('in.mkv', 'out.mp4', 'Fast 1080p30', 20, ['eng']);
    expect(args.join(' ')).toContain(
      '--subtitle-lang-list eng --all-subtitles --subtitle-default=none',
    );
    expect(encodeArgs('in.mkv', 'out.mp4', 'Fast 1080p30', 20).join(' ')).not.toContain('subtitle');
  });
});

describe('HandBrake output', () => {
  it('reads encode progress and scanned duration', () => {
    expect(
      parseEncodeProgress(
        'Encoding: task 1 of 1, 45.67 % (85.21 fps, avg 90.12 fps, ETA 00h12m03s)',
      ),
    ).toBeCloseTo(0.4567);
    expect(parseEncodeProgress('Encoding: task 2 of 2, 50.00 %')).toBeCloseTo(0.75);
    expect(parseScanDuration('+ title 1:\n  + duration: 01:45:12\n')).toBe(6312);
    expect(parseScanDuration('no title found')).toBeNull();
  });
});

describe('naming', () => {
  it('turns disc labels into searchable titles', () => {
    expect(guessTitle('', 'YOUNG_FRANKENSTEIN')).toBe('Young Frankenstein');
    expect(guessTitle('', 'THE_GOOD_THE_BAD_AND_THE_UGLY_WS')).toBe(
      'The Good the Bad and the Ugly',
    );
    expect(guessTitle('', 'ROCKY_II_D1')).toBe('Rocky II');
    expect(guessTitle('', 'FULL_METAL_JACKET')).toBe('Full Metal Jacket');
    expect(guessTitle('', 'APOLLO_13_SE')).toBe('Apollo 13');
    // MakeMKV's own disc title wins when it is real metadata.
    expect(guessTitle('Young Frankenstein', 'YF_DVD')).toBe('Young Frankenstein');
  });

  const c = (title: string, year: number, tmdbId: string) => ({
    title,
    year,
    tmdbId,
    imdbId: null,
  });

  it('is confident only with exactly one exact match', () => {
    const one = identify('the young frankenstein', [
      c('Young Frankenstein', 1974, '3034'),
      c('Frankenstein', 1931, '3035'),
    ]);
    expect(one).toMatchObject({ kind: 'confident', match: { year: 1974 } });
    const remakes = identify('Godzilla', [c('Godzilla', 2014, '1'), c('Godzilla', 1954, '2')]);
    expect(remakes.kind).toBe('unsure');
    const none = identify('Disc 1', [c('Disco', 2008, '3')]);
    expect(none.kind).toBe('unsure');
  });

  it('asks when a better-known movie ranks above the exact title match', () => {
    const hope = identify('A New Hope', [c('Star Wars', 1977, '11'), c('A New Hope', 2009, '9')]);
    expect(hope.kind).toBe('unsure');
    expect(hope.kind === 'unsure' && hope.candidates.map((x) => x.year)).toEqual([1977, 2009]);
  });

  it('reads the show, season and disc from TV disc labels', () => {
    expect(guessTv('', 'THE_OFFICE_S1_D2')).toEqual({ show: 'The Office', season: 1, disc: 2 });
    expect(guessTv('', 'FRIENDS_SEASON_3_DISC_1')).toEqual({ show: 'Friends', season: 3, disc: 1 });
    expect(guessTv('', 'SEINFELD_S5D1')).toEqual({ show: 'Seinfeld', season: 5, disc: 1 });
    expect(guessTv('', 'LOST_SEASON2_D4')).toEqual({ show: 'Lost', season: 2, disc: 4 });
    expect(guessTv('', 'SHERLOCK_SERIES_1')).toEqual({ show: 'Sherlock', season: 1, disc: null });
    expect(guessTv('The Wire: Season 4 (Disc 2)', 'WIRE_S4')).toEqual({
      show: 'The Wire',
      season: 4,
      disc: 2,
    });
    expect(guessTv('', 'BAND_OF_BROTHERS')).toEqual({
      show: 'Band of Brothers',
      season: null,
      disc: null,
    });
  });

  it('names episodes the way Jellyfin expects', () => {
    expect(
      episodeFileNames({ title: 'The Office', year: 2005, tmdbId: '2316', season: 1, episode: 5 }),
    ).toEqual({
      folder: 'The Office (2005) [tmdbid-2316]',
      seasonFolder: 'Season 01',
      file: 'The Office S01E05.mp4',
    });
    expect(
      episodeFileNames({ title: 'M*A*S*H', year: null, tmdbId: null, season: 11, episode: 16 }),
    ).toEqual({ folder: 'M A S H', seasonFolder: 'Season 11', file: 'M A S H S11E16.mp4' });
  });

  it('builds Jellyfin-friendly, filesystem-safe names', () => {
    expect(movieFileNames({ title: 'Young Frankenstein', year: 1974, tmdbId: '3034' })).toEqual({
      folder: 'Young Frankenstein (1974) [tmdbid-3034]',
      file: 'Young Frankenstein (1974).mp4',
    });
    expect(safeFileName('Mission: Impossible / Fallout?')).toBe('Mission Impossible Fallout');
    expect(movieFileNames({ title: 'Se7en', year: null, tmdbId: null }).file).toBe('Se7en.mp4');
  });
});

describe('running tools', () => {
  it('streams progress lines that end in carriage returns', async () => {
    const lines: string[] = [];
    const result = await runProcess(
      process.execPath,
      [
        '-e',
        "process.stdout.write('a 10%\\ra 20%\\rdone\\n'); process.stderr.write('warn\\n'); process.exit(3)",
      ],
      { onLine: (l) => lines.push(l) },
    );
    expect(result.code).toBe(3);
    expect(lines).toEqual(expect.arrayContaining(['a 10%', 'a 20%', 'done', 'warn']));
  });

  it('reports a missing program', async () => {
    await expect(runProcess('/no/such/makemkvcon', [])).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
