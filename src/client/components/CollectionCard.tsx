import { useState } from 'react';
import { Link } from 'react-router';
import type { Collection } from '../../shared/types';
import { plural } from '../lib/format';
import { sizedImage } from '../lib/images';
import { Icon } from './Icon';

export function CollectionArtwork({ collection }: { collection: Collection }) {
  const [failed, setFailed] = useState(false);
  if (collection.artwork.url && !failed) {
    return (
      <div className="collection-art">
        <img
          src={sizedImage(collection.artwork.url, 720)}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      </div>
    );
  }
  const posters = collection.previewPosters;
  if (posters.length === 0) {
    return (
      <div className="collection-art collection-art--empty">
        <Icon name="stack" size={32} />
      </div>
    );
  }
  // A "shelf" of up to four overlapping posters over a blurred wash of the first one.
  return (
    <div className="collection-art collection-art--shelf">
      <img
        className="collection-art__wash"
        src={sizedImage(posters[0], 120)}
        alt=""
        loading="lazy"
        decoding="async"
      />
      <div className="collection-art__posters">
        {posters.slice(0, 4).map((url, i) => (
          <img
            key={i}
            src={sizedImage(url, 240)}
            alt=""
            loading="lazy"
            decoding="async"
            style={{ zIndex: 4 - i }}
          />
        ))}
      </div>
    </div>
  );
}

export function CollectionCard({ collection }: { collection: Collection }) {
  return (
    <Link to={`/collections/${collection.id}`} className="collection-card">
      <CollectionArtwork collection={collection} />
      <div className="collection-card__meta">
        <span className="collection-card__name">{collection.name}</span>
        <span className="collection-card__sub">
          {plural(collection.itemCount, 'movie')}
          {collection.kind === 'smart' && <span className="badge">Smart</span>}
          {collection.visibility === 'shared' && <span className="badge">Shared</span>}
        </span>
      </div>
    </Link>
  );
}
