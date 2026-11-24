import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Box, Button, CircularProgress, Typography } from '@mui/material';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import { roleLabel, useLanguage, useStrings } from '../i18n';
import { PageContainer, SectionCard } from '../components/SectionCard';

export default function SelectTenantPage() {
  const t = useStrings();
  const lang = useLanguage();
  const { tenantChoices, selectTenant, logout } = useAuth();
  const navigate = useNavigate();
  const [serverError, setServerError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const choose = async (tenantId: string) => {
    setServerError('');
    setBusyId(tenantId);
    try {
      await selectTenant(tenantId);
      navigate('/');
    } catch (err) {
      if (err instanceof ApiError) {
        setServerError(err.message);
      } else {
        setServerError(t.networkError);
      }
    } finally {
      setBusyId(null);
    }
  };

  return (
    <PageContainer>
      <Box sx={{ maxWidth: 480, mx: 'auto' }}>
        <Typography variant="h1" component="h1" sx={{ mb: 1 }}>
          {t.selectTenantTitle}
        </Typography>
        <Typography variant="body1" sx={{ mb: 3 }}>
          {t.selectTenantHint}
        </Typography>
        <SectionCard>
          {serverError && (
            <Alert severity="error" sx={{ mb: 2 }} role="alert">
              {serverError}
            </Alert>
          )}
          {tenantChoices.length === 0 && (
            <Alert severity="warning" role="alert">
              {t.noCustomers}
            </Alert>
          )}
          {tenantChoices.map((choice) => (
            <Button
              key={choice.tenantId}
              variant="outlined"
              fullWidth
              sx={{ mb: 1, justifyContent: 'flex-start', textTransform: 'none' }}
              disabled={busyId !== null}
              onClick={() => choose(choice.tenantId)}
            >
              {busyId === choice.tenantId ? <CircularProgress size={20} sx={{ me: 1 }} /> : null}
              {choice.name ?? choice.tenantId} — {roleLabel(lang, choice.role)}
            </Button>
          ))}
        </SectionCard>
        <Button variant="text" onClick={() => void logout()} sx={{ mt: 1 }}>
          {t.logout}
        </Button>
      </Box>
    </PageContainer>
  );
}
