import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Box, Button, FormControlLabel, Switch, TextField, Typography } from '@mui/material';
import { createEstimate, getApprovalPolicy, listEstimates, setApprovalPolicy } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useStrings } from '../i18n';
import { SectionCard } from './SectionCard';

/** Staff: create an estimate with a one-time customer approval link; see its status. */
export default function EstimateCard({ repairId }: { repairId: string }) {
  const t = useStrings();
  const qc = useQueryClient();
  const { tenantContext } = useAuth();
  const canAdmin = tenantContext?.permissions.includes('admin') ?? false;
  const [amount, setAmount] = useState('');
  const [desc, setDesc] = useState('');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');

  const list = useQuery({
    queryKey: ['estimates', repairId],
    queryFn: () => listEstimates(repairId),
    retry: false,
  });
  const policy = useQuery({
    queryKey: ['approval-policy'],
    queryFn: getApprovalPolicy,
    enabled: canAdmin,
    retry: false,
  });
  const togglePolicy = useMutation({
    mutationFn: setApprovalPolicy,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['approval-policy'] }),
  });

  const create = async () => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      setError(t.estAmount);
      return;
    }
    setError('');
    try {
      const r = await createEstimate(repairId, {
        amount: n,
        description: desc.trim() || undefined,
      });
      setUrl(`${window.location.origin}${r.path}`);
      setAmount('');
      setDesc('');
      void qc.invalidateQueries({ queryKey: ['estimates', repairId] });
    } catch {
      setError(t.networkError);
    }
  };

  return (
    <SectionCard title={t.estTitle}>
      {error && (
        <Alert severity="error" role="alert" sx={{ mb: 1 }}>
          {error}
        </Alert>
      )}
      {url && (
        <Box sx={{ mb: 2 }}>
          <TextField
            fullWidth
            size="small"
            value={url}
            slotProps={{ htmlInput: { readOnly: true, dir: 'ltr', 'aria-label': t.estTitle } }}
          />
          <Typography variant="caption" color="text.secondary">
            {t.estShownOnce}
          </Typography>
          <Box sx={{ mt: 1 }}>
            <Button
              variant="outlined"
              component="a"
              target="_blank"
              rel="noopener noreferrer"
              href={`https://wa.me/?text=${encodeURIComponent(url)}`}
            >
              {t.trackWhatsapp}
            </Button>
          </Box>
        </Box>
      )}
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1 }}>
        <TextField
          size="small"
          type="number"
          label={t.estAmount}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          slotProps={{ htmlInput: { min: 0, inputMode: 'decimal' } }}
        />
        <TextField
          size="small"
          label={t.estDesc}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          sx={{ flex: 1, minWidth: 180 }}
        />
        <Button variant="contained" onClick={() => void create()}>
          {t.estCreate}
        </Button>
      </Box>
      {(list.data ?? []).map((e) => (
        <Typography key={e.id} variant="body2" data-testid="estimate-row">
          {e.amount} {t.estCurrency} ·{' '}
          {(t as unknown as Record<string, string>)[`estStatus_${e.status}`] ?? e.status}
        </Typography>
      ))}
      {canAdmin && policy.data && (
        <FormControlLabel
          sx={{ mt: 1 }}
          control={
            <Switch
              checked={policy.data.requireEstimateApproval}
              onChange={(_, v) => togglePolicy.mutate(v)}
            />
          }
          label={t.estPolicy}
        />
      )}
    </SectionCard>
  );
}
