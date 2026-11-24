// What the floating VR menu shows: your seat's controls when you're seated,
// otherwise getting about and getting a ticket, or the box office's list.
import type { Showing } from '../../shared/theater';
import type { Movie } from '../../shared/types';
import type { Prompt } from './engine';
import { clock, type VrButton, type VrPanelModel } from './xr';

/** Movies on each page of the VR box office. */
export const VR_PAGE = 5;

export function vrMenu(o: {
  vrPage: { kind: 'main' } | { kind: 'movies'; page: number };
  note: string | null;
  movies: Pick<Movie, 'id' | 'title' | 'year'>[];
  seated: boolean;
  showing: Showing | undefined;
  countdown: number;
  position: number;
  duration: number;
  canControl: boolean;
  needsTap: boolean;
  screenError: string | null;
  place: string;
  ticket: number | null;
  ticketTitle: string | null;
  prompt: Prompt | null;
}): VrPanelModel {
  const lines: string[] = o.note ? [o.note] : [];
  const buttons: VrButton[] = [];
  if (o.vrPage.kind === 'movies') {
    const pages = Math.max(1, Math.ceil(o.movies.length / VR_PAGE));
    const page = Math.min(o.vrPage.page, pages - 1);
    for (const m of o.movies.slice(page * VR_PAGE, (page + 1) * VR_PAGE)) {
      buttons.push({
        id: `movie:${m.id}`,
        label: m.year ? `${m.title} (${m.year})` : m.title,
        wide: true,
      });
    }
    if (pages > 1) buttons.push({ id: 'prev', label: 'Previous' }, { id: 'next', label: 'More' });
    buttons.push({ id: 'main', label: 'Close', wide: true });
    return {
      title: 'Box office: pick a movie',
      lines: [...lines, `Newest first · page ${page + 1} of ${pages}`],
      buttons,
    };
  }
  if (o.seated && o.showing) {
    const s = o.showing;
    const state =
      o.countdown > 0
        ? 'Starting'
        : s.status === 'playing'
          ? 'Playing'
          : s.status === 'paused'
            ? 'Paused'
            : s.status === 'ended'
              ? 'The end'
              : 'Waiting to start';
    lines.unshift(`${state} · ${clock(o.position)}${o.duration ? ` of ${clock(o.duration)}` : ''}`);
    if (o.screenError) lines.push(o.screenError);
    if (o.needsTap)
      buttons.push({ id: 'sound', label: 'Turn on the sound', primary: true, wide: true });
    if (o.canControl) {
      buttons.push(
        {
          id: 'toggle',
          label: s.status === 'playing' ? 'Pause' : 'Play',
          primary: !o.needsTap,
          wide: true,
        },
        { id: 'back', label: 'Back 10 s' },
        { id: 'ahead', label: 'Ahead 30 s' },
      );
    }
    buttons.push(
      { id: 'stand', label: 'Stand up' },
      { id: 'hide', label: 'Hide menu' },
      { id: 'exit', label: 'Exit VR', wide: true },
    );
    lines.push('Pinch anywhere to bring this menu back.');
    return { title: s.title, lines, buttons };
  }
  if (o.ticket)
    lines.push(`Ticket: Theater ${o.ticket}${o.ticketTitle ? ` · ${o.ticketTitle}` : ''}`);
  lines.push('Point at the floor and pinch to go there.');
  const p = o.prompt;
  if (p && p.kind !== 'stand') {
    const label =
      p.kind === 'boxoffice'
        ? 'Box office: get a ticket'
        : p.kind === 'poster'
          ? `Get a ticket: ${o.movies.find((m) => m.id === p.movieId)?.title ?? 'this movie'}`
          : p.label;
    buttons.push({ id: 'use', label, primary: true, wide: true });
  }
  if (o.ticket) {
    buttons.push({ id: 'sit', label: `Sit down in Theater ${o.ticket}`, primary: !p, wide: true });
  }
  buttons.push(
    { id: 'movies', label: 'Get a ticket' },
    { id: 'lobby', label: 'Lobby' },
    { id: 'left', label: 'Turn left' },
    { id: 'right', label: 'Turn right' },
  );
  if (o.ticket) buttons.push({ id: 'return', label: 'Return ticket', wide: true });
  buttons.push({ id: 'hide', label: 'Hide menu' }, { id: 'exit', label: 'Exit VR' });
  return { title: o.place, lines, buttons };
}
