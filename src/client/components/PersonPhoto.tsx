import { useState } from 'react';
import { sizedImage } from '../lib/images';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('');

/** A cast member's photo, or their initials when there isn't one (or it won't load). */
export function PersonPhoto({ name, image }: { name: string; image: string | null | undefined }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="person__photo">
      {image && !failed ? (
        <img
          src={sizedImage(image, 200)}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-hidden="true">{initials(name)}</span>
      )}
    </span>
  );
}
