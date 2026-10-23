import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  Collection,
  CollectionDetail,
  EpisodeDetail,
  Facets,
  HomePayload,
  Movie,
  MovieDetail,
  MovieQuery,
  MovieUserState,
  Page,
  PersonalData,
  Preferences,
  RipCandidate,
  RipJob,
  RipKind,
  RipsPayload,
  ServerStatus,
  SessionInfo,
  ShowDetail,
  ShowsPayload,
  SmartRules,
} from '../../shared/types';
import { api } from './api';

export const keys = {
  session: ['session'] as const,
  prefs: ['prefs'] as const,
  home: ['home'] as const,
  movies: (qs: string) => ['movies', qs] as const,
  facets: ['facets'] as const,
  movie: (id: string) => ['movie', id] as const,
  similar: (id: string) => ['similar', id] as const,
  collections: ['collections'] as const,
  collection: (id: string) => ['collection', id] as const,
  status: ['status'] as const,
  rips: ['rips'] as const,
  shows: ['shows'] as const,
  show: (id: string) => ['show', id] as const,
  episode: (id: string) => ['episode', id] as const,
};

/** Serialise a MovieQuery into the backend's query-string format. */
export function movieQueryString(query: MovieQuery): string {
  const params = new URLSearchParams();
  const multi = (key: string, values?: string[]) => {
    if (values?.length) params.set(key, values.join('|'));
  };
  if (query.q) params.set('q', query.q);
  multi('genre', query.genres);
  multi('director', query.directors);
  multi('actor', query.actors);
  multi('country', query.countries);
  multi('tag', query.tags);
  multi('studio', query.studios);
  multi('rating', query.ratings);
  if (query.yearMin != null) params.set('yearMin', String(query.yearMin));
  if (query.yearMax != null) params.set('yearMax', String(query.yearMax));
  if (query.runtimeMin != null) params.set('runtimeMin', String(query.runtimeMin));
  if (query.runtimeMax != null) params.set('runtimeMax', String(query.runtimeMax));
  if (query.watched) params.set('watched', query.watched);
  if (query.favorite) params.set('favorite', '1');
  if (query.watchlist) params.set('watchlist', '1');
  multi('ids', query.ids);
  if (query.sort) params.set('sort', query.sort);
  if (query.dir) params.set('dir', query.dir);
  return params.toString();
}

// -----------------------------------------------------------------------------
// Queries

export function useSession() {
  return useQuery({
    queryKey: keys.session,
    queryFn: () => api<SessionInfo>('/auth/session'),
    // Offline, go straight to the downloads instead of retrying.
    retry: (count, error) =>
      !(error as { isAuth?: boolean }).isAuth && count < 2 && navigator.onLine !== false,
    staleTime: 5 * 60_000,
  });
}

export function usePreferences(enabled = true) {
  return useQuery({
    queryKey: keys.prefs,
    queryFn: () => api<Preferences>('/preferences'),
    enabled,
    staleTime: 60_000,
  });
}

export function useHome() {
  return useQuery({
    queryKey: keys.home,
    queryFn: () => api<HomePayload>('/home'),
    staleTime: 30_000,
  });
}

export const PAGE_SIZE = 60;

export function useMovies(query: MovieQuery, enabled = true) {
  const qs = movieQueryString(query);
  return useInfiniteQuery({
    queryKey: keys.movies(qs),
    queryFn: ({ pageParam, signal }) =>
      api<Page<Movie>>(`/movies?${qs}${qs ? '&' : ''}offset=${pageParam}&limit=${PAGE_SIZE}`, {
        signal,
      }),
    initialPageParam: 0,
    getNextPageParam: (last) =>
      last.offset + last.items.length < last.total ? last.offset + last.items.length : undefined,
    placeholderData: keepPreviousData,
    enabled,
    staleTime: 30_000,
  });
}

export function useFacets() {
  return useQuery({
    queryKey: keys.facets,
    queryFn: () => api<Facets>('/movies/facets'),
    staleTime: 60_000,
  });
}

export function useMovie(id: string, enabled = true) {
  return useQuery({
    queryKey: keys.movie(id),
    queryFn: () => api<MovieDetail>(`/movies/${id}`),
    enabled,
  });
}

// TV shows ---------------------------------------------------------------------

export function useShows() {
  return useQuery({ queryKey: keys.shows, queryFn: () => api<ShowsPayload>('/shows') });
}

export function useShow(id: string) {
  return useQuery({ queryKey: keys.show(id), queryFn: () => api<ShowDetail>(`/shows/${id}`) });
}

export function useEpisode(id: string, enabled = true) {
  return useQuery({
    queryKey: keys.episode(id),
    queryFn: () => api<EpisodeDetail>(`/episodes/${id}`),
    enabled,
  });
}

/** Refetch everything that shows TV watch state. */
export function invalidateShows(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: keys.shows });
  void qc.invalidateQueries({ queryKey: ['show'] });
  void qc.invalidateQueries({ queryKey: ['episode'] });
}

export function useToggleEpisodePlayed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; played: boolean }) =>
      api<MovieUserState>(`/episodes/${v.id}/played`, {
        method: 'PUT',
        body: { played: v.played },
      }),
    onSuccess: () => invalidateShows(qc),
  });
}

export function useSimilar(id: string) {
  return useQuery({
    queryKey: keys.similar(id),
    queryFn: () => api<Movie[]>(`/movies/${id}/similar`),
    staleTime: 10 * 60_000,
    retry: false,
  });
}

export function useCollections() {
  return useQuery({ queryKey: keys.collections, queryFn: () => api<Collection[]>('/collections') });
}

export function useCollection(id: string) {
  return useQuery({
    queryKey: keys.collection(id),
    queryFn: () => api<CollectionDetail>(`/collections/${id}`),
  });
}

export function useStatus() {
  return useQuery({
    queryKey: keys.status,
    queryFn: () => api<ServerStatus>('/status'),
    refetchInterval: 30_000,
  });
}

// -----------------------------------------------------------------------------
// Mutations

/** Library-derived views that depend on watch state / favorites / collections. */
function invalidateLibraryViews(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: keys.home });
  void qc.invalidateQueries({ queryKey: ['movies'] });
  void qc.invalidateQueries({ queryKey: keys.collections });
  void qc.invalidateQueries({ queryKey: ['collection'] });
}

function patchMovieUser(qc: QueryClient, id: string, user: MovieUserState) {
  qc.setQueryData<MovieDetail>(keys.movie(id), (old) => (old ? { ...old, user } : old));
}

export function useToggleFavorite(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (favorite: boolean) =>
      api<MovieUserState>(`/movies/${id}/favorite`, { method: 'PUT', body: { favorite } }),
    onMutate: (favorite) => {
      const previous = qc.getQueryData<MovieDetail>(keys.movie(id));
      if (previous) patchMovieUser(qc, id, { ...previous.user, favorite });
      return { previous };
    },
    onError: (_e, _v, context) => {
      if (context?.previous) qc.setQueryData(keys.movie(id), context.previous);
    },
    onSuccess: (user) => {
      patchMovieUser(qc, id, user);
      invalidateLibraryViews(qc);
    },
  });
}

export function useToggleWatchlist(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (on: boolean) =>
      api<{ onWatchlist: boolean }>(`/movies/${id}/watchlist`, { method: 'PUT', body: { on } }),
    onMutate: (on) => {
      const previous = qc.getQueryData<MovieDetail>(keys.movie(id));
      if (previous) qc.setQueryData(keys.movie(id), { ...previous, onWatchlist: on });
      return { previous };
    },
    onError: (_e, _v, context) => {
      if (context?.previous) qc.setQueryData(keys.movie(id), context.previous);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.home });
      void qc.invalidateQueries({ queryKey: ['movies'] });
    },
  });
}

export function useTogglePlayed(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (played: boolean) =>
      api<MovieUserState>(`/movies/${id}/played`, { method: 'PUT', body: { played } }),
    onSuccess: (user) => {
      patchMovieUser(qc, id, user);
      invalidateLibraryViews(qc);
    },
  });
}

export function useSavePersonal(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { rating?: number | null; notes?: string }) =>
      api<PersonalData>(`/movies/${id}/personal`, { method: 'PUT', body: input }),
    onSuccess: (personal) => {
      qc.setQueryData<MovieDetail>(keys.movie(id), (old) => (old ? { ...old, personal } : old));
      void qc.invalidateQueries({ queryKey: keys.collections });
      void qc.invalidateQueries({ queryKey: ['collection'] });
    },
  });
}

export function useUpdatePreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Preferences>) =>
      api<Preferences>('/preferences', { method: 'PATCH', body: patch }),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: keys.prefs });
      const previous = qc.getQueryData<Preferences>(keys.prefs);
      if (previous) {
        qc.setQueryData<Preferences>(keys.prefs, {
          ...previous,
          ...patch,
          playback: { ...previous.playback, ...(patch.playback ?? {}) },
        });
      }
      return { previous };
    },
    onError: (_e, _v, context) => {
      if (context?.previous) qc.setQueryData(keys.prefs, context.previous);
    },
    onSuccess: (prefs, patch) => {
      qc.setQueryData(keys.prefs, prefs);
      if ('homeSections' in patch || 'heroSource' in patch)
        void qc.invalidateQueries({ queryKey: keys.home });
    },
  });
}

export interface CollectionDraft {
  name: string;
  description: string;
  kind?: 'manual' | 'smart';
  rules?: SmartRules;
  visibility: 'private' | 'shared';
  artwork?: { kind: 'auto' | 'movie'; ref?: string | null };
}

export function useCollectionMutations() {
  const qc = useQueryClient();
  const settle = (detail?: CollectionDetail) => {
    if (detail) qc.setQueryData(keys.collection(detail.id), detail);
    void qc.invalidateQueries({ queryKey: keys.collections });
    void qc.invalidateQueries({ queryKey: keys.home });
    void qc.invalidateQueries({ queryKey: ['movie'] });
  };
  return {
    create: useMutation({
      mutationFn: (draft: CollectionDraft) =>
        api<CollectionDetail>('/collections', { method: 'POST', body: draft }),
      onSuccess: settle,
    }),
    update: useMutation({
      mutationFn: ({ id, ...patch }: Partial<CollectionDraft> & { id: string }) =>
        api<CollectionDetail>(`/collections/${id}`, { method: 'PATCH', body: patch }),
      onSuccess: settle,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api<{ ok: true }>(`/collections/${id}`, { method: 'DELETE' }),
      onSuccess: (_r, id) => {
        qc.removeQueries({ queryKey: keys.collection(id) });
        void qc.invalidateQueries({ queryKey: keys.prefs });
        settle();
      },
    }),
    reorder: useMutation({
      mutationFn: (ids: string[]) => api('/collections/order', { method: 'PUT', body: { ids } }),
      onSuccess: () => settle(),
    }),
    addItems: useMutation({
      mutationFn: ({ id, itemIds }: { id: string; itemIds: string[] }) =>
        api<CollectionDetail>(`/collections/${id}/items`, { method: 'POST', body: { itemIds } }),
      onSuccess: settle,
    }),
    removeItem: useMutation({
      mutationFn: ({ id, itemId }: { id: string; itemId: string }) =>
        api<CollectionDetail>(`/collections/${id}/items/${itemId}`, { method: 'DELETE' }),
      onSuccess: settle,
    }),
    reorderItems: useMutation({
      mutationFn: ({ id, itemIds }: { id: string; itemIds: string[] }) =>
        api<CollectionDetail>(`/collections/${id}/items/order`, {
          method: 'PUT',
          body: { itemIds },
        }),
      onSuccess: settle,
    }),
    uploadArtwork: useMutation({
      mutationFn: ({ id, file }: { id: string; file: File }) =>
        api<CollectionDetail>(`/collections/${id}/artwork`, { method: 'PUT', raw: file }),
      onSuccess: settle,
    }),
  };
}

export function useRefreshCatalog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<{ count: number; stale: boolean }>('/catalog/refresh', { method: 'POST' }),
    onSuccess: () => {
      invalidateLibraryViews(qc);
      void qc.invalidateQueries({ queryKey: keys.facets });
      void qc.invalidateQueries({ queryKey: keys.status });
    },
  });
}

// -----------------------------------------------------------------------------
// Disc ripping

const WORKING: RipJob['status'][] = [
  'scanning',
  'ripping',
  'ripped',
  'encoding',
  'filing',
  'importing',
];

export function useRips(enabled = true) {
  return useQuery({
    queryKey: keys.rips,
    queryFn: () => api<RipsPayload>('/rips'),
    enabled,
    // Refresh often while a disc is being worked on, slowly otherwise (to notice new discs).
    refetchInterval: (query) =>
      query.state.data?.jobs.some((j) => WORKING.includes(j.status)) ? 2000 : 4000,
  });
}

export function useRipActions() {
  const qc = useQueryClient();
  const settle = () => {
    void qc.invalidateQueries({ queryKey: keys.rips });
  };
  return {
    choose: useMutation({
      mutationFn: (v: { id: string; titleIndex: number }) =>
        api<RipJob>(`/rips/${v.id}/choose`, { method: 'POST', body: { titleIndex: v.titleIndex } }),
      onSettled: settle,
    }),
    name: useMutation({
      mutationFn: (v: { id: string; movie: RipCandidate }) =>
        api<RipJob>(`/rips/${v.id}/name`, { method: 'POST', body: v.movie }),
      onSettled: settle,
    }),
    retry: useMutation({
      mutationFn: (id: string) => api<RipJob>(`/rips/${id}/retry`, { method: 'POST' }),
      onSettled: settle,
    }),
    episodes: useMutation({
      mutationFn: (v: {
        id: string;
        show: RipCandidate;
        season: number;
        episodes: { titleIndex: number; episode: number }[];
      }) =>
        api<RipJob>(`/rips/${v.id}/episodes`, {
          method: 'POST',
          body: { show: v.show, season: v.season, episodes: v.episodes },
        }),
      onSettled: settle,
    }),
    kind: useMutation({
      mutationFn: (v: { id: string; kind: RipKind }) =>
        api<RipJob>(`/rips/${v.id}/kind`, { method: 'POST', body: { kind: v.kind } }),
      onSettled: settle,
    }),
    dismiss: useMutation({
      mutationFn: (id: string) => api(`/rips/${id}`, { method: 'DELETE' }),
      onSettled: settle,
    }),
    testNotification: useMutation({
      mutationFn: () => api('/rips/test-notification', { method: 'POST' }),
    }),
    eject: useMutation({
      mutationFn: () => api('/rips/eject', { method: 'POST' }),
      onSettled: settle,
    }),
  };
}

export function searchRipCandidates(q: string, kind: RipKind = 'movie') {
  return api<{ results: RipCandidate[] }>(
    `/rips/search?q=${encodeURIComponent(q)}${kind === 'tv' ? '&kind=tv' : ''}`,
  );
}
