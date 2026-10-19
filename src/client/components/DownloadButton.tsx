import { useState } from 'react';
import {
  cancelDownload,
  downloadsSupported,
  removeDownload,
  startDownload,
  useDownloads,
  type DownloadMeta,
} from '../lib/downloads';
import { errorMessage } from '../lib/api';
import { useToast } from './Toasts';
import { Button, IconButton } from './ui';

/** Download for offline / progress / downloaded (remove). */
export function DownloadButton({
  meta,
  compact = false,
}: {
  meta: DownloadMeta;
  /** An icon button (episode rows) instead of a labelled one. */
  compact?: boolean;
}) {
  const { entries, progress } = useDownloads();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!downloadsSupported()) return null;
  const entry = entries.find((e) => e.id === meta.id);
  const running = progress.get(meta.id);
  const name = meta.subtitle ? `${meta.subtitle} “${meta.title}”` : meta.title;

  const start = () =>
    startDownload(meta).then(
      () => toast.show(`${meta.title} is ready to watch offline`),
      (e: unknown) => toast.show(errorMessage(e), 'error'),
    );
  const remove = async () => {
    setBusy(true);
    try {
      await removeDownload(meta.id);
      toast.show('Download removed');
    } finally {
      setBusy(false);
    }
  };

  if (running !== undefined) {
    const pct = Math.round(running * 100);
    return compact ? (
      <IconButton
        icon="close"
        label={`Downloading ${name}, ${pct}% (press to cancel)`}
        variant="outline"
        className="download-btn is-running"
        style={{ '--download-pct': `${pct}%` } as React.CSSProperties}
        onClick={() => cancelDownload(meta.id)}
      />
    ) : (
      <Button
        variant="secondary"
        size="lg"
        icon="close"
        className="download-btn is-running"
        style={{ '--download-pct': `${pct}%` } as React.CSSProperties}
        onClick={() => cancelDownload(meta.id)}
        aria-label={`Downloading, ${pct}%. Cancel`}
      >
        {pct}%
      </Button>
    );
  }
  if (entry?.status === 'done') {
    return compact ? (
      <IconButton
        icon="check"
        label={`Remove the download of ${name}`}
        variant="outline"
        className="download-btn is-done"
        pressed
        disabled={busy}
        onClick={() => void remove()}
      />
    ) : (
      <Button
        variant="secondary"
        size="lg"
        icon="check"
        className="download-btn is-done"
        busy={busy}
        onClick={() => void remove()}
        title="Downloaded: press to remove it from this device"
      >
        Downloaded
      </Button>
    );
  }
  return compact ? (
    <IconButton
      icon="download"
      label={entry?.status === 'failed' ? `Download ${name} again` : `Download ${name}`}
      variant="outline"
      className="download-btn"
      onClick={() => void start()}
    />
  ) : (
    <Button
      variant="secondary"
      size="lg"
      icon="download"
      className="download-btn"
      onClick={() => void start()}
    >
      {entry?.status === 'failed' ? 'Download again' : 'Download'}
    </Button>
  );
}
