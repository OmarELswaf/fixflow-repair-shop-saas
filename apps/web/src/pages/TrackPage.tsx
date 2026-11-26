import { useQuery } from '@tanstack/react-query';
import { Alert, Box, CircularProgress, Typography } from '@mui/material';
import { useParams } from 'react-router-dom';
import { ApiError, fetchTracking } from '../api/client';
import { statusLabel, useLanguage, useStrings } from '../i18n';
import { PageContainer, SectionCard } from '../components/SectionCard';
import DateTime from '../components/DateTime';

/**
 * Public customer tracking page at /t/:token. No account, no shell, no
 * customer data: the API returns only shop name, device label, status,
 * expected date and the status timeline. An invalid, revoked or expired
 * link shows the same message.
 */
export default function TrackPage() {
  const t = useStrings();
  const lang = useLanguage();
  const { token } = useParams<{ token: string }>();
  const q = useQuery({
    queryKey: ['track', token],
    queryFn: () => fetchTracking(token ?? ''),
    enabled: Boolean(token),
    retry: false,
  });

  return (
    <PageContainer>
      <Typography variant="h5" component="h1" sx={{ mb: 2, fontWeight: 700 }}>
        {t.trackTitle}
      </Typography>
      {q.isLoading && <CircularProgress aria-label="loading" />}
      {q.isError && (
        <Alert severity="error" role="alert">
          {q.error instanceof ApiError && q.error.status === 404 ? t.trackNotFound : t.networkError}
        </Alert>
      )}
      {q.data && (
        <>
          <SectionCard title={q.data.shop.name}>
            <Typography variant="body1" sx={{ fontWeight: 700 }}>
              {q.data.device.brand} {q.data.device.model}
            </Typography>
            <Typography variant="h6" sx={{ mt: 1 }} data-testid="track-status">
              {statusLabel(lang, q.data.status)}
            </Typography>
            {q.data.expectedReadyAt && (
              <Typography variant="body2" color="text.secondary">
                {t.trackExpected}: <DateTime value={q.data.expectedReadyAt} />
              </Typography>
            )}
            <Typography variant="body2" color="text.secondary">
              {t.trackUpdated}: <DateTime value={q.data.updatedAt} />
            </Typography>
          </SectionCard>
          <SectionCard title={t.trackStages}>
            <Box component="ol" sx={{ m: 0, pl: 3 }}>
              {q.data.timeline.map((e, i) => (
                <li key={`${e.status}-${i}`}>
                  <Typography variant="body2">
                    {statusLabel(lang, e.status)} · <DateTime value={e.at} />
                  </Typography>
                </li>
              ))}
            </Box>
          </SectionCard>
        </>
      )}
    </PageContainer>
  );
}
