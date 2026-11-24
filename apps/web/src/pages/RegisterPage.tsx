import { useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { Alert, Box, Button, CircularProgress, Link, TextField, Typography } from '@mui/material';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import { useStrings } from '../i18n';
import { PageContainer, SectionCard } from '../components/SectionCard';

export default function RegisterPage() {
  const t = useStrings();
  const { register } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [branchName, setBranchName] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [serverError, setServerError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFieldError('');
    setServerError('');
    if (!email.trim() || !password || !tenantName.trim() || !branchName.trim()) {
      setFieldError(t.required);
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setFieldError(t.invalidEmail);
      return;
    }
    if (password.length < 12) {
      setFieldError(t.passwordMin);
      return;
    }
    setBusy(true);
    try {
      await register({
        email: email.trim(),
        password,
        name: name.trim() || undefined,
        tenantName: tenantName.trim(),
        branchName: branchName.trim(),
      });
      navigate('/');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setServerError(t.emailTaken);
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
      <Box sx={{ maxWidth: 480, mx: 'auto' }}>
        <Typography variant="h1" component="h1" sx={{ mb: 3 }}>
          {t.registerTitle}
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
              label={t.yourName}
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              sx={{ mb: 2 }}
            />
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
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              sx={{ mb: 1 }}
              required
              helperText={t.passwordHint}
            />
            <TextField
              fullWidth
              label={t.tenantName}
              value={tenantName}
              onChange={(e) => setTenantName(e.target.value)}
              sx={{ mb: 2, mt: 1 }}
              required
            />
            <TextField
              fullWidth
              label={t.branchName}
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              sx={{ mb: 2 }}
              required
            />
            {fieldError && (
              <Alert severity="warning" sx={{ mb: 2 }} role="alert">
                {fieldError}
              </Alert>
            )}
            <Button type="submit" variant="contained" fullWidth disabled={busy}>
              {busy ? <CircularProgress size={24} /> : t.registerButton}
            </Button>
          </Box>
        </SectionCard>
        <Typography variant="body2" sx={{ mt: 2 }}>
          {t.hasAccount}{' '}
          <Link component={RouterLink} to="/login">
            {t.backToLogin}
          </Link>
        </Typography>
      </Box>
    </PageContainer>
  );
}
