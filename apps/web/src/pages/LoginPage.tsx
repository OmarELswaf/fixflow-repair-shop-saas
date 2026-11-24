import { useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { Alert, Box, Button, CircularProgress, Link, TextField, Typography } from '@mui/material';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import { useStrings } from '../i18n';
import { PageContainer, SectionCard } from '../components/SectionCard';

export default function LoginPage() {
  const t = useStrings();
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [serverError, setServerError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFieldError('');
    setServerError('');
    if (!email.trim() || !password) {
      setFieldError(t.required);
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setFieldError(t.invalidEmail);
      return;
    }
    setBusy(true);
    try {
      const res = await login(email.trim(), password);
      navigate(res.requiresTenantSelection ? '/select-tenant' : '/');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setServerError(t.loginFailed);
      } else if (err instanceof ApiError) {
        setServerError(err.message);
      } else {
        setServerError(t.networkError);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageContainer>
      <Box sx={{ maxWidth: 460, mx: 'auto' }}>
        <Typography variant="h1" component="h1" sx={{ mb: 3 }}>
          {t.loginTitle}
        </Typography>
        <SectionCard>
          {serverError && (
            <Alert severity="error" sx={{ mb: 2 }} role="alert">
              {serverError}
            </Alert>
          )}
          <Box component="form" onSubmit={submit} noValidate>
            <TextField
              fullWidth
              label={t.email}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              sx={{ mb: 2 }}
              required
            />
            <TextField
              fullWidth
              label={t.password}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              sx={{ mb: 2 }}
              required
            />
            {fieldError && (
              <Alert severity="warning" sx={{ mb: 2 }} role="alert">
                {fieldError}
              </Alert>
            )}
            <Button type="submit" variant="contained" fullWidth disabled={busy}>
              {busy ? <CircularProgress size={24} /> : t.loginButton}
            </Button>
          </Box>
        </SectionCard>
        <Typography variant="body2" sx={{ mt: 2 }}>
          {t.noAccount}{' '}
          <Link component={RouterLink} to="/register">
            {t.createAccount}
          </Link>
        </Typography>
      </Box>
    </PageContainer>
  );
}
