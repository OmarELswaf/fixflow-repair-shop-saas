import { useState } from 'react';
import { Alert, Box, Button, TextField, Typography } from '@mui/material';
import { createTrackingLink, revokeTrackingLink } from '../api/client';
import { useStrings } from '../i18n';
import { SectionCard } from './SectionCard';

/** Staff: create, copy, share and revoke the customer tracking link of one repair. */
export default function TrackingLinkCard({ repairId }: { repairId: string }) {
  const t = useStrings();
  const [url, setUrl] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const link = await createTrackingLink(repairId);
      setUrl(`${window.location.origin}${link.path}`);
    } catch {
      setError(t.networkError);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      await revokeTrackingLink(repairId);
      setUrl(null);
      setNote(t.trackRevoked);
    } catch {
      setError(t.networkError);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setNote(t.trackCopied);
    } catch {
      setNote(null);
    }
  };

  return (
    <SectionCard title={t.trackLinkTitle}>
      {error && (
        <Alert severity="error" role="alert" sx={{ mb: 1 }}>
          {error}
        </Alert>
      )}
      {note && (
        <Alert severity="success" sx={{ mb: 1 }}>
          {note}
        </Alert>
      )}
      {url && (
        <Box sx={{ mb: 2 }}>
          <TextField
            fullWidth
            size="small"
            value={url}
            slotProps={{
              htmlInput: { readOnly: true, dir: 'ltr', 'aria-label': t.trackLinkTitle },
            }}
          />
          <Typography variant="caption" color="text.secondary">
            {t.trackShownOnce}
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap' }}>
            <Button variant="outlined" onClick={() => void copy()}>
              {t.trackCopy}
            </Button>
            <Button
              variant="outlined"
              component="a"
              target="_blank"
              rel="noopener noreferrer"
              href={`https://wa.me/?text=${encodeURIComponent(`${t.trackShareText} ${url}`)}`}
            >
              {t.trackWhatsapp}
            </Button>
          </Box>
        </Box>
      )}
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        <Button variant="contained" disabled={busy} onClick={() => void create()}>
          {url ? t.trackNewLink : t.trackCreate}
        </Button>
        <Button variant="text" color="error" disabled={busy} onClick={() => void revoke()}>
          {t.trackRevoke}
        </Button>
      </Box>
    </SectionCard>
  );
}
