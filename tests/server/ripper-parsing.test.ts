import { describe, expect, it } from 'vitest';
import { parseEncodeProgress, parseScanDuration } from '../../src/server/ripper/handbrake';
import {
  chooseMainTitle,
  parseDiscInfo,
  parseDrives,
  parseProgress,
  splitFields,
  type DiscTitle,
} from '../../src/server/ripper/makemkv';
import { guessTitle, identify, movieFileNames, safeFileName } from '../../src/server/ripper/naming';
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

  const title = (index: number, minutes: number, segments = String(index)): DiscTitle => ({
    index,
    name: '',
    durationSeconds: minutes * 60,
    sizeBytes: minutes * 1e7,
    chapters: 10,
    segments,
    outputFile: `title_t0${index}.mkv`,
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
