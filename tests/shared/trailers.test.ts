import { describe, expect, it } from 'vitest';
import { toTrailer } from '../../src/shared/trailers';

describe('trailers', () => {
  it('embeds YouTube trailers in the privacy-enhanced player', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'http://youtube.com/watch?v=dQw4w9WgXcQ&t=10s',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    ]) {
      expect(toTrailer('Official Trailer', url)).toEqual({
        name: 'Official Trailer',
        kind: 'youtube',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        embedUrl:
          'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&modestbranding=1',
      });
    }
  });

  it('links to other sites and rejects junk', () => {
    expect(toTrailer('', 'https://vimeo.com/123')).toMatchObject({ kind: 'link', name: 'Trailer' });
    expect(toTrailer('x', 'javascript:alert(1)')).toBeNull();
    expect(toTrailer('x', 'not a url')).toBeNull();
    expect(toTrailer('x', 'https://youtube.com/watch?v=<script>')).toMatchObject({ kind: 'link' });
  });
});
