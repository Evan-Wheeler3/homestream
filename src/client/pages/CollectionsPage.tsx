import { useState } from 'react';
import { useNavigate } from 'react-router';
import { CollectionCard } from '../components/CollectionCard';
import { CollectionEditor } from '../components/CollectionEditor';
import { useToast } from '../components/Toasts';
import { Button, IconButton, Skeleton, StatusView } from '../components/ui';
import { errorMessage } from '../lib/api';
import { plural } from '../lib/format';
import { useCollectionMutations, useCollections } from '../lib/queries';

export function CollectionsPage() {
  const collections = useCollections();
  const { reorder } = useCollectionMutations();
  const [editorOpen, setEditorOpen] = useState(false);
  const [reordering, setReordering] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();

  const list = collections.data ?? [];
  const own = list.filter((c) => c.editable);
  const sharedWithMe = list.filter((c) => !c.editable);

  const move = (index: number, delta: -1 | 1) => {
    const ids = own.map((c) => c.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    reorder.mutate(ids, { onError: (e) => toast.show(errorMessage(e), 'error') });
  };

  return (
    <div className="page route-enter">
      <header className="page-header">
        <div>
          <h1 className="page-title">Collections</h1>
          <p>{collections.data ? plural(list.length, 'collection') : 'Your curated shelves'}</p>
        </div>
        <div className="page-header__actions">
          {own.length > 1 && (
            <Button
              variant={reordering ? 'primary' : 'ghost'}
              icon={reordering ? 'check' : 'drag'}
              onClick={() => setReordering(!reordering)}
            >
              {reordering ? 'Done' : 'Reorder'}
            </Button>
          )}
          <Button variant="primary" icon="plus" onClick={() => setEditorOpen(true)}>
            New collection
          </Button>
        </div>
      </header>

      {collections.isPending ? (
        <div className="collection-grid">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="skeleton--wide" />
          ))}
        </div>
      ) : collections.isError ? (
        <StatusView
          icon="offline"
          tone="error"
          title="Collections could not be loaded"
          action={
            <Button variant="primary" onClick={() => collections.refetch()}>
              Try again
            </Button>
          }
        >
          <p>{errorMessage(collections.error)}</p>
        </StatusView>
      ) : list.length === 0 ? (
        <StatusView
          icon="stack"
          title="No collections yet"
          action={
            <Button variant="primary" icon="plus" onClick={() => setEditorOpen(true)}>
              Create your first collection
            </Button>
          }
        >
          <p>
            Group movies into hand-picked shelves, or let smart collections fill themselves from
            rules.
          </p>
        </StatusView>
      ) : (
        <>
          <ul className="collection-grid" aria-label="Your collections">
            {own.map((c, i) => (
              <li key={c.id} className={reordering ? 'is-reordering' : ''}>
                <CollectionCard collection={c} />
                {reordering && (
                  <div className="reorder-controls">
                    <IconButton
                      icon="arrowUp"
                      label={`Move ${c.name} earlier`}
                      variant="filled"
                      disabled={i === 0 || reorder.isPending}
                      onClick={() => move(i, -1)}
                    />
                    <IconButton
                      icon="arrowDown"
                      label={`Move ${c.name} later`}
                      variant="filled"
                      disabled={i === own.length - 1 || reorder.isPending}
                      onClick={() => move(i, 1)}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
          {sharedWithMe.length > 0 && (
            <>
              <h2 className="section-label section-label--spaced">Shared with you</h2>
              <ul className="collection-grid" aria-label="Shared collections">
                {sharedWithMe.map((c) => (
                  <li key={c.id}>
                    <CollectionCard collection={c} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      <CollectionEditor
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        onSaved={(id) => navigate(`/collections/${id}`)}
      />
    </div>
  );
}
