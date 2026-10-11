import { useState } from 'react';
import { errorMessage } from '../lib/api';
import { useCollectionMutations, useCollections } from '../lib/queries';
import { Icon } from './Icon';
import { useToast } from './Toasts';
import { Button, Dialog, Spinner } from './ui';

/** Add a movie to one of the user's manual collections, or create a new one. */
export function AddToCollectionDialog({
  open,
  onClose,
  movieId,
  movieTitle,
  memberOf,
}: {
  open: boolean;
  onClose: () => void;
  movieId: string;
  movieTitle: string;
  memberOf: string[];
}) {
  const collections = useCollections();
  const { addItems, removeItem, create } = useCollectionMutations();
  const toast = useToast();
  const [newName, setNewName] = useState('');
  const editable = (collections.data ?? []).filter((c) => c.editable && c.kind === 'manual');
  const smartCount = (collections.data ?? []).filter((c) => c.kind === 'smart').length;

  const toggle = async (id: string, name: string, isMember: boolean) => {
    try {
      if (isMember) {
        await removeItem.mutateAsync({ id, itemId: movieId });
        toast.show(`Removed from ${name}`);
      } else {
        await addItems.mutateAsync({ id, itemIds: [movieId] });
        toast.show(`Added to ${name}`);
      }
    } catch (error) {
      toast.show(errorMessage(error), 'error');
    }
  };

  const createAndAdd = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const created = await create.mutateAsync({
        name,
        description: '',
        kind: 'manual',
        visibility: 'private',
      });
      await addItems.mutateAsync({ id: created.id, itemIds: [movieId] });
      setNewName('');
      toast.show(`Created ${name} and added ${movieTitle}`);
    } catch (error) {
      toast.show(errorMessage(error), 'error');
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add to collection"
      description={movieTitle}
      size="sm"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {collections.isPending ? (
        <Spinner label="Loading collections" />
      ) : collections.isError ? (
        <p className="muted">{errorMessage(collections.error)}</p>
      ) : (
        <>
          {editable.length === 0 && (
            <p className="muted">You don’t have any manual collections yet.</p>
          )}
          <ul className="check-list">
            {editable.map((c) => {
              const isMember = memberOf.includes(c.id);
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    className={`check-list__item ${isMember ? 'is-checked' : ''}`}
                    aria-pressed={isMember}
                    onClick={() => toggle(c.id, c.name, isMember)}
                  >
                    <span className="check-list__box">
                      {isMember && <Icon name="check" size={14} />}
                    </span>
                    <span className="check-list__name">{c.name}</span>
                    <span className="faint">{c.itemCount}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void createAndAdd();
            }}
          >
            <input
              className="input"
              placeholder="New collection name"
              aria-label="New collection name"
              value={newName}
              maxLength={80}
              onChange={(e) => setNewName(e.target.value)}
            />
            <Button type="submit" icon="plus" disabled={!newName.trim()} busy={create.isPending}>
              Create
            </Button>
          </form>
          {smartCount > 0 && (
            <p className="field__hint">
              Smart collections fill themselves from their rules, so they aren’t listed here.
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}
