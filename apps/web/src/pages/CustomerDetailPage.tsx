import DateTime from '../components/DateTime';
import { PageContainer, SectionCard } from '../components/SectionCard';
import { RepairStatusChip } from '../components/StatusChip';
import { useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Box, Button, CircularProgress, TextField, Typography } from '@mui/material';
import { ApiError, createDevice, getCustomer } from '../api/client';
import { useStrings } from '../i18n';

export default function CustomerDetailPage() {
  const t = useStrings();
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [serial, setSerial] = useState('');
  const [formError, setFormError] = useState('');
  const [serverError, setServerError] = useState('');

  const detail = useQuery({
    queryKey: ['customer', id],
    queryFn: () => getCustomer(id ?? ''),
    enabled: Boolean(id),
    retry: false,
  });

  const addDevice = useMutation({
    mutationFn: () =>
      createDevice(id ?? '', {
        brand: brand.trim(),
        model: model.trim(),
        serial: serial.trim() || undefined,
      }),
    onSuccess: () => {
      setBrand('');
      setModel('');
      setSerial('');
      setFormError('');
      void queryClient.invalidateQueries({ queryKey: ['customer', id] });
    },
    onError: (err) => {
      setServerError(err instanceof ApiError ? err.message : t.networkError);
    },
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setServerError('');
    if (!brand.trim() || !model.trim()) {
      setFormError(t.required);
      return;
    }
    addDevice.mutate();
  };

  if (detail.isLoading) {
    return (
      <PageContainer>
        <CircularProgress aria-label="loading" sx={{ m: 3 }} />
      </PageContainer>
    );
  }
  if (detail.isError || !detail.data) {
    return (
      <PageContainer>
        <Alert severity="error" sx={{ m: 3 }} role="alert">
          {detail.error instanceof ApiError ? detail.error.message : t.networkError}
        </Alert>
      </PageContainer>
    );
  }

  const { customer, devices, repairs } = detail.data;

  return (
    <PageContainer>
      <Typography variant="h1" component="h1" sx={{ mb: 0.5 }}>
        {customer.name}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        {customer.phone ? (
          <>
            <bdi>{customer.phone}</bdi> —{' '}
          </>
        ) : (
          ''
        )}
        {t.createdAt}: <DateTime value={customer.createdAt} />
      </Typography>

      <SectionCard title={t.devices}>
        {devices.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {t.noDevices}
          </Typography>
        )}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mb: 2 }}>
          {devices.map((device) => (
            <Box key={device.id} sx={{ border: 1, borderColor: 'divider', borderRadius: 3, p: 2 }}>
              <Typography variant="body1" sx={{ fontWeight: 700 }}>
                {device.brand} {device.model}
              </Typography>
              {device.serial && (
                <Typography variant="body2" color="text.secondary">
                  <bdi>{device.serial}</bdi>
                </Typography>
              )}
            </Box>
          ))}
        </Box>

        <Typography variant="h3" component="h3" sx={{ mb: 2 }}>
          {t.addDevice}
        </Typography>
        <Alert severity="info" sx={{ mb: 2 }}>
          {t.noDevicePasswordNote}
        </Alert>
        {serverError && (
          <Alert severity="error" sx={{ mb: 2 }} role="alert">
            {serverError}
          </Alert>
        )}
        <Box component="form" onSubmit={submit} noValidate>
          <TextField
            fullWidth
            label={t.deviceBrand}
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            sx={{ mb: 2 }}
            required
          />
          <TextField
            fullWidth
            label={t.deviceModel}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            sx={{ mb: 2 }}
            required
          />
          <TextField
            fullWidth
            label={t.deviceSerial}
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
            sx={{ mb: 2 }}
          />
          {formError && (
            <Alert severity="warning" sx={{ mb: 2 }} role="alert">
              {formError}
            </Alert>
          )}
          <Button type="submit" variant="contained" disabled={addDevice.isPending}>
            {addDevice.isPending ? <CircularProgress size={24} /> : t.addDeviceButton}
          </Button>
        </Box>
      </SectionCard>

      <SectionCard title={t.latestRepairs}>
        {repairs.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            {t.noRepairs}
          </Typography>
        )}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {repairs.map((repair) => (
            <Box
              key={repair.id}
              component={RouterLink}
              to={`/repairs/${repair.id}`}
              aria-label={repair.id}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                textDecoration: 'none',
                color: 'inherit',
                border: 1,
                borderColor: 'divider',
                borderRadius: 3,
                p: 2,
                minHeight: 64,
                '&:hover': { borderColor: 'primary.main' },
              }}
            >
              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography variant="body1" sx={{ fontWeight: 700 }} noWrap>
                  <bdi>{repair.id}</bdi>
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  <DateTime value={repair.createdAt} />
                </Typography>
              </Box>
              <RepairStatusChip status={repair.status} />
            </Box>
          ))}
        </Box>
      </SectionCard>
    </PageContainer>
  );
}
