import DateTime from '../components/DateTime';
import TrackingLinkCard from '../components/TrackingLinkCard';
import { PageContainer, SectionCard } from '../components/SectionCard';
import { PartLineStatusChip, RepairStatusChip } from '../components/StatusChip';
import SearchPicker, { type SearchPickerOption } from '../components/SearchPicker';
import { useCallback, useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Divider,
  FormControl,
  InputLabel,
  Link,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import { useAuth } from '../auth/AuthContext';
import {
  ApiError,
  assignRepair,
  consumePart,
  getReceipt,
  getRepair,
  listParts,
  listRepairParts,
  listStock,
  listTechnicians,
  newIdempotencyKey,
  releasePart,
  reservePart,
  transitionRepair,
  type RepairPartLine,
  type Technician,
} from '../api/client';
import {
  ALLOWED_TRANSITIONS,
  statusLabel,
  useLanguage,
  useStrings,
  type RepairStatus,
} from '../i18n';

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 2,
        py: 1,
      }}
    >
      <Typography variant="body2" color="text.secondary" sx={{ flexShrink: 0 }}>
        {label}
      </Typography>
      <Box sx={{ textAlign: 'end', minWidth: 0, overflowWrap: 'anywhere' }}>{children}</Box>
    </Box>
  );
}

export default function RepairDetailPage() {
  const t = useStrings();
  const { tenantContext } = useAuth();
  const canAssign = tenantContext?.permissions.includes('repair:assign') ?? false;
  const canTransition = tenantContext?.permissions.includes('repair:transition') ?? false;
  const canReadInventory = tenantContext?.permissions.includes('inventory:read') ?? false;
  const canReserve = tenantContext?.permissions.includes('stock:reserve') ?? false;
  const canRelease = tenantContext?.permissions.includes('stock:release') ?? false;
  const canConsume = tenantContext?.permissions.includes('stock:consume') ?? false;
  const lang = useLanguage();
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [technicianId, setTechnicianId] = useState('');
  const [note, setNote] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionInfo, setActionInfo] = useState('');
  const [reservePartOption, setReservePartOption] = useState<SearchPickerOption | null>(null);
  const [reservePartId, setReservePartId] = useState('');
  const [reserveQty, setReserveQty] = useState('');
  const [partsFormError, setPartsFormError] = useState('');

  const searchParts = useCallback(
    (query: string, cursor?: string | null) =>
      listParts({ search: query, cursor: cursor ?? undefined, limit: 10 }).then((result) => ({
        options: result.items.map((p) => ({
          id: p.id,
          label: `${p.sku} — ${p.name}`,
        })),
        nextCursor: result.nextCursor,
      })),
    [],
  );

  const handleReservePartChange = (option: SearchPickerOption | null) => {
    setReservePartOption(option);
    setReservePartId(option?.id ?? '');
  };

  const detail = useQuery({
    queryKey: ['repair', id],
    queryFn: () => getRepair(id ?? ''),
    enabled: Boolean(id),
    retry: false,
  });

  const receipt = useQuery({
    queryKey: ['receipt', id],
    queryFn: () => getReceipt(id ?? ''),
    enabled: Boolean(id),
    retry: false,
  });

  const technicians = useQuery({
    queryKey: ['technicians', detail.data?.order.branchId],
    queryFn: () => listTechnicians(detail.data?.order.branchId ?? ''),
    enabled: canAssign && Boolean(detail.data?.order.branchId),
    retry: false,
  });

  const repairParts = useQuery({
    queryKey: ['repair-parts', id],
    queryFn: () => listRepairParts(id ?? ''),
    enabled: canReadInventory && Boolean(id),
    retry: false,
  });

  // Availability of the selected part at this repair's branch, fetched
  // on demand — never a preloaded first-100 stock list.
  const partStock = useQuery({
    queryKey: ['stock', detail.data?.order.branchId, reservePartId],
    queryFn: () => listStock({ branchId: detail.data?.order.branchId, partId: reservePartId }),
    enabled: canReserve && Boolean(detail.data?.order.branchId) && Boolean(reservePartId),
    retry: false,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['repair', id] });
    void queryClient.invalidateQueries({ queryKey: ['receipt', id] });
    void queryClient.invalidateQueries({ queryKey: ['repair-parts', id] });
    void queryClient.invalidateQueries({ queryKey: ['stock', detail.data?.order.branchId] });
  };

  const assign = useMutation({
    mutationFn: () => assignRepair(id ?? '', { technicianUserId: technicianId.trim() }),
    onSuccess: () => {
      setTechnicianId('');
      setActionError('');
      setActionInfo(t.assign);
      invalidate();
    },
    onError: (err) => {
      setActionInfo('');
      setActionError(err instanceof ApiError ? err.message : t.networkError);
    },
  });

  const transition = useMutation({
    mutationFn: (toStatus: RepairStatus) =>
      transitionRepair(id ?? '', {
        toStatus,
        expectedVersion: detail.data?.order.version ?? 0,
        note: note.trim() || undefined,
      }),
    onSuccess: () => {
      setNote('');
      setActionError('');
      setActionInfo(t.transition);
      invalidate();
    },
    onError: (err) => {
      setActionInfo('');
      if (err instanceof ApiError && err.status === 409) {
        setActionError(t.versionConflict);
        invalidate();
      } else if (err instanceof ApiError && err.status === 422) {
        setActionError(t.illegalTransition);
      } else if (err instanceof ApiError) {
        setActionError(err.message);
      } else {
        setActionError(t.networkError);
      }
    },
  });

  const reserve = useMutation({
    mutationFn: () =>
      reservePart(id ?? '', {
        partId: reservePartId,
        qty: Number(reserveQty),
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      setReservePartOption(null);
      setReservePartId('');
      setReserveQty('');
      setPartsFormError('');
      setActionError('');
      setActionInfo(t.partReserved);
      invalidate();
    },
    onError: (err) => {
      setActionInfo('');
      if (err instanceof ApiError && err.status === 409) {
        setActionError(t.alreadyProcessed);
        invalidate();
      } else if (err instanceof ApiError && err.status === 422) {
        setActionError(t.insufficientStock);
        invalidate();
      } else if (err instanceof ApiError) {
        setActionError(err.message);
      } else {
        setActionError(t.networkError);
      }
    },
  });

  const release = useMutation({
    mutationFn: (lineId: string) =>
      releasePart(id ?? '', lineId, { idempotencyKey: newIdempotencyKey() }),
    onSuccess: () => {
      setActionError('');
      setActionInfo(t.partReleased);
      invalidate();
    },
    onError: (err) => {
      setActionInfo('');
      if (err instanceof ApiError && (err.status === 409 || err.status === 422)) {
        setActionError(t.alreadyProcessed);
        invalidate();
      } else if (err instanceof ApiError) {
        setActionError(err.message);
      } else {
        setActionError(t.networkError);
      }
    },
  });

  const consume = useMutation({
    mutationFn: (lineId: string) =>
      consumePart(id ?? '', lineId, { idempotencyKey: newIdempotencyKey() }),
    onSuccess: () => {
      setActionError('');
      setActionInfo(t.partConsumed);
      invalidate();
    },
    onError: (err) => {
      setActionInfo('');
      if (err instanceof ApiError && (err.status === 409 || err.status === 422)) {
        setActionError(t.alreadyProcessed);
        invalidate();
      } else if (err instanceof ApiError) {
        setActionError(err.message);
      } else {
        setActionError(t.networkError);
      }
    },
  });

  const submitReserve = (event: React.FormEvent) => {
    event.preventDefault();
    setActionError('');
    const qty = Number(reserveQty);
    const available = partStock.data?.items[0]?.available ?? 0;
    if (!reservePartId || !Number.isInteger(qty) || qty <= 0) {
      setPartsFormError(t.required);
      return;
    }
    if (qty > available) {
      setPartsFormError(t.insufficientStock);
      return;
    }
    reserve.mutate();
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

  const { order, customer, device, branch, events, assignedTechnician } = detail.data;
  const allowed = canTransition
    ? (ALLOWED_TRANSITIONS[(order.status as RepairStatus) ?? 'received'] ?? [])
    : [];
  // Technicians may consume parts only on repairs assigned to them; other
  // roles with stock:consume are not assignee-restricted.
  const isTechnician = tenantContext?.role === 'technician';
  const isOwnRepair =
    assignedTechnician?.id != null && assignedTechnician.id === tenantContext?.userId;
  const canConsumeLine = canConsume && (!isTechnician || isOwnRepair);

  return (
    <PageContainer>
      <Typography variant="h1" component="h1" sx={{ mb: 3 }}>
        {t.repairDetails}
      </Typography>

      {actionError && (
        <Alert severity="error" sx={{ mb: 3 }} role="alert">
          {actionError}
        </Alert>
      )}
      {actionInfo && (
        <Alert severity="success" sx={{ mb: 3 }} role="alert">
          {actionInfo}
        </Alert>
      )}

      <SectionCard title={t.repairDetails}>
        <SummaryRow label={t.orderId}>
          <Typography variant="body1" sx={{ fontWeight: 700 }}>
            <bdi>{order.id}</bdi>
          </Typography>
        </SummaryRow>
        <Divider />
        <SummaryRow label={t.statusLabel}>
          <RepairStatusChip status={order.status} />
        </SummaryRow>
        <Divider />
        <SummaryRow label={t.receivedDate}>
          <Typography variant="body1">
            <DateTime value={order.createdAt} />
          </Typography>
        </SummaryRow>
        <Divider />
        <SummaryRow label={t.branch}>
          <Typography variant="body1">{branch.name}</Typography>
        </SummaryRow>
      </SectionCard>

      <SectionCard title={t.customer}>
        <SummaryRow label={t.customer}>
          <Link component={RouterLink} to={`/customers/${customer.id}`}>
            {customer.name}
          </Link>
        </SummaryRow>
        {customer.phone && (
          <>
            <Divider />
            <SummaryRow label={t.phone}>
              <Typography variant="body1">
                <bdi>{customer.phone}</bdi>
              </Typography>
            </SummaryRow>
          </>
        )}
        <Divider />
        <SummaryRow label={t.device}>
          <Typography variant="body1">
            {device.brand} {device.model}
            {device.serial ? ` — ${device.serial}` : ''}
          </Typography>
        </SummaryRow>
        <Divider />
        <SummaryRow label={t.assignedTechnician}>
          <Typography variant="body1">
            {assignedTechnician
              ? `${assignedTechnician.name ?? assignedTechnician.email ?? assignedTechnician.id}${assignedTechnician.email && assignedTechnician.name ? ` — ${assignedTechnician.email}` : ''}`
              : t.unassigned}
          </Typography>
        </SummaryRow>
      </SectionCard>

      <SectionCard title={t.transition}>
        {canAssign && (
          <Box sx={{ mb: 3 }}>
            <Typography variant="h3" component="h3" sx={{ mb: 1 }}>
              {t.assign}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {t.assignHint}
            </Typography>
            <Box
              component="form"
              sx={{ display: 'flex', gap: 1, '@media print': { display: 'none' } }}
              onSubmit={(e) => {
                e.preventDefault();
                if (technicianId.trim()) assign.mutate();
              }}
            >
              <FormControl size="small" sx={{ flexGrow: 1 }}>
                <InputLabel id="technician-label">{t.technician}</InputLabel>
                <Select
                  labelId="technician-label"
                  label={t.technician}
                  value={technicianId}
                  onChange={(e) => setTechnicianId(e.target.value)}
                >
                  {(technicians.data ?? []).map((tech: Technician) => (
                    <MenuItem key={tech.id} value={tech.id}>
                      {tech.name ?? tech.email}
                      {tech.name ? ` — ${tech.email}` : ''}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <Button
                type="submit"
                variant="contained"
                disabled={assign.isPending || !technicianId.trim()}
              >
                {t.assign}
              </Button>
            </Box>
          </Box>
        )}
        <TextField
          fullWidth
          label={t.note}
          placeholder={t.notePlaceholder}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          sx={{ mb: 2, '@media print': { display: 'none' } }}
        />
        <Box
          sx={{
            display: 'flex',
            gap: 1,
            flexWrap: 'wrap',
            '@media print': { display: 'none' },
          }}
        >
          {allowed.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              —
            </Typography>
          )}
          {allowed.map((toStatus) => (
            <Button
              key={toStatus}
              variant="outlined"
              disabled={transition.isPending}
              onClick={() => transition.mutate(toStatus)}
            >
              {statusLabel(lang, toStatus)}
            </Button>
          ))}
        </Box>
      </SectionCard>

      {canReadInventory && (
        <SectionCard title={t.repairParts}>
          {repairParts.isLoading && <CircularProgress size={20} aria-label="loading" />}
          {repairParts.isError && (
            <Alert severity="error" sx={{ mb: 2 }} role="alert">
              {repairParts.error instanceof ApiError ? repairParts.error.message : t.networkError}
            </Alert>
          )}
          {repairParts.data && repairParts.data.items.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {t.noRepairParts}
            </Typography>
          )}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mb: 2 }}>
            {repairParts.data?.items.map((line: RepairPartLine) => (
              <Box
                key={line.id}
                sx={{
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: '12px',
                  p: 2,
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
                  <Typography variant="body1" sx={{ fontWeight: 700, flexGrow: 1, minWidth: 0 }}>
                    <bdi>{line.partSku}</bdi> — {line.partName}
                  </Typography>
                  <PartLineStatusChip status={line.status} />
                </Box>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                  {t.quantity} <bdi>{line.qty}</bdi> · <DateTime value={line.createdAt} />
                </Typography>
                {line.status === 'reserved' && (
                  <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                    {canRelease && (
                      <Button
                        size="small"
                        variant="outlined"
                        disabled={release.isPending || consume.isPending}
                        onClick={() => release.mutate(line.id)}
                      >
                        {t.release}
                      </Button>
                    )}
                    {canConsumeLine && (
                      <Button
                        size="small"
                        variant="outlined"
                        disabled={release.isPending || consume.isPending}
                        onClick={() => consume.mutate(line.id)}
                      >
                        {t.consume}
                      </Button>
                    )}
                  </Box>
                )}
              </Box>
            ))}
          </Box>

          {canReserve && (
            <Box component="form" onSubmit={submitReserve} noValidate>
              <Typography variant="h3" component="h3" sx={{ mb: 2 }}>
                {t.reservePart}
              </Typography>
              <Box sx={{ mb: 2 }}>
                <SearchPicker
                  label={t.selectPart}
                  value={reservePartOption}
                  onChange={handleReservePartChange}
                  onSearch={searchParts}
                />
              </Box>
              {reservePartId && (
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  {t.available}: <bdi>{partStock.data?.items[0]?.available ?? 0}</bdi>
                </Typography>
              )}
              <TextField
                fullWidth
                type="number"
                label={t.quantity}
                value={reserveQty}
                onChange={(e) => setReserveQty(e.target.value)}
                sx={{ mb: 2 }}
                required
              />
              {partsFormError && (
                <Alert severity="warning" sx={{ mb: 2 }} role="alert">
                  {partsFormError}
                </Alert>
              )}
              <Button
                type="submit"
                variant="contained"
                disabled={reserve.isPending || !reservePartId}
              >
                {reserve.isPending ? <CircularProgress size={24} /> : t.reserve}
              </Button>
            </Box>
          )}
        </SectionCard>
      )}

      <SectionCard title={t.history}>
        {events.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            {t.noHistory}
          </Typography>
        )}
        <Box sx={{ display: 'flex', flexDirection: 'column' }}>
          {[...events]
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .map((event, index) => (
              <Box
                key={event.id}
                sx={{
                  display: 'flex',
                  gap: 2,
                  py: 1.5,
                  borderTop: index === 0 ? 0 : 1,
                  borderColor: 'divider',
                }}
              >
                <Box
                  sx={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    backgroundColor: 'primary.main',
                    flexShrink: 0,
                    mt: 1,
                  }}
                />
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body1" sx={{ fontWeight: 600 }}>
                    {event.fromStatus
                      ? `${statusLabel(lang, event.fromStatus)} → ${statusLabel(lang, event.toStatus)}`
                      : statusLabel(lang, event.toStatus)}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    <DateTime value={event.createdAt} />
                    {event.note ? ` · ${event.note}` : ''}
                  </Typography>
                </Box>
              </Box>
            ))}
        </Box>
      </SectionCard>

      <TrackingLinkCard repairId={id ?? ''} />

      <SectionCard title={t.receipt}>
        {receipt.isLoading && <CircularProgress size={20} aria-label="loading" />}
        {receipt.data && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="body1" sx={{ fontWeight: 700 }}>
              {receipt.data.tenant.name} — {receipt.data.branch.name}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t.customer}: {receipt.data.customer.name}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t.device}: {receipt.data.device.brand} {receipt.data.device.model}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t.statusLabel}: {statusLabel(lang, receipt.data.order.status)}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t.issuedAt}: <DateTime value={receipt.data.issuedAt} />
            </Typography>
          </Box>
        )}
        <Button
          variant="outlined"
          sx={{ '@media print': { display: 'none' } }}
          onClick={() => window.print()}
        >
          {t.printReceipt}
        </Button>
      </SectionCard>
    </PageContainer>
  );
}
