import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toasts';
import { Button, StatusView } from '../components/ui';
import {
  cancelDownload,
  downloadsSupported,
  offlinePosition,
  removeDownload,
  storageEstimate,
  useDownloads,
  type DownloadEntry,
} from '../lib/downloads';
import { formatBytes, formatRuntime } from '../lib/format';

const playHref = (e: DownloadEntry) => {
  const t = Math.floor(offlinePosition(e.id));
  const base = e.kind === 'episode' ? `/play/episode/${e.id}` : `/play/${e.id}`;
  return t > 0 ? `${base}?t=${t}` : base;
};

/** Everything saved on this device for watching offline. Works with no network. */
export function DownloadsPage({ offline = false }: { offline?: boolean }) {
  const { entries, progress } = useDownloads();
  const toast = useToast();
  const [space, setSpace] = useState<{ used: number; quota: number } | null>(null);
  useEffect(() => {
    void storageEstimate().then(setSpace);
  }, [entries]);

  if (!downloadsSupported()) {
    return (
      <div className="page">
        <StatusView icon="download" title="Downloads">
          <p>This browser can’t save movies for offline. Try Safari or Chrome.</p>
        </StatusView>
      </div>
    );
  }

  const list = [...entries].sort((a, b) => b.downloadedAt.localeCompare(a.downloadedAt));
  const ready = list.filter((e) => e.status === 'done');
  const bytes = ready.reduce((n, e) => n + e.bytes, 0);

  return (
    <div className="page downloads-page route-enter">
      <header className="page-header">
        <div>
          <h1 className="page-title">Downloads</h1>
          <p>
            {offline
              ? 'You’re offline. These are saved on this device, ready to watch.'
              : 'Movies and episodes saved on this device, to watch without internet.'}
          </p>
        </div>
      </header>

      {list.length === 0 ? (
        <StatusView icon="download" title="Nothing downloaded yet">
          <p>
            Press <strong>Download</strong> on a movie or an episode to keep it on this device.
          </p>
        </StatusView>
      ) : (
        <ul className="downloads">
          {list.map((e) => {
            const running = progress.get(e.id);
            return (
              <li key={e.id} className={`download download--${e.status}`}>
                {e.poster ? (
                  <img className="download__poster" src={e.poster} alt="" />
                ) : (
                  <span className="download__poster" aria-hidden="true">
                    <Icon name="film" size={24} />
                  </span>
                )}
                <div className="download__body">
                  <strong>{e.title}</strong>
                  <span className="faint">
                    {[
                      e.subtitle,
                      formatRuntime(e.runtimeMinutes),
                      e.status === 'done' ? formatBytes(e.bytes) : null,
                      running !== undefined ? `Downloading… ${Math.round(running * 100)}%` : null,
                      e.status === 'failed'
                        ? `Didn’t finish${e.error ? `: ${e.error}` : ''}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  {running !== undefined && (
                    <span className="download__bar" aria-hidden="true">
                      <span style={{ width: `${Math.round(running * 100)}%` }} />
                    </span>
                  )}
                </div>
                <div className="download__actions">
                  {e.status === 'done' && (
                    <Link to={playHref(e)} className="btn btn--primary btn--md">
                      <Icon name="play" size={20} />
                      <span>Play</span>
                    </Link>
                  )}
                  {running !== undefined ? (
                    <Button variant="ghost" onClick={() => cancelDownload(e.id)}>
                      Cancel
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        void removeDownload(e.id).then(() => toast.show('Download removed'))
                      }
                      aria-label={`Remove ${e.title}`}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="field__hint">
        {ready.length > 0 && `${formatBytes(bytes)} of downloads. `}
        {space &&
          space.quota > 0 &&
          `${formatBytes(space.quota - space.used)} free for downloads. `}
        On iPhone and iPad, add Wheelhouse to your Home Screen (Share → Add to Home Screen) so
        downloads aren’t cleared. Your progress while offline is saved when you’re back online.
      </p>
    </div>
  );
}
