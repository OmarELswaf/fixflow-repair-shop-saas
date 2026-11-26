import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Box, Button, CircularProgress, Typography } from '@mui/material';
import { useParams } from 'react-router-dom';
import { ApiError, decideEstimate, fetchEstimate } from '../api/client';
import { useStrings } from '../i18n';
import { PageContainer, SectionCard } from '../components/SectionCard';

/**
 * Public customer page at /a/:token. Shows shop, device, description and
 * amount only. One decision, single use. Invalid, expired or replaced
 * links all show the same message.
 */
export default function ApprovePage() {
  const t = useStrings();
  const { token } = useParams<{ token: string }>();
  const [answered, setAnswered] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const q = useQuery({
    queryKey: ['approve', token],
    queryFn: () => fetchEstimate(token ?? ''),
    enabled: Boolean(token),
    retry: false,
  });

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(true);
    setError('');
    try {
      await decideEstimate(token ?? '', decision);
      setAnswered(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setError(t.approveAlready);
      else setError(t.networkError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageContainer>
      <Typography variant="h5" component="h1" sx={{ mb: 2, fontWeight: 700 }}>
        {t.approveTitle}
      </Typography>
      {q.isLoading && <CircularProgress aria-label="loading" />}
      {q.isError && (
        <Alert severity="error" role="alert">
          {q.error instanceof ApiError && q.error.status === 404
            ? t.approveNotFound
            : t.networkError}
        </Alert>
      )}
      {q.data && (
        <SectionCard title={q.data.shop.name}>
          <Typography variant="body1" sx={{ fontWeight: 700 }}>
            {q.data.device.brand} {q.data.device.model}
          </Typography>
          {q.data.description && <Typography sx={{ mt: 1 }}>{q.data.description}</Typography>}
          <Typography variant="h5" sx={{ mt: 1 }} data-testid="approve-amount">
            {q.data.amount} {t.estCurrency}
          </Typography>
          {error && (
            <Alert severity="error" role="alert" sx={{ mt: 1 }}>
              {error}
            </Alert>
          )}
          {answered && (
            <Alert severity="success" sx={{ mt: 1 }}>
              {t.approveDone}
            </Alert>
          )}
          {q.data.status !== 'pending' && !answered && (
            <Alert severity="info" sx={{ mt: 1 }}>
              {t.approveAlready}
            </Alert>
          )}
          {q.data.status === 'pending' && !answered && (
            <Box sx={{ display: 'flex', gap: 1, mt: 2 }}>
              <Button
                variant="contained"
                size="large"
                disabled={busy}
                onClick={() => void decide('approve')}
              >
                {t.approveYes}
              </Button>
              <Button
                variant="outlined"
                color="error"
                size="large"
                disabled={busy}
                onClick={() => void decide('reject')}
              >
                {t.approveNo}
              </Button>
            </Box>
          )}
        </SectionCard>
      )}
    </PageContainer>
  );
}
