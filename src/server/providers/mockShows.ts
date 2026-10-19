// TV shows for the built-in sample library. Unlike the sample films these are
// made up (titles, episodes and synopses), so no real show's details can be
// wrong. Artwork is generated like the films' (see mockArt.ts).

export interface SampleEpisode {
  title: string;
  runtime: number;
  overview: string;
}

export interface SampleShow {
  id: string;
  title: string;
  year: number;
  endYear: number | null;
  genres: string[];
  rating: string | null;
  cast: string[];
  overview: string;
  /** Seasons in order, starting at season 1. */
  seasons: SampleEpisode[][];
}

export const SAMPLE_SHOWS: SampleShow[] = [
  {
    id: 'harbour-lights',
    title: 'Harbour Lights',
    year: 2019,
    endYear: null,
    genres: ['Drama', 'Mystery'],
    rating: 'TV-14',
    cast: ['Sample Cast'],
    overview:
      'A harbourmaster in a small fishing town keeps a log of every boat that comes in, until one arrives that nobody sent.',
    seasons: [
      [
        {
          title: 'Low Tide',
          runtime: 48,
          overview: 'An unmarked trawler drifts into the harbour at dawn with its lights still on.',
        },
        {
          title: 'The Log',
          runtime: 46,
          overview: 'Pages are missing from the harbour log, and only three people had the key.',
        },
        {
          title: 'Fog Bell',
          runtime: 47,
          overview: 'A storm cuts the town off, and the old fog bell rings on its own.',
        },
        {
          title: 'Moorings',
          runtime: 51,
          overview: 'The trawler’s owner finally comes ashore, and the town wishes he hadn’t.',
        },
      ],
      [
        {
          title: 'Spring Tide',
          runtime: 49,
          overview: 'A year on, a new harbourmaster starts, and finds the old log in a drawer.',
        },
        {
          title: 'Salt',
          runtime: 45,
          overview: 'The fish market reopens, and so does an old argument.',
        },
        {
          title: 'Lighthouse',
          runtime: 50,
          overview: 'Someone has been living in the lighthouse all winter.',
        },
      ],
    ],
  },
  {
    id: 'the-night-kitchen',
    title: 'The Night Kitchen',
    year: 2022,
    endYear: 2022,
    genres: ['Comedy'],
    rating: 'TV-PG',
    cast: ['Sample Cast'],
    overview:
      'The overnight crew of a 24-hour diner serve truckers, insomniacs and one regular who only ever orders toast.',
    seasons: [
      [
        {
          title: 'Opening Shift',
          runtime: 22,
          overview:
            'A new cook starts on the busiest night of the year: the night the clocks go back.',
        },
        {
          title: 'The Toast Guy',
          runtime: 21,
          overview: 'The crew bet on what the toast regular does for a living.',
        },
        {
          title: 'Health Inspector',
          runtime: 23,
          overview: 'An inspection at 3 a.m. — or is it someone pretending?',
        },
        {
          title: 'Power Cut',
          runtime: 22,
          overview: 'The lights go out and the grill is the only thing still working.',
        },
        {
          title: 'Breakfast Rush',
          runtime: 22,
          overview: 'The night crew are asked to stay for the morning. It goes badly.',
        },
        {
          title: 'Last Orders',
          runtime: 24,
          overview: 'The diner may be sold, and the regulars have an idea.',
        },
      ],
    ],
  },
  {
    id: 'small-hours',
    title: 'Small Hours',
    year: 2016,
    endYear: 2018,
    genres: ['Documentary'],
    rating: 'TV-G',
    cast: [],
    overview: 'Short films about the jobs people do while everyone else is asleep.',
    seasons: [
      [
        {
          title: 'Bakers',
          runtime: 28,
          overview: 'A bakery that has opened at 2 a.m. every day for sixty years.',
        },
        {
          title: 'Lock Keepers',
          runtime: 27,
          overview: 'Night boats on the canal, and the family that lets them through.',
        },
      ],
      [
        {
          title: 'Night Buses',
          runtime: 29,
          overview: 'One route, one driver, and everyone who rides between midnight and five.',
        },
        {
          title: 'Observatory',
          runtime: 30,
          overview: 'The astronomers who need the town’s lights off.',
        },
      ],
      [
        {
          title: 'Radio',
          runtime: 28,
          overview: 'A call-in show for people who can’t sleep.',
        },
      ],
    ],
  },
];

export const pad2 = (n: number) => String(n).padStart(2, '0');

export const sampleEpisodeId = (show: SampleShow, season: number, episode: number) =>
  `${show.id}-s${pad2(season)}e${pad2(episode)}`;
