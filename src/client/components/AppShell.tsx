import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import type { Preferences, SessionInfo } from '../../shared/types';
import { api } from '../lib/api';
import { connection, useConnection } from '../lib/connection';
import { focusFirst } from '../lib/spatialNav';
import { isTvMode } from '../lib/tv';
import { Icon, type IconName } from './Icon';
import { IconButton } from './ui';

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: 'Home', icon: 'home', end: true },
  { to: '/browse', label: 'Browse', icon: 'grid' },
  { to: '/collections', label: 'Collections', icon: 'stack' },
];

/** Re-check the app server and, if needed, Jellyfin (via a catalog refresh). */
async function recheck(mediaServerOk: boolean) {
  await api('/health');
  if (!mediaServerOk) {
    const result = await api<{ stale: boolean }>('/catalog/refresh', { method: 'POST' });
    connection.reportMediaServer(!result.stale);
  }
}

function OfflineBanner() {
  const state = useConnection();
  const qc = useQueryClient();
  const [retrying, setRetrying] = useState(false);
  const down = !state.appServer || !state.mediaServer;

  // While something is down, quietly re-check every 20 seconds so the app
  // recovers on its own when the computer or Jellyfin comes back.
  useEffect(() => {
    if (!down || !state.browserOnline) return;
    const id = window.setInterval(() => {
      recheck(connection.get().mediaServer)
        .then(() => qc.invalidateQueries())
        .catch(() => undefined);
    }, 20_000);
    return () => window.clearInterval(id);
  }, [down, state.browserOnline, qc]);
  let message: string | null = null;
  if (!state.browserOnline) message = 'You are offline. Check your Wi-Fi or network connection.';
  else if (!state.appServer) message = 'Cannot reach the Wheelhouse server on your home computer.';
  else if (!state.mediaServer)
    message =
      'Jellyfin is not responding. Showing your library from cache — playback is unavailable until it is back.';
  if (!message) return null;

  const retry = async () => {
    setRetrying(true);
    try {
      await recheck(state.mediaServer);
      await qc.invalidateQueries();
    } catch {
      /* banner stays */
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="offline-banner" role="alert">
      <Icon name="offline" size={18} />
      <span>{message}</span>
      <button type="button" className="offline-banner__retry" onClick={retry} disabled={retrying}>
        {retrying ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  );
}

export function AppShell({ session, prefs }: { session: SessionInfo; prefs: Preferences }) {
  const [scrolled, setScrolled] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const onPlayer = location.pathname.startsWith('/play/');

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Global shortcuts: "/" or Ctrl/Cmd+K opens search.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (
        (event.key === 'k' && (event.metaKey || event.ctrlKey)) ||
        (event.key === '/' && !typing)
      ) {
        if (location.pathname.startsWith('/play/')) return;
        event.preventDefault();
        navigate('/search');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, location.pathname]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  // On a TV, put focus on the page's first control once it has loaded so the
  // remote has a starting point.
  useEffect(() => {
    if (!isTvMode() || onPlayer) return;
    let tries = 0;
    const id = window.setInterval(() => {
      const active = document.activeElement;
      const idle = !active || active === document.body || active.id === 'main';
      if (!idle || focusFirst() || ++tries > 25) window.clearInterval(id);
    }, 120);
    return () => window.clearInterval(id);
  }, [location.pathname, onPlayer]);

  const signOut = async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      qc.clear();
      navigate('/login', { replace: true });
    }
  };

  if (onPlayer) return <Outlet />;

  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className={`topbar ${scrolled ? 'is-scrolled' : ''}`}>
        <NavLink to="/" className="topbar__brand" aria-label={`${prefs.appName} home`}>
          <span className="topbar__mark" aria-hidden="true" />
          <span className="topbar__name">{prefs.appName}</span>
        </NavLink>
        <nav className="topbar__nav" aria-label="Main">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className="topbar__link">
              {item.label}
            </NavLink>
          ))}
          {session.ripper && (
            <NavLink to="/rips" className="topbar__link">
              Discs
            </NavLink>
          )}
        </nav>
        <div className="topbar__actions">
          {session.source === 'mock' && (
            <span
              className="badge badge--sample"
              title="Using the built-in sample library, not Jellyfin"
            >
              Sample library
            </span>
          )}
          <NavLink
            to="/search"
            className="icon-btn icon-btn--plain"
            aria-label="Search (press /)"
            title="Search (/)"
          >
            <Icon name="search" size={20} />
          </NavLink>
          <NavLink
            to="/settings"
            className="icon-btn icon-btn--plain topbar__desktop-only"
            aria-label="Settings"
            title="Settings"
          >
            <Icon name="settings" size={20} />
          </NavLink>
          <IconButton
            icon="logout"
            label={`Sign out ${session.user.name}`}
            className="topbar__desktop-only"
            onClick={signOut}
          />
        </div>
      </header>
      <OfflineBanner />
      <main id="main" tabIndex={-1} className="main">
        <Outlet />
      </main>
      <nav className="tabbar" aria-label="Main">
        {[
          ...NAV.slice(0, 2),
          { to: '/search', label: 'Search', icon: 'search' as const },
          NAV[2]!,
          { to: '/settings', label: 'Settings', icon: 'settings' as const },
        ].map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={'end' in item ? item.end : false}
            className="tabbar__item"
          >
            <Icon name={item.icon} size={22} />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </>
  );
}
