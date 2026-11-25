import CssBaseline from '@mui/material/CssBaseline';
import { Alert, AppBar, Box, Button, CircularProgress, Toolbar, Typography } from '@mui/material';
import { ThemeProvider, type Theme } from '@mui/material/styles';
import { Suspense, lazy, useEffect, useState } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import {
  LanguageContext,
  applyLanguage,
  otherLanguage,
  readStoredLanguage,
  storeLanguage,
  strings,
  type Language,
} from './i18n';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { createUpdateFlow } from './pwa/pwa';

const HomePage = lazy(() => import('./pages/HomePage'));
const StatusPage = lazy(() => import('./pages/StatusPage'));
const LoginPage = lazy(() => import('./pages/LoginPage'));
const RegisterPage = lazy(() => import('./pages/RegisterPage'));
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() =>
  import('./pages/ForgotPasswordPage').then((m) => ({ default: m.ResetPasswordPage })),
);
const SelectTenantPage = lazy(() => import('./pages/SelectTenantPage'));
const Shell = lazy(() => import('./pages/Shell'));
const CustomersPage = lazy(() => import('./pages/CustomersPage'));
const CustomerDetailPage = lazy(() => import('./pages/CustomerDetailPage'));
const RepairsPage = lazy(() => import('./pages/RepairsPage'));
const RepairDetailPage = lazy(() => import('./pages/RepairDetailPage'));
const PartsPage = lazy(() => import('./pages/PartsPage'));
const StockPage = lazy(() => import('./pages/StockPage'));
const ReportsPage = lazy(() => import('./pages/ReportsPage'));
const TeamPage = lazy(() => import('./pages/TeamPage'));
const PublicShopPage = lazy(() => import('./pages/PublicShopPage'));
const PublicProfileSettingsPage = lazy(() => import('./pages/PublicProfileSettingsPage'));

/** Public pages get a minimal top bar (app name + language toggle). */
function PublicBar({ lang, onLanguage }: { lang: Language; onLanguage: () => void }) {
  const t = strings[lang];
  return (
    <AppBar
      position="static"
      sx={{
        backgroundColor: 'background.paper',
        color: 'text.primary',
        boxShadow: 'none',
        borderBottom: 1,
        borderColor: 'divider',
        '@media print': { display: 'none' },
      }}
    >
      <Toolbar sx={{ minHeight: 56 }}>
        <Typography variant="h6" sx={{ flexGrow: 1, fontWeight: 700 }}>
          <Link to="/" style={{ color: 'inherit', textDecoration: 'none' }}>
            {t.appName}
          </Link>
        </Typography>
        <Button color="inherit" onClick={onLanguage} aria-label="language-toggle">
          {t.language}
        </Button>
      </Toolbar>
    </AppBar>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, needsTenantSelection, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
        <CircularProgress aria-label="loading" />
      </Box>
    );
  }
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (needsTenantSelection) {
    return <Navigate to="/select-tenant" replace />;
  }
  return <>{children}</>;
}

function RequireTenantSelection({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, needsTenantSelection, memberships, loading } = useAuth();
  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
        <CircularProgress aria-label="loading" />
      </Box>
    );
  }
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  // Entry is allowed for a forced first selection AND for a
  // multi-tenant user switching shops from inside the app.
  if (!needsTenantSelection && memberships.length <= 1) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function PublicOnly({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, needsTenantSelection, loading } = useAuth();
  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
        <CircularProgress aria-label="loading" />
      </Box>
    );
  }
  if (isAuthenticated) {
    return <Navigate to={needsTenantSelection ? '/select-tenant' : '/'} replace />;
  }
  return <>{children}</>;
}

export default function App({ theme }: { theme: Theme }) {
  const [lang, setLang] = useState<Language>(() =>
    typeof window === 'undefined' ? 'ar' : readStoredLanguage(),
  );
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const [updatePending, setUpdatePending] = useState(false);
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    applyLanguage(lang);
    storeLanguage(lang);
  }, [lang]);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  // Service worker: production builds only, never activates silently.
  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
    const flow = createUpdateFlow();
    let cancelled = false;
    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              flow.onUpdateFound();
              if (!cancelled) {
                setWaitingWorker(worker);
                setUpdatePending(true);
              }
            }
          });
        });
      })
      .catch(() => {
        // Registration failure is not fatal; the app works without the SW.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const t = strings[lang];
  const toggleLanguage = () => setLang(otherLanguage(lang));

  const confirmUpdate = () => {
    // Only after the user confirms: tell the waiting worker to activate, then reload.
    if (!waitingWorker) return;
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), {
      once: true,
    });
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    setUpdatePending(false);
  };

  return (
    <ThemeProvider theme={{ ...theme, direction: lang === 'ar' ? 'rtl' : 'ltr' }}>
      <CssBaseline />
      <LanguageContext.Provider value={lang}>
        <BrowserRouter>
          <AuthProvider>
            {!online && (
              <Alert severity="warning" role="alert">
                {t.offline}
              </Alert>
            )}
            {updatePending && (
              <Alert
                severity="info"
                action={
                  <>
                    <Button color="inherit" size="small" onClick={confirmUpdate}>
                      {t.updateConfirm}
                    </Button>
                    <Button color="inherit" size="small" onClick={() => setUpdatePending(false)}>
                      {t.updateLater}
                    </Button>
                  </>
                }
              >
                {t.updateAvailable}
              </Alert>
            )}
            <Box>
              <Suspense fallback={<CircularProgress aria-label="loading" />}>
                <Routes>
                  <Route
                    path="/login"
                    element={
                      <PublicOnly>
                        <PublicBar lang={lang} onLanguage={toggleLanguage} />
                        <LoginPage />
                      </PublicOnly>
                    }
                  />
                  <Route
                    path="/forgot-password"
                    element={
                      <PublicOnly>
                        <PublicBar lang={lang} onLanguage={toggleLanguage} />
                        <ForgotPasswordPage />
                      </PublicOnly>
                    }
                  />
                  <Route
                    path="/reset-password"
                    element={
                      <PublicOnly>
                        <PublicBar lang={lang} onLanguage={toggleLanguage} />
                        <ResetPasswordPage />
                      </PublicOnly>
                    }
                  />
                  <Route
                    path="/register"
                    element={
                      <PublicOnly>
                        <PublicBar lang={lang} onLanguage={toggleLanguage} />
                        <RegisterPage />
                      </PublicOnly>
                    }
                  />
                  <Route
                    path="/select-tenant"
                    element={
                      <RequireTenantSelection>
                        <PublicBar lang={lang} onLanguage={toggleLanguage} />
                        <SelectTenantPage />
                      </RequireTenantSelection>
                    }
                  />
                  <Route
                    path="/s/:slug"
                    element={
                      <>
                        <PublicBar lang={lang} onLanguage={toggleLanguage} />
                        <PublicShopPage />
                      </>
                    }
                  />
                  <Route
                    path="/"
                    element={
                      <RequireAuth>
                        <Shell key={lang} lang={lang} onLanguage={toggleLanguage} />
                      </RequireAuth>
                    }
                  >
                    <Route index element={<HomePage />} />
                    <Route path="customers" element={<CustomersPage />} />
                    <Route path="customers/:id" element={<CustomerDetailPage />} />
                    <Route path="repairs" element={<RepairsPage />} />
                    <Route path="repairs/:id" element={<RepairDetailPage />} />
                    <Route path="parts" element={<PartsPage />} />
                    <Route path="stock" element={<StockPage />} />
                    <Route path="reports" element={<ReportsPage />} />
                    <Route path="team" element={<TeamPage />} />
                    <Route path="settings/public-profile" element={<PublicProfileSettingsPage />} />
                    <Route path="status" element={<StatusPage />} />
                  </Route>
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Suspense>
            </Box>
          </AuthProvider>
        </BrowserRouter>
      </LanguageContext.Provider>
    </ThemeProvider>
  );
}
