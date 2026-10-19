// "Your profile" in Settings (cloud edition): photo or emoji avatar, colour,
// name, a short tagline, and a favourite movie shown behind your profile.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type ChangeEvent } from 'react';
import { MAX_TAGLINE, PROFILE_COLORS, PROFILE_EMOJI } from '../../shared/profiles';
import type { Movie, Page, Preferences, ProfileDetails } from '../../shared/types';
import { ProfileAvatar } from '../components/ProfileAvatar';
import { useToast } from '../components/Toasts';
import { Button, Field, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { sizedImage } from '../lib/images';
import { keys, useUpdatePreferences } from '../lib/queries';

const PROFILE_KEY = ['profile'] as const;
const AVATAR_PX = 512;

/** Crops a photo to a centred square and shrinks it, so uploads stay small. */
export async function squareJpeg(file: Blob, size = AVATAR_PX): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('That file isn’t a picture this browser can open. Try a JPEG or PNG.');
  }
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser can’t resize pictures.');
  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    size,
    size,
  );
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Couldn’t read that picture.'))),
      'image/jpeg',
      0.86,
    ),
  );
}

function FavoritePicker({
  current,
  onPick,
}: {
  current: ProfileDetails['favoriteMovie'];
  onPick: (id: string | null) => void;
}) {
  const [q, setQ] = useState('');
  const results = useQuery({
    queryKey: ['profile-favorite-search', q],
    queryFn: () => api<Page<Movie>>(`/movies?q=${encodeURIComponent(q)}&limit=6`),
    enabled: q.trim().length >= 2,
  });
  return (
    <Field
      label="Favourite movie"
      hint="Its picture goes behind your profile on “Who’s watching?”."
    >
      {(id) => (
        <div>
          {current && (
            <p className="favorite-current">
              <strong>{current.title}</strong>
              {current.year ? ` (${current.year})` : ''}{' '}
              <button type="button" className="link-btn" onClick={() => onPick(null)}>
                Clear
              </button>
            </p>
          )}
          <input
            id={id}
            className="input"
            type="search"
            placeholder="Search your library…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {results.data && results.data.items.length > 0 && (
            <ul className="favorite-pick">
              {results.data.items.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className="chip"
                    onClick={() => {
                      onPick(m.id);
                      setQ('');
                    }}
                  >
                    {m.title}
                    {m.year ? ` (${m.year})` : ''}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Field>
  );
}

export function ProfilePanel({ prefs }: { prefs: Preferences }) {
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const updatePrefs = useUpdatePreferences();
  const profile = useQuery({
    queryKey: PROFILE_KEY,
    queryFn: () => api<ProfileDetails>('/profile'),
  });
  const [name, setName] = useState<string | null>(null);
  const [tagline, setTagline] = useState<string | null>(null);

  const done = (data: ProfileDetails) => {
    qc.setQueryData(PROFILE_KEY, data);
    // The top bar, TV menu and "Who's watching?" show the new look.
    void qc.invalidateQueries({ queryKey: keys.session });
    void qc.invalidateQueries({ queryKey: ['profiles'] });
  };
  const onError = (e: unknown) => toast.show(errorMessage(e), 'error');

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<ProfileDetails>('/profile', { method: 'PATCH', body }),
    onSuccess: done,
    onError,
  });
  const upload = useMutation({
    mutationFn: async (file: File) =>
      api<ProfileDetails>('/profile/avatar', { method: 'PUT', raw: await squareJpeg(file) }),
    onSuccess: (data) => {
      done(data);
      toast.show('Photo updated');
    },
    onError,
  });
  const removePhoto = useMutation({
    mutationFn: () => api<ProfileDetails>('/profile/avatar', { method: 'DELETE' }),
    onSuccess: done,
    onError,
  });

  if (profile.isPending) return <Spinner label="Loading your profile" />;
  if (profile.isError) return <p className="field__error">{errorMessage(profile.error)}</p>;
  const p = profile.data;
  const look = p.look;

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) upload.mutate(file);
  };
  const pickEmoji = async (emoji: string) => {
    // An emoji replaces the photo.
    if (look.image) await removePhoto.mutateAsync().catch(() => undefined);
    patch.mutate({ emoji });
  };
  const saveText = (field: 'name' | 'tagline', value: string | null) => {
    if (value === null) return;
    const before = field === 'name' ? p.name : (p.tagline ?? '');
    if (value.trim() === before) return;
    patch.mutate({ [field]: value });
  };

  return (
    <div className="profile-editor">
      <div className="profile-editor__preview">
        <ProfileAvatar name={name ?? p.name} look={look} size="xl" />
        <strong>{name ?? p.name}</strong>
        {(tagline ?? p.tagline) && <span className="faint">{tagline ?? p.tagline}</span>}
      </div>
      <div className="profile-editor__fields">
        <div className="button-row">
          <Button
            icon="image"
            variant="secondary"
            busy={upload.isPending}
            onClick={() => fileRef.current?.click()}
          >
            {look.image ? 'Change photo' : 'Upload a photo'}
          </Button>
          {look.image && (
            <Button
              variant="ghost"
              busy={removePhoto.isPending}
              onClick={() => removePhoto.mutate()}
            >
              Remove photo
            </Button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={onFile}
            aria-label="Choose a profile photo"
          />
        </div>

        <fieldset className="fieldset">
          <legend className="field__label">Or pick an avatar</legend>
          <div className="emoji-grid" role="radiogroup" aria-label="Avatar">
            {PROFILE_EMOJI.map((emoji) => (
              <button
                key={emoji}
                type="button"
                role="radio"
                aria-checked={!look.image && look.emoji === emoji}
                aria-label={`Avatar ${emoji}`}
                className="emoji-choice"
                onClick={() => void pickEmoji(emoji)}
              >
                {emoji}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="fieldset">
          <legend className="field__label">Your colour</legend>
          <div className="swatches" role="radiogroup" aria-label="Profile colour">
            {PROFILE_COLORS.map((colour) => (
              <button
                key={colour}
                type="button"
                role="radio"
                aria-checked={look.color === colour}
                aria-label={`Colour ${colour}`}
                className="swatch"
                style={{ background: colour }}
                onClick={() => patch.mutate({ color: colour })}
              />
            ))}
          </div>
          {look.color && look.color !== prefs.accent && (
            <button
              type="button"
              className="link-btn"
              onClick={() =>
                updatePrefs.mutate(
                  { accent: look.color! },
                  { onSuccess: () => toast.show('Accent colour changed') },
                )
              }
            >
              Use it as my accent colour too
            </button>
          )}
        </fieldset>

        <Field label="Name">
          {(id) => (
            <input
              id={id}
              className="input"
              value={name ?? p.name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => saveText('name', name)}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          )}
        </Field>
        <Field label="Tagline" hint="A few words under your name, e.g. “Horror after midnight”.">
          {(id) => (
            <input
              id={id}
              className="input"
              value={tagline ?? p.tagline ?? ''}
              maxLength={MAX_TAGLINE}
              placeholder="Optional"
              onChange={(e) => setTagline(e.target.value)}
              onBlur={() => saveText('tagline', tagline)}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          )}
        </Field>
        <FavoritePicker
          current={p.favoriteMovie}
          onPick={(id) => patch.mutate({ favoriteMovieId: id })}
        />
        {p.favoriteMovie?.backdrop && (
          <img
            className="favorite-art"
            src={sizedImage(p.favoriteMovie.backdrop, 480) ?? p.favoriteMovie.backdrop}
            alt=""
          />
        )}
      </div>
    </div>
  );
}
