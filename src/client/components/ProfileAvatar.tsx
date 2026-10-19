import { useState } from 'react';
import type { ProfileLook } from '../../shared/types';

const FALLBACK_COLOURS = ['#d9a856', '#a8513c', '#1f3b4f', '#5d7a5e', '#4a3a5c', '#8a6d3b'];

/** A steady colour for people who haven't picked one. */
export function profileColour(name: string, look?: ProfileLook | null) {
  return (
    look?.color ??
    FALLBACK_COLOURS[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % FALLBACK_COLOURS.length]!
  );
}

/** Someone's photo, emoji or initial, on their colour. Decorative: names are shown beside it. */
export function ProfileAvatar({
  name,
  look,
  image,
  size = 'lg',
  className = '',
}: {
  name: string;
  look?: ProfileLook | null;
  /** Older servers send just an image URL. */
  image?: string | null;
  size?: 'xl' | 'lg' | 'md' | 'sm';
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const src = look?.image ?? image ?? null;
  const emoji = look?.emoji ?? null;
  return (
    <span
      className={`avatar avatar--${size} ${className}`}
      style={{ background: profileColour(name, look) }}
      aria-hidden="true"
    >
      {src && !failed ? (
        <img src={src} alt="" onError={() => setFailed(true)} />
      ) : emoji ? (
        <span className="avatar__emoji">{emoji}</span>
      ) : (
        name.slice(0, 1).toUpperCase()
      )}
    </span>
  );
}
