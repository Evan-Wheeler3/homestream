import { describe, expect, it } from 'vitest';
import { findNext, type Box } from '../../src/client/lib/spatialNav';
import { isTvUserAgent, remoteKey } from '../../src/client/lib/tv';

const box = (left: number, top: number, width = 100, height = 150): Box => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

describe('TV detection', () => {
  it('recognises smart-TV browsers', () => {
    // The new LG webOS browser no longer says "Web0S".
    expect(
      isTvUserAgent(
        'Mozilla/5.0 (Linux; NetCast; U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36 SmartTV/10.0 Colt/2.0',
      ),
    ).toBe(true);
    expect(
      isTvUserAgent(
        'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0 Safari/537.36 WebAppManager',
      ),
    ).toBe(true);
    expect(
      isTvUserAgent(
        'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0 TV Safari/537.36',
      ),
    ).toBe(true);
    expect(isTvUserAgent('Mozilla/5.0 (Linux; Android 9; AFTMM) AppleWebKit/537.36')).toBe(true);
  });

  it('leaves phones and computers alone', () => {
    expect(
      isTvUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe(false);
    expect(
      isTvUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
      ),
    ).toBe(false);
  });
});

describe('remote keys', () => {
  it('maps standard key names', () => {
    expect(remoteKey({ key: 'ArrowLeft', keyCode: 37 })).toBe('left');
    expect(remoteKey({ key: 'Enter', keyCode: 13 })).toBe('enter');
    expect(remoteKey({ key: 'MediaPlayPause', keyCode: 179 })).toBe('playPause');
  });

  it('maps LG and Samsung key codes reported as Unidentified', () => {
    expect(remoteKey({ key: 'Unidentified', keyCode: 461 })).toBe('back');
    expect(remoteKey({ key: 'Unidentified', keyCode: 10009 })).toBe('back');
    expect(remoteKey({ key: 'Unidentified', keyCode: 415 })).toBe('play');
    expect(remoteKey({ key: 'Unidentified', keyCode: 19 })).toBe('pause');
    expect(remoteKey({ key: 'Unidentified', keyCode: 417 })).toBe('fastForward');
    expect(remoteKey({ key: 'Unidentified', keyCode: 412 })).toBe('rewind');
  });

  it('ignores ordinary typing', () => {
    expect(remoteKey({ key: 'a', keyCode: 65 })).toBeNull();
  });
});

describe('spatial navigation', () => {
  // Two rows of posters, plus a wide button above the first row.
  const hero = box(0, 0, 300, 60);
  const row1 = [box(0, 200), box(120, 200), box(240, 200), box(360, 200)];
  const row2 = [box(0, 400), box(120, 400), box(240, 400)];
  const all = [hero, ...row1, ...row2];

  it('moves along a row', () => {
    expect(findNext(row1[0]!, all, 'right')).toBe(all.indexOf(row1[1]!));
    expect(findNext(row1[2]!, all, 'left')).toBe(all.indexOf(row1[1]!));
  });

  it('stops at the end of a row instead of jumping to another row', () => {
    expect(findNext(row1[3]!, all, 'right')).toBe(-1);
    expect(findNext(row2[2]!, all, 'right')).toBe(-1);
  });

  it('moves between rows to the item in the same column', () => {
    expect(findNext(row1[1]!, all, 'down')).toBe(all.indexOf(row2[1]!));
    expect(findNext(row2[2]!, all, 'up')).toBe(all.indexOf(row1[2]!));
  });

  it('moves down from the last column to the nearest item below', () => {
    expect(findNext(row1[3]!, all, 'down')).toBe(all.indexOf(row2[2]!));
  });

  it('goes up from a row to the button above it', () => {
    expect(findNext(row1[3]!, all, 'up')).toBe(all.indexOf(hero));
    expect(findNext(hero, all, 'up')).toBe(-1);
  });
});
