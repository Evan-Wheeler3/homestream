import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from '@tanstack/react-query';
import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { DEFAULT_PREFERENCES } from '../shared/preferences';
import { Icon } from './components/Icon';
import { AppShell } from './components/AppShell';
import { ToastProvider } from './components/Toasts';
import { Button, PageLoader, StatusView } from './components/ui';
import { ApiError, errorMessage } from './lib/api';
import { applyAppearance } from './lib/appearance';
import { connection, useConnection } from './lib/connection';
import { usePreferences, useSession } from './lib/queries';
import { BrowsePage } from './pages/BrowsePage';
import { CollectionDetailPage } from './pages/CollectionDetailPage';
import { CollectionsPage } from './pages/CollectionsPage';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { MovieDetailPage } from './pages/MovieDetailPage';
import { FranchisePage } from './pages/FranchisePage';
import { RequestsPage } from './pages/RequestsPage';
import { DownloadsPage } from './pages/DownloadsPage';
import { getDownloads } from './lib/downloads';
import { PersonPage } from './pages/PersonPage';
import { RipsPage } from './pages/RipsPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { SearchPage } from './pages/SearchPage';
import { VotePage } from './pages/VotePage';
import { InvitePage } from './pages/InvitePage';
import { ShowDetailPage } from './pages/ShowDetailPage';
import { ShowsPage } from './pages/ShowsPage';

const PlayerPage = lazy(() => import('./player/PlayerPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const SpinPage = lazy(() => import('./pages/SpinPage'));
const WrappedPage = lazy(() => import('./pages/WrappedPage'));
const NightPage = lazy(() => import('./pages/NightPage'));
const TheaterPage = lazy(() => import('./theater/TheaterPage'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => {
        if (
          error instanceof ApiError &&
          (error.isAuth || error.status === 404 || error.status === 400)
        ) {
          return false;
        }
        return count < 2;
      },
      refetchOnWindowFocus: true,
    },
  },
  queryCache: new QueryCache(),
});

/** Sends the user to sign-in whenever any request reports a lost session. */
function AuthLostWatcher() {
  const { authLost } = useConnection();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  useEffect(() => {
    // The login and voting pages work without a session.
    if (
      !authLost ||
      location.pathname === '/login' ||
      location.pathname.startsWith('/vote') ||
      location.pathname.startsWith('/invite')
    )
      return;
    qc.clear();
    navigate('/login', {
      replace: true,
      state: { from: location.pathname + location.search, expired: authLost === 'expired' },
    });
  }, [authLost, location, navigate, qc]);
  return null;
}

function Protected() {
  const session = useSession();
  const prefs = usePreferences(session.isSuccess);
  const location = useLocation();

  useEffect(() => {
    if (prefs.data) applyAppearance(prefs.data);
  }, [prefs.data]);

  useEffect(() => {
    if (prefs.data) document.title = prefs.data.appName;
  }, [prefs.data, location.pathname]);

  if (session.isPending) return <PageLoader label="Checking your session" />;
  if (session.error) {
    if (session.error instanceof ApiError && session.error.isAuth) {
      return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
    }
    // Offline with downloads: they can still be watched.
    if (
      session.error instanceof ApiError &&
      session.error.code === 'NETWORK' &&
      getDownloads().some((d) => d.status === 'done')
    ) {
      return (
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="play/:id" element={<PlayerPage prefs={DEFAULT_PREFERENCES} />} />
            <Route
              path="play/episode/:id"
              element={<PlayerPage prefs={DEFAULT_PREFERENCES} kind="episode" />}
            />
            <Route
              path="*"
              element={
                <main id="main" className="main main--offline">
                  <div className="offline-strip" role="status">
                    <Icon name="offline" size={18} /> No connection.{' '}
                    <button type="button" className="link-btn" onClick={() => session.refetch()}>
                      Try again
                    </button>
                  </div>
                  <DownloadsPage offline />
                </main>
              }
            />
          </Routes>
        </Suspense>
      );
    }
    return (
      <div className="page">
        <StatusView
          icon="offline"
          tone="error"
          title="Cannot reach Wheelhouse"
          action={
            <Button variant="primary" icon="refresh" onClick={() => session.refetch()}>
              Try again
            </Button>
          }
        >
          <p>{errorMessage(session.error)}</p>
          <p>Make sure the computer running Wheelhouse is switched on and on the same network.</p>
        </StatusView>
      </div>
    );
  }
  if (prefs.isPending) return <PageLoader label="Loading preferences" />;
  const preferences = prefs.data ?? DEFAULT_PREFERENCES;

  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route element={<AppShell session={session.data} prefs={preferences} />}>
          <Route index element={<HomePage prefs={preferences} />} />
          <Route path="browse" element={<BrowsePage prefs={preferences} />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="movie/:id" element={<MovieDetailPage prefs={preferences} />} />
          <Route path="shows" element={<ShowsPage />} />
          <Route path="show/:id" element={<ShowDetailPage />} />
          <Route path="collections" element={<CollectionsPage />} />
          <Route path="collections/:id" element={<CollectionDetailPage prefs={preferences} />} />
          <Route path="person/:name" element={<PersonPage />} />
          <Route path="franchise/:id" element={<FranchisePage />} />
          <Route path="rips" element={<RipsPage session={session.data} />} />
          <Route path="spin" element={<SpinPage prefs={preferences} />} />
          <Route path="wrapped" element={<WrappedPage />} />
          <Route path="night" element={<NightPage />} />
          <Route path="requests" element={<RequestsPage session={session.data} />} />
          <Route path="downloads" element={<DownloadsPage />} />
          <Route
            path="theater"
            element={
              <Suspense fallback={<PageLoader label="Opening the doors" />}>
                <TheaterPage />
              </Suspense>
            }
          />
          <Route
            path="settings"
            element={<SettingsPage session={session.data} prefs={preferences} />}
          />
          <Route path="play/:id" element={<PlayerPage prefs={preferences} />} />
          <Route
            path="play/episode/:id"
            element={<PlayerPage prefs={preferences} kind="episode" />}
          />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

export function App() {
  useEffect(() => {
    // Clear a stale "session lost" flag once we're back on the login page.
    return () => connection.clearAuthLost();
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <AuthLostWatcher />
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/vote" element={<VotePage />} />
            <Route path="/vote/:code" element={<VotePage />} />
            <Route path="/invite/:token" element={<InvitePage />} />
            <Route path="/*" element={<Protected />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
