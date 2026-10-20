import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import type { Preferences, SessionInfo } from '../../shared/types';
import { api } from '../lib/api';
import { connection, useConnection } from '../lib/connection';
import { focusFirst } from '../lib/spatialNav';
import { isTvMode, useTvMode } from '../lib/tv';
import { Icon, type IconName } from './Icon';
import { ProfileAvatar } from './ProfileAvatar';

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: 'Home', icon: 'home', end: true },
  { to: '/browse', label: 'Browse', icon: 'grid' },
  { to: '/shows', label: 'TV Shows', icon: 'tv' },
  { to: '/collections', label: 'Collections', icon: 'stack' },
  { to: '/theater', label: 'Theater', icon: 'film' },
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

/**
 * TV navigation: a slim rail down the left edge (icons only) that opens to show
 * labels when it has focus, like the big streaming apps. Press ◀ from the
 * page to reach it, ▶ to go back to the page.
 */
function TvRail({
  session,
  prefs,
  onSignOut,
}: {
  session: SessionInfo;
  prefs: Preferences;
  onSignOut: () => void;
}) {
  const items: { to: string; label: string; icon: IconName; end?: boolean }[] = [
    { to: '/search', label: 'Search', icon: 'search' },
    { to: '/', label: 'Home', icon: 'home', end: true },
    { to: '/browse', label: 'Browse', icon: 'grid' },
    { to: '/shows', label: 'TV Shows', icon: 'tv' },
    { to: '/collections', label: 'Collections', icon: 'stack' },
    { to: '/theater', label: 'Theater', icon: 'film' },
    { to: '/spin', label: 'Spin the wheel', icon: 'wheel' },
    { to: '/night', label: 'Movie night', icon: 'user' },
    { to: '/wrapped', label: 'Your year', icon: 'star' },
    { to: '/requests', label: 'Requests', icon: 'plus' },
    { to: '/downloads', label: 'Downloads', icon: 'download' },
    ...(session.ripper ? [{ to: '/rips', label: 'Discs', icon: 'disc' as const }] : []),
    { to: '/settings', label: 'Settings', icon: 'settings' },
  ];
  return (
    <nav className="tv-rail" aria-label="Main">
      <span className="tv-rail__brand" aria-hidden="true">
        <span className="topbar__mark" />
        <span className="tv-rail__label tv-rail__name">{prefs.appName}</span>
      </span>
      <ul className="tv-rail__list">
        {items.map((item) => (
          <li key={item.to}>
            <NavLink to={item.to} end={item.end} className="tv-rail__item" data-rail-item>
              <Icon name={item.icon} size={26} />
              <span className="tv-rail__label">{item.label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="tv-rail__item tv-rail__user"
        data-rail-item
        onClick={onSignOut}
      >
        <ProfileAvatar
          name={session.user.name}
          look={session.user.look}
          size="sm"
          className="tv-rail__avatar"
        />
        <span className="tv-rail__label">{session.user.name} · Switch profile</span>
      </button>
    </nav>
  );
}

export function AppShell({ session, prefs }: { session: SessionInfo; prefs: Preferences }) {
  const [scrolled, setScrolled] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  // The player and the theater take the whole screen.
  const onPlayer = location.pathname.startsWith('/play/') || location.pathname === '/theater';
  const tv = useTvMode().enabled;

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
        if (location.pathname.startsWith('/play/') || location.pathname === '/theater') return;
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
      // Choosing a section in the TV rail also hands focus to the new page.
      const idle =
        !active ||
        active === document.body ||
        active.id === 'main' ||
        Boolean(active.closest('.tv-rail'));
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

  if (tv) {
    return (
      <>
        <TvRail session={session} prefs={prefs} onSignOut={signOut} />
        <OfflineBanner />
        <main id="main" tabIndex={-1} className="main">
          <Outlet />
        </main>
      </>
    );
  }

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
            to="/downloads"
            className="icon-btn icon-btn--plain"
            aria-label="Downloads"
            title="Downloads"
          >
            <Icon name="download" size={20} />
          </NavLink>
          <NavLink
            to="/settings"
            className="icon-btn icon-btn--plain topbar__desktop-only"
            aria-label="Settings"
            title="Settings"
          >
            <Icon name="settings" size={20} />
          </NavLink>
          <button
            type="button"
            className="topbar__profile topbar__desktop-only"
            aria-label={`Switch profile (signed in as ${session.user.name})`}
            title={`${session.user.name} · Switch profile`}
            onClick={signOut}
          >
            <ProfileAvatar name={session.user.name} look={session.user.look} size="sm" />
          </button>
        </div>
      </header>
      <OfflineBanner />
      <main id="main" tabIndex={-1} className="main">
        <Outlet />
      </main>
      <nav className="tabbar" aria-label="Main">
        {[
          ...NAV.slice(0, 2),
          { ...NAV[2]!, label: 'TV' },
          { to: '/search', label: 'Search', icon: 'search' as const },
          NAV[3]!,
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
