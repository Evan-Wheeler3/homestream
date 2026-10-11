import { useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { RULE_FIELDS } from '../../shared/rules';
import type { CollectionDetail, CollectionRule, Movie, Preferences } from '../../shared/types';
import { CollectionArtwork } from '../components/CollectionCard';
import { CollectionEditor } from '../components/CollectionEditor';
import { Icon } from '../components/Icon';
import { PosterCard, PosterGrid } from '../components/movies';
import { useToast } from '../components/Toasts';
import {
  Button,
  ButtonLink,
  Dialog,
  IconButton,
  PageLoader,
  Spinner,
  StatusView,
} from '../components/ui';
import { ApiError, errorMessage } from '../lib/api';
import { plural } from '../lib/format';
import { useDebounced } from '../lib/hooks';
import { sizedImage } from '../lib/images';
import {
  useCollection,
  useCollectionMutations,
  useMovies,
  useUpdatePreferences,
} from '../lib/queries';

function describeRule(rule: CollectionRule): string {
  const label = RULE_FIELDS[rule.field].label;
  switch (rule.op) {
    case 'any':
      return `${label} is ${rule.values.join(' or ')}`;
    case 'none':
      return `${label} is not ${rule.values.join(' or ')}`;
    case 'between':
      if (rule.min != null && rule.max != null) return `${label} ${rule.min}–${rule.max}`;
      return rule.min != null ? `${label} ≥ ${rule.min}` : `${label} ≤ ${rule.max}`;
    case 'is':
      if (rule.field === 'favorite') return rule.value ? 'Is a favorite' : 'Not a favorite';
      return (
        { watched: 'Watched', unwatched: 'Unwatched', inProgress: 'In progress' }[
          rule.value as string
        ] ?? ''
      );
    case 'contains':
      return `Title contains “${rule.value}”`;
    case 'lte':
      return `Added in the last ${rule.value} days`;
  }
}

function AddMoviesDialog({
  open,
  onClose,
  collection,
}: {
  open: boolean;
  onClose: () => void;
  collection: CollectionDetail;
}) {
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 200);
  const results = useMovies({ q: q || undefined, sort: q ? undefined : 'title', dir: 'asc' }, open);
  const { addItems } = useCollectionMutations();
  const toast = useToast();
  const members = new Set(collection.movies.map((m) => m.id));
  const items = results.data?.pages.flatMap((p) => p.items) ?? [];

  const add = (movie: Movie) =>
    addItems.mutate(
      { id: collection.id, itemIds: [movie.id] },
      {
        onSuccess: () => toast.show(`Added ${movie.title}`),
        onError: (e) => toast.show(errorMessage(e), 'error'),
      },
    );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Add to ${collection.name}`}
      size="md"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <label className="search-field">
        <Icon name="search" size={18} />
        <span className="visually-hidden">Search movies</span>
        <input
          type="search"
          placeholder="Search your library"
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoFocus
        />
      </label>
      {results.isPending ? (
        <Spinner label="Searching" />
      ) : (
        <ul className="pick-list">
          {items.slice(0, 60).map((movie) => {
            const added = members.has(movie.id);
            return (
              <li key={movie.id} className="pick-list__item">
                <span className="pick-list__thumb">
                  {movie.images.poster && (
                    <img src={sizedImage(movie.images.poster, 120)} alt="" loading="lazy" />
                  )}
                </span>
                <span className="pick-list__text">
                  <span className="pick-list__title">{movie.title}</span>
                  <span className="faint">{movie.year ?? '—'}</span>
                </span>
                <Button
                  size="sm"
                  variant={added ? 'ghost' : 'secondary'}
                  icon={added ? 'check' : 'plus'}
                  disabled={added}
                  onClick={() => add(movie)}
                >
                  {added ? 'Added' : 'Add'}
                </Button>
              </li>
            );
          })}
          {items.length === 0 && <li className="faint">No movies found.</li>}
        </ul>
      )}
    </Dialog>
  );
}

function ArtworkDialog({
  open,
  onClose,
  collection,
}: {
  open: boolean;
  onClose: () => void;
  collection: CollectionDetail;
}) {
  const { update, uploadArtwork } = useCollectionMutations();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const withBackdrops = collection.movies
    .filter((m) => m.images.backdrop || m.images.poster)
    .slice(0, 24);

  const choose = (kind: 'auto' | 'movie', ref?: string) =>
    update.mutate(
      { id: collection.id, artwork: { kind, ref: ref ?? null } },
      {
        onSuccess: () => toast.show('Artwork updated'),
        onError: (e) => toast.show(errorMessage(e), 'error'),
      },
    );

  const upload = (file: File | undefined) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast.show('Images are limited to 5 MB.', 'error');
      return;
    }
    uploadArtwork.mutate(
      { id: collection.id, file },
      {
        onSuccess: () => toast.show('Artwork uploaded'),
        onError: (e) => toast.show(errorMessage(e), 'error'),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Collection artwork"
      size="md"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="art-options">
        <Button
          variant={collection.artwork.kind === 'auto' ? 'primary' : 'secondary'}
          icon="grid"
          onClick={() => choose('auto')}
        >
          Automatic poster mosaic
        </Button>
        <Button
          variant={collection.artwork.kind === 'upload' ? 'primary' : 'secondary'}
          icon="upload"
          busy={uploadArtwork.isPending}
          onClick={() => fileRef.current?.click()}
        >
          Upload an image
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => {
            upload(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <p className="field__hint">PNG, JPEG or WebP up to 5 MB. A wide (16:9) image works best.</p>
      </div>
      {withBackdrops.length > 0 && (
        <>
          <h3 className="section-label">Or use a movie from this collection</h3>
          <ul className="art-picker">
            {withBackdrops.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  className={`art-picker__item ${collection.artwork.kind === 'movie' && collection.artwork.ref === m.id ? 'is-selected' : ''}`}
                  onClick={() => choose('movie', m.id)}
                  aria-label={`Use ${m.title}`}
                >
                  <img
                    src={sizedImage(m.images.backdrop ?? m.images.poster, 360)}
                    alt=""
                    loading="lazy"
                  />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}

export function CollectionDetailPage({ prefs }: { prefs: Preferences }) {
  const { id = '' } = useParams();
  const collection = useCollection(id);
  const mutations = useCollectionMutations();
  const updatePrefs = useUpdatePreferences();
  const toast = useToast();
  const navigate = useNavigate();
  const [editOpen, setEditOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [artOpen, setArtOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [ordering, setOrdering] = useState(false);

  if (collection.isPending) return <PageLoader label="Loading collection" />;
  if (collection.isError) {
    const missing = collection.error instanceof ApiError && collection.error.status === 404;
    return (
      <div className="page">
        <StatusView
          icon={missing ? 'stack' : 'offline'}
          tone={missing ? 'neutral' : 'error'}
          title={missing ? 'Collection not found' : 'Collection could not be loaded'}
          action={
            missing ? (
              <ButtonLink to="/collections" variant="primary">
                All collections
              </ButtonLink>
            ) : (
              <Button onClick={() => collection.refetch()}>Try again</Button>
            )
          }
        >
          <p>{errorMessage(collection.error)}</p>
        </StatusView>
      </div>
    );
  }

  const c = collection.data;
  const sectionId = `collection:${c.id}` as const;
  const pinned = prefs.homeSections.some((s) => s.id === sectionId && s.visible);

  const togglePin = () => {
    const sections = prefs.homeSections.filter((s) => s.id !== sectionId);
    const next = pinned
      ? sections
      : [...sections.slice(0, 2), { id: sectionId, visible: true }, ...sections.slice(2)];
    updatePrefs.mutate(
      { homeSections: next },
      {
        onSuccess: () => toast.show(pinned ? 'Removed from Home' : 'Pinned to Home'),
        onError: (e) => toast.show(errorMessage(e), 'error'),
      },
    );
  };

  const move = (index: number, delta: -1 | 1) => {
    const ids = c.movies.map((m) => m.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    mutations.reorderItems.mutate(
      { id: c.id, itemIds: ids },
      { onError: (e) => toast.show(errorMessage(e), 'error') },
    );
  };

  const remove = (itemId: string, title: string) =>
    mutations.removeItem.mutate(
      { id: c.id, itemId },
      {
        onSuccess: () => toast.show(`Removed ${title}`),
        onError: (e) => toast.show(errorMessage(e), 'error'),
      },
    );

  const randomPick = () => {
    const pool = c.movies.filter((m) => m.available);
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (pick) navigate(`/movie/${pick.id}`);
  };

  return (
    <div className="page collection-page route-enter">
      <header className="collection-header">
        <div className="collection-header__art">
          <CollectionArtwork collection={c} />
        </div>
        <div className="collection-header__body">
          <p className="eyebrow">
            {c.kind === 'smart' ? 'Smart collection' : 'Collection'}
            {c.visibility === 'shared' ? ' · Shared' : ''}
            {!c.editable ? ' · Read-only' : ''}
          </p>
          <h1 className="page-title">{c.name}</h1>
          {c.description && <p className="muted">{c.description}</p>}
          <p className="faint">{plural(c.itemCount, 'movie')}</p>
          {c.kind === 'smart' && c.rules && (
            <p className="rule-summary">
              <Icon name="sliders" size={16} />
              {c.rules.rules
                .map(describeRule)
                .join(c.rules.match === 'all' ? ' · and · ' : ' · or · ')}
            </p>
          )}
          <div className="collection-header__actions">
            {c.movies.length > 1 && (
              <Button variant="secondary" icon="shuffle" onClick={randomPick}>
                Random pick
              </Button>
            )}
            {c.kind === 'manual' && c.editable && (
              <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
                Add movies
              </Button>
            )}
            <Button variant="ghost" icon="pin" onClick={togglePin} aria-pressed={pinned}>
              {pinned ? 'Pinned to Home' : 'Pin to Home'}
            </Button>
            {c.editable && (
              <>
                <IconButton
                  icon="edit"
                  label="Edit details"
                  variant="outline"
                  onClick={() => setEditOpen(true)}
                />
                <IconButton
                  icon="image"
                  label="Change artwork"
                  variant="outline"
                  onClick={() => setArtOpen(true)}
                />
                {c.kind === 'manual' && c.movies.length > 1 && (
                  <IconButton
                    icon="drag"
                    label={ordering ? 'Finish reordering' : 'Reorder movies'}
                    pressed={ordering}
                    variant="outline"
                    onClick={() => setOrdering(!ordering)}
                  />
                )}
                <IconButton
                  icon="trash"
                  label="Delete collection"
                  variant="outline"
                  onClick={() => setConfirmDelete(true)}
                />
              </>
            )}
          </div>
        </div>
      </header>

      {c.unavailable.length > 0 && (
        <div className="notice notice--warning" role="status">
          <Icon name="alert" size={18} />
          <div>
            <p>
              {plural(c.unavailable.length, 'movie')} in this collection{' '}
              {c.unavailable.length === 1 ? 'is' : 'are'} no longer in your Jellyfin library:
            </p>
            <ul className="unavailable-list">
              {c.unavailable.map((u) => (
                <li key={u.itemId}>
                  <span>
                    {u.lastKnownTitle ?? 'Unknown title'}
                    {u.lastKnownYear ? ` (${u.lastKnownYear})` : ''}
                  </span>
                  {c.editable && (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => remove(u.itemId, u.lastKnownTitle ?? 'item')}
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {c.movies.length === 0 ? (
        <StatusView
          icon="stack"
          title={
            c.kind === 'smart' ? 'No movies match these rules yet' : 'This collection is empty'
          }
          action={
            c.editable ? (
              c.kind === 'manual' ? (
                <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
                  Add movies
                </Button>
              ) : (
                <Button variant="secondary" icon="edit" onClick={() => setEditOpen(true)}>
                  Edit rules
                </Button>
              )
            ) : undefined
          }
        >
          {c.kind === 'smart' && (
            <p>Movies will appear automatically as soon as anything in your library matches.</p>
          )}
        </StatusView>
      ) : (
        <PosterGrid label={c.name}>
          {c.movies.map((movie, i) => (
            <li key={movie.id} className={ordering ? 'is-reordering' : ''}>
              <PosterCard movie={movie} />
              {ordering && (
                <div className="reorder-controls">
                  <IconButton
                    icon="arrowUp"
                    label={`Move ${movie.title} earlier`}
                    variant="filled"
                    size={18}
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  />
                  <IconButton
                    icon="arrowDown"
                    label={`Move ${movie.title} later`}
                    variant="filled"
                    size={18}
                    disabled={i === c.movies.length - 1}
                    onClick={() => move(i, 1)}
                  />
                  <IconButton
                    icon="close"
                    label={`Remove ${movie.title}`}
                    variant="filled"
                    size={18}
                    onClick={() => remove(movie.id, movie.title)}
                  />
                </div>
              )}
            </li>
          ))}
        </PosterGrid>
      )}

      {c.editable && (
        <>
          <CollectionEditor open={editOpen} onClose={() => setEditOpen(false)} collection={c} />
          {c.kind === 'manual' && (
            <AddMoviesDialog open={addOpen} onClose={() => setAddOpen(false)} collection={c} />
          )}
          <ArtworkDialog open={artOpen} onClose={() => setArtOpen(false)} collection={c} />
          <Dialog
            open={confirmDelete}
            onClose={() => setConfirmDelete(false)}
            title={`Delete “${c.name}”?`}
            size="sm"
            footer={
              <>
                <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  icon="trash"
                  busy={mutations.remove.isPending}
                  onClick={() =>
                    mutations.remove.mutate(c.id, {
                      onSuccess: () => {
                        toast.show('Collection deleted');
                        navigate('/collections', { replace: true });
                      },
                      onError: (e) => toast.show(errorMessage(e), 'error'),
                    })
                  }
                >
                  Delete
                </Button>
              </>
            }
          >
            <p>
              The movies stay in your library — only this collection is removed. This can’t be
              undone.
            </p>
          </Dialog>
        </>
      )}
    </div>
  );
}
