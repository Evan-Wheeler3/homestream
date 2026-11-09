// A statue designed by hand for each movie in the library (by its id), from
// something in the film: an object or a place, never a character or a logo.
// Boxes are on the statue grid (shared/theater.ts): 16 across, 24 up, 16 deep,
// in 1/16 m, with the front facing the corridor at z = 16. Movies without one
// here get a statue for their genre (statues.ts).
import type { StatueBox, StatueSpec } from '../../shared/theater';

const b = (
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  color: number,
  glow = 0,
): StatueBox => [x0, y0, z0, x1, y1, z1, color, glow];

export const MOVIE_STATUES: Record<string, StatueSpec> = {
  // Young Frankenstein: the laboratory machine, sparking between its coils.
  'tmdb-3034': {
    name: 'The Laboratory',
    boxes: [
      b(2, 0, 4, 14, 6, 12, 0x3a3f45),
      b(2, 6, 4, 14, 7, 12, 0x2a2e33),
      b(4, 3, 12, 5, 4, 13, 0xff4040, 1),
      b(7, 3, 12, 8, 4, 13, 0x40ff70, 1),
      b(10, 3, 12, 11, 4, 13, 0xffd040, 1),
      ...[3, 11].flatMap((x) => [
        b(x, 7, 7, x + 2, 18, 9, 0xb87333),
        b(x - 1, 9, 6, x + 3, 10, 10, 0x8a5523),
        b(x - 1, 12, 6, x + 3, 13, 10, 0x8a5523),
        b(x - 1, 15, 6, x + 3, 16, 10, 0x8a5523),
        b(x - 1, 18, 6, x + 3, 20, 10, 0x9fdcff, 1),
      ]),
      b(6, 19, 7, 8, 20, 9, 0xbfe8ff, 1),
      b(7, 20, 7, 9, 21, 9, 0xbfe8ff, 1),
      b(8, 19, 7, 10, 20, 9, 0xbfe8ff, 1),
    ],
  },
  // Eternal Sunshine of the Spotless Mind: the memory-erasing helmet.
  'tmdb-38': {
    name: 'The Procedure',
    boxes: [
      b(4, 0, 4, 12, 1, 12, 0x55595e),
      b(7, 1, 7, 9, 10, 9, 0x9aa0a6),
      b(3, 10, 3, 13, 15, 13, 0xd9dde2),
      b(4, 15, 4, 12, 17, 12, 0xd9dde2),
      b(6, 17, 6, 10, 18, 10, 0xc4c9cf),
      b(3, 10, 3, 13, 11, 13, 0x8d939a),
      ...[4, 7, 10].map((x) => b(x, 12, 13, x + 2, 13, 14, 0xff5a5a, 1)),
      b(2, 12, 7, 3, 13, 9, 0x6ad0ff, 1),
      b(13, 12, 7, 14, 13, 9, 0x6ad0ff, 1),
      b(13, 8, 11, 14, 15, 12, 0x222222),
      b(14, 0, 11, 15, 9, 12, 0x222222),
    ],
  },
  // Star Wars: two suns setting over desert dunes, and a domed hut.
  'tmdb-11': {
    name: 'Two Suns',
    boxes: [
      b(0, 0, 0, 16, 2, 16, 0xd9b37a),
      b(0, 2, 2, 9, 5, 14, 0xe2c08a),
      b(2, 5, 4, 7, 6, 12, 0xe8c995),
      b(8, 2, 3, 16, 4, 13, 0xcda06a),
      b(10, 4, 9, 14, 7, 14, 0xeee2cc),
      b(11, 7, 10, 13, 8, 13, 0xeee2cc),
      b(11, 4, 13, 13, 6, 14, 0x3a2a1a),
      b(2, 14, 3, 7, 19, 6, 0xffb347, 1),
      b(9, 17, 3, 13, 21, 6, 0xff7a3d, 1),
    ],
  },
  // Punch-Drunk Love: the harmonium, and a pudding cup.
  'tmdb-8051': {
    name: 'The Harmonium',
    boxes: [
      b(2, 0, 4, 14, 8, 12, 0x8b5a2b),
      b(2, 8, 4, 14, 9, 12, 0x6e4420),
      b(3, 7, 12, 13, 8, 14, 0xf4f0e6),
      ...[4, 6, 9, 11].map((x) => b(x, 8, 12, x + 1, 9, 13, 0x111111)),
      ...[1, 3, 5].map((y) => b(3, y, 2, 13, y + 1, 4, 0xb04060)),
      ...[2, 4, 6].map((y) => b(3, y, 2, 13, y + 1, 4, 0x7a2840)),
      b(13, 0, 12, 16, 3, 15, 0xe8d5a0),
      b(13, 3, 12, 16, 4, 15, 0x2b6fd6),
    ],
  },
  // Magnolia: a frog in a puddle, with more coming down.
  'tmdb-334': {
    name: 'The Downpour',
    boxes: [
      b(1, 0, 1, 15, 1, 15, 0x3b6ea8),
      b(4, 1, 4, 12, 5, 12, 0x4c9a3a),
      b(5, 5, 7, 11, 8, 13, 0x5fb04a),
      b(5, 8, 10, 7, 10, 12, 0xf2f2e8),
      b(9, 8, 10, 11, 10, 12, 0xf2f2e8),
      b(5, 8, 12, 7, 9, 13, 0x111111),
      b(9, 8, 12, 11, 9, 13, 0x111111),
      b(6, 6, 13, 10, 7, 14, 0x2f6b25),
      b(2, 1, 4, 4, 3, 9, 0x3f8a30),
      b(12, 1, 4, 14, 3, 9, 0x3f8a30),
      b(4, 1, 11, 6, 2, 14, 0x3f8a30),
      b(10, 1, 11, 12, 2, 14, 0x3f8a30),
      b(2, 10, 3, 3, 12, 4, 0x9fd3ff, 1),
      b(13, 14, 5, 14, 16, 6, 0x9fd3ff, 1),
      b(3, 18, 10, 4, 20, 11, 0x9fd3ff, 1),
      b(11, 20, 2, 12, 22, 3, 0x9fd3ff, 1),
    ],
  },
  // L.A. Confidential: a 1950s police badge.
  'tmdb-2118': {
    name: 'The Badge',
    boxes: [
      b(6, 0, 6, 10, 4, 10, 0x2b2b2b),
      b(3, 4, 7, 13, 14, 9, 0xd4a52c),
      b(5, 2, 7, 11, 4, 9, 0xd4a52c),
      b(2, 13, 7, 4, 16, 9, 0xd4a52c),
      b(12, 13, 7, 14, 16, 9, 0xd4a52c),
      b(6, 14, 7, 10, 17, 9, 0xd4a52c),
      b(3, 4, 9, 13, 5, 10, 0xa57d1c),
      b(6, 7, 9, 10, 12, 10, 0x1d3d7a),
      b(7, 8, 10, 9, 11, 11, 0xffe9a0, 1),
    ],
  },
  // Pulp Fiction: the briefcase, open, glowing.
  'tmdb-680': {
    name: 'The Briefcase',
    boxes: [
      b(2, 0, 4, 14, 6, 12, 0x1a1a1a),
      b(2, 6, 3, 14, 16, 5, 0x1a1a1a),
      b(6, 2, 12, 10, 3, 13, 0x333333),
      b(4, 4, 12, 5, 6, 13, 0xd9b44a),
      b(11, 4, 12, 12, 6, 13, 0xd9b44a),
      b(3, 5, 5, 13, 6, 11, 0xffd35a, 1),
      b(5, 6, 6, 11, 10, 10, 0xffe38a, 1),
      b(3, 7, 5, 13, 15, 6, 0x2a2a2a),
    ],
  },
  // Vanilla Sky: a painted sunset sky on an easel.
  'tmdb-1903': {
    name: 'The Painted Sky',
    boxes: [
      b(3, 0, 6, 4, 18, 7, 0x8b5a2b),
      b(12, 0, 6, 13, 18, 7, 0x8b5a2b),
      b(8, 0, 2, 9, 16, 3, 0x8b5a2b),
      b(2, 5, 6, 14, 6, 9, 0x8b5a2b),
      b(2, 6, 7, 14, 10, 8, 0xf2a46c),
      b(2, 10, 7, 14, 14, 8, 0xf4d8a8),
      b(2, 14, 7, 14, 20, 8, 0x9ec9ea),
      b(4, 15, 8, 8, 17, 9, 0xffffff),
      b(5, 17, 8, 7, 18, 9, 0xffffff),
      b(9, 12, 8, 12, 14, 9, 0xffffff),
      b(2, 20, 6, 14, 21, 8, 0xd9c08a),
    ],
  },
  // Reservoir Dogs: the diamonds, and a pair of black sunglasses.
  'tmdb-500': {
    name: 'The Stones',
    boxes: [
      b(3, 0, 3, 13, 3, 13, 0x6b1020),
      b(4, 3, 5, 7, 6, 8, 0xbff3ff, 1),
      b(8, 3, 4, 11, 7, 8, 0xd8f8ff, 1),
      b(6, 3, 8, 9, 5, 11, 0xbff3ff, 1),
      b(10, 3, 8, 12, 5, 11, 0xd8f8ff, 1),
      b(7, 6, 5, 9, 8, 7, 0xffffff, 1),
      b(3, 3, 12, 7, 5, 14, 0x111111),
      b(9, 3, 12, 13, 5, 14, 0x111111),
      b(7, 4, 12, 9, 5, 13, 0x111111),
      b(2, 3, 12, 3, 4, 13, 0x111111),
      b(13, 3, 12, 14, 4, 13, 0x111111),
    ],
  },
  // GoodFellas: Sunday sauce on the stove.
  'tmdb-769': {
    name: 'Sunday Sauce',
    boxes: [
      b(1, 0, 2, 15, 6, 14, 0xd8d8d8),
      b(2, 1, 14, 14, 5, 15, 0x9aa0a6),
      b(4, 6, 5, 12, 7, 13, 0xff5a1a, 1),
      b(3, 7, 4, 13, 15, 14, 0x9aa3ad),
      b(2, 14, 3, 14, 15, 15, 0x7d858e),
      b(4, 15, 5, 12, 16, 13, 0xb3261e),
      b(0, 11, 8, 2, 12, 10, 0x2a2a2a),
      b(14, 11, 8, 16, 12, 10, 0x2a2a2a),
      b(10, 14, 8, 11, 21, 9, 0xc89a5b),
      b(6, 17, 8, 7, 19, 9, 0xf4f4f4, 1),
      b(8, 18, 9, 9, 21, 10, 0xf4f4f4, 1),
      b(5, 20, 7, 6, 22, 8, 0xf4f4f4, 1),
    ],
  },
  // The Man Who Wasn't There: the barber pole outside the shop.
  'tmdb-10778': {
    name: 'The Barber Pole',
    boxes: [
      b(5, 0, 5, 11, 2, 11, 0x9aa0a6),
      ...[0x9c1c26, 0xf2f2f2, 0x1f3c88, 0xf2f2f2, 0x9c1c26, 0xf2f2f2, 0x1f3c88, 0xf2f2f2].map(
        (color, i) => b(6, 2 + i * 2, 6, 10, 4 + i * 2, 10, color),
      ),
      b(5, 18, 5, 11, 20, 11, 0xc0c4c8),
      b(6, 20, 6, 10, 23, 10, 0xfff4c2, 1),
    ],
  },
  // Glengarry Glen Ross: the office phone, and a stack of leads.
  'tmdb-9504': {
    name: 'The Leads',
    boxes: [
      b(0, 0, 2, 16, 6, 14, 0x6b4423),
      b(0, 6, 2, 16, 7, 14, 0x4e3119),
      b(4, 7, 5, 12, 10, 12, 0x1a1a1a),
      b(6, 10, 7, 10, 11, 11, 0x3a3a3a),
      b(3, 11, 7, 13, 13, 10, 0x1a1a1a),
      b(3, 10, 7, 5, 11, 10, 0x1a1a1a),
      b(11, 10, 7, 13, 11, 10, 0x1a1a1a),
      b(12, 7, 12, 13, 9, 13, 0x1a1a1a),
      b(13, 7, 3, 16, 9, 8, 0xf5f0dc),
      b(13, 9, 3, 16, 10, 8, 0xc8102e),
    ],
  },
  // The Prestige: the magician's top hat, a dove, and electricity in the air.
  'tmdb-1124': {
    name: 'The Trick',
    boxes: [
      b(4, 0, 4, 12, 1, 12, 0x2a1f1a),
      b(7, 1, 7, 9, 8, 9, 0x2a1f1a),
      b(2, 8, 2, 14, 9, 14, 0x3a2a22),
      b(3, 9, 3, 13, 10, 13, 0x111111),
      b(5, 10, 5, 11, 17, 11, 0x111111),
      b(4, 11, 4, 12, 12, 12, 0x7a1020),
      b(7, 17, 7, 10, 19, 10, 0xf4f4f4),
      b(9, 19, 8, 11, 20, 9, 0xf4f4f4),
      b(11, 19, 8, 12, 20, 9, 0xf0a020),
      b(2, 14, 6, 3, 18, 7, 0xa8d8ff, 1),
      b(3, 18, 6, 5, 19, 7, 0xa8d8ff, 1),
      b(13, 13, 9, 14, 17, 10, 0xa8d8ff, 1),
      b(11, 17, 9, 13, 18, 10, 0xa8d8ff, 1),
    ],
  },
  // A Hard Day's Night: the drum kit, and a cymbal.
  'tmdb-704': {
    name: 'The Kit',
    boxes: [
      b(4, 0, 5, 5, 2, 9, 0x9aa0a6),
      b(11, 0, 5, 12, 2, 9, 0x9aa0a6),
      b(3, 1, 5, 13, 11, 9, 0x1d1d1d),
      b(3, 1, 9, 13, 11, 10, 0xfafafa),
      b(3, 1, 4, 13, 11, 5, 0xc0c4c8),
      b(6, 11, 5, 10, 14, 9, 0x1d1d1d),
      b(6, 14, 5, 10, 15, 9, 0xfafafa),
      b(0, 8, 10, 5, 11, 14, 0xb0b4b8),
      b(0, 11, 10, 5, 12, 14, 0xfafafa),
      b(13, 0, 11, 14, 17, 12, 0x9aa0a6),
      b(10, 17, 9, 16, 18, 15, 0xd9b44a),
      b(1, 12, 11, 7, 13, 12, 0xd8b27a),
      b(2, 12, 13, 8, 13, 14, 0xd8b27a),
    ],
  },
  // Insomnia: pine trees in the snow, under a sun that never sets.
  'tmdb-320': {
    name: 'The Midnight Sun',
    boxes: [
      b(0, 0, 0, 16, 2, 16, 0xf0f4f8),
      b(3, 2, 9, 5, 5, 11, 0x5a3a1e),
      b(1, 5, 7, 7, 9, 13, 0x2f6b3a),
      b(2, 9, 8, 6, 12, 12, 0x2f6b3a),
      b(3, 12, 9, 5, 15, 11, 0x2f6b3a),
      b(3, 15, 9, 5, 16, 11, 0xf0f4f8),
      b(10, 2, 10, 12, 4, 12, 0x5a3a1e),
      b(8, 4, 8, 14, 7, 14, 0x2a5c33),
      b(9, 7, 9, 13, 10, 13, 0x2a5c33),
      b(10, 10, 10, 12, 12, 12, 0x2a5c33),
      b(11, 17, 2, 16, 22, 5, 0xffd060, 1),
    ],
  },
  // Kill Bill: Vol. 1: a katana on its rack, with yellow cloth.
  'tmdb-24': {
    name: 'The Blade',
    boxes: [
      b(2, 0, 5, 14, 2, 11, 0x2a1a12),
      b(5, 2, 4, 11, 4, 12, 0xf2c618),
      b(3, 2, 7, 5, 12, 9, 0x2a1a12),
      b(11, 2, 7, 13, 12, 9, 0x2a1a12),
      b(1, 12, 7, 12, 13, 9, 0x141414),
      b(12, 12, 7, 16, 13, 9, 0x3a2a1a),
      b(11, 11, 6, 12, 14, 10, 0xc9a227),
      b(1, 8, 7, 10, 9, 9, 0xd8dde3),
      b(10, 8, 7, 14, 9, 9, 0x3a2a1a),
      b(9, 7, 6, 10, 10, 10, 0xc9a227),
    ],
  },
  // The Usual Suspects: the pinboard of notes, and a smashed coffee cup.
  'tmdb-629': {
    name: 'The Pinboard',
    boxes: [
      b(2, 0, 6, 3, 4, 7, 0x5a3a1e),
      b(13, 0, 6, 14, 4, 7, 0x5a3a1e),
      b(0, 3, 5, 16, 4, 8, 0x5a3a1e),
      b(0, 20, 5, 16, 21, 8, 0x5a3a1e),
      b(0, 4, 5, 1, 20, 8, 0x5a3a1e),
      b(15, 4, 5, 16, 20, 8, 0x5a3a1e),
      b(1, 4, 6, 15, 20, 8, 0xb9875a),
      b(3, 14, 8, 7, 18, 9, 0xf4f0e6),
      b(8, 12, 8, 12, 17, 9, 0xf4f0e6),
      b(4, 7, 8, 9, 11, 9, 0xf4f0e6),
      b(10, 6, 8, 14, 10, 9, 0xf4f0e6),
      b(5, 17, 9, 6, 18, 10, 0xd0202a),
      b(10, 16, 9, 11, 17, 10, 0xd0202a),
      b(6, 10, 9, 7, 11, 10, 0xd0202a),
      b(12, 9, 9, 13, 10, 10, 0xd0202a),
      b(10, 0, 11, 13, 3, 14, 0xf2f2f2),
      b(6, 0, 12, 8, 1, 13, 0xf2f2f2),
      b(3, 0, 13, 4, 1, 15, 0xf2f2f2),
    ],
  },
  // Kill Bill: Vol. 2: a coffin under the dirt, and the shovel.
  'tmdb-393': {
    name: 'Buried',
    boxes: [
      b(0, 0, 0, 16, 4, 16, 0x5a3d24),
      b(3, 4, 2, 13, 8, 14, 0x7a4e2c),
      b(3, 8, 2, 13, 9, 14, 0x5e3b20),
      b(4, 8, 4, 12, 9, 5, 0x4a2e18),
      b(7, 9, 11, 9, 10, 13, 0xfff2b0, 1),
      b(13, 4, 6, 14, 20, 7, 0x8b5a2b),
      b(12, 19, 6, 15, 20, 7, 0x8b5a2b),
      b(12, 2, 5, 15, 6, 8, 0x9aa0a6),
    ],
  },
};
