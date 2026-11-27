import DateTime from '../components/DateTime';
import { PageContainer, SectionCard } from '../components/SectionCard';
import { RepairStatusChip } from '../components/StatusChip';
import SearchPicker, { type SearchPickerOption } from '../components/SearchPicker';
import { useCallback, useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import {
  ApiError,
  createRepair,
  getCustomer,
  listCustomers,
  listRepairs,
  type Device,
  type RepairOrder,
} from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { REPAIR_STATUSES, statusLabel, useLanguage, useStrings } from '../i18n';

/**
 * Repairs list: readable cards with a status chip (label always
 * present, never colour alone). Filters are separated from the list:
 * the status chips sit on their own scrollable row, the branch
 * select on the next row. There is no text search here on purpose —
 * the list API has no search parameter, so a search box would only
 * filter the loaded page and mislead. The new-repair form stays on
 * the page below the list.
 *
 * Identifiers: the list endpoint returns the repair rows only (id,
 * branchId, customerId, deviceId, status, problemDescription,
 * timestamps) — no customer name and no device brand/model, which
 * only the detail endpoint joins. No backend change is in scope
 * here, so the cards show what the list actually returns: the order
 * ID (the stable identifier, also the link's accessible name), the
 * problem description when present, branch and received date. No
 * customer or device name is shown, because inventing one would be
 * fake data.
 */
/** Short display number: last 6 chars of the id. shortcut: not guaranteed unique, upgrade to a per-shop counter if shops need strict numbering. */
export function shortRepairNumber(id: string): string {
  return id.slice(-6).toUpperCase();
}

export default function RepairsPage() {
  const t = useStrings();
  const lang = useLanguage();
  const { tenantContext, memberships } = useAuth();
  const queryClient = useQueryClient();

  const [searchParams, setSearchParams] = useSearchParams();
  // The filters are derived from the URL, not from mount-time state:
  // a dashboard chip links to /repairs?status=X, and the bottom
  // navigation links to /repairs. Both navigate without remounting
  // this page, so reading the param once on mount left the filter
  // stale (URL said one thing, the list showed another). Writing a
  // filter change back to the URL with replace keeps the address
  // bar, the chips and the list in sync in both directions.
  const statusFilter = searchParams.get('status') ?? '';
  const branchFilter = searchParams.get('branchId') ?? '';
  const [searchText, setSearchText] = useState('');
  const searchTerm = searchText.trim().length >= 2 ? searchText.trim() : '';
  const setFilter = (key: 'status' | 'branchId', value: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  };

  const branchIds = tenantContext?.branchIds ?? memberships.flatMap((m) => m.branchIds);
  const selectedMembership =
    memberships.find((m) => m.tenantId === tenantContext?.tenantId) ?? memberships[0];
  const branchLabel = (id: string) =>
    selectedMembership?.branches?.find((b) => b.id === id)?.name ?? id;

  const repairs = useInfiniteQuery({
    queryKey: ['repairs', statusFilter, branchFilter, searchTerm],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      listRepairs({
        status: statusFilter || undefined,
        search: searchTerm || undefined,
        branchId: branchFilter || undefined,
        cursor: pageParam ?? undefined,
        limit: 50,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    retry: false,
  });
  const repairItems = repairs.data?.pages.flatMap((page) => page.items) ?? [];

  // --- New repair form ---
  const [customerOption, setCustomerOption] = useState<SearchPickerOption | null>(null);
  const [customerId, setCustomerId] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [problem, setProblem] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [formError, setFormError] = useState('');
  const [serverError, setServerError] = useState('');

  const searchCustomers = useCallback(
    (query: string, cursor?: string | null) =>
      listCustomers({ search: query, cursor: cursor ?? undefined, limit: 10 }).then((result) => ({
        options: result.items.map((c) => ({
          id: c.id,
          label: c.name,
          secondary: c.phone ?? undefined,
        })),
        nextCursor: result.nextCursor,
      })),
    [],
  );

  const handleCustomerChange = (option: SearchPickerOption | null) => {
    setCustomerOption(option);
    setCustomerId(option?.id ?? '');
    setDeviceId('');
  };

  const selectedCustomer = useQuery({
    queryKey: ['customer', customerId],
    queryFn: () => getCustomer(customerId),
    enabled: Boolean(customerId),
    retry: false,
  });

  const devices: Device[] = selectedCustomer.data?.devices ?? [];

  const create = useMutation({
    mutationFn: () =>
      createRepair({
        customerId,
        deviceId,
        branchId,
        problemDescription: problem.trim(),
        ...(expectedDate
          ? { expectedReadyAt: new Date(`${expectedDate}T18:00:00`).toISOString() }
          : {}),
      }),
    onSuccess: () => {
      setCustomerOption(null);
      setCustomerId('');
      setDeviceId('');
      setBranchId('');
      setProblem('');
      setExpectedDate('');
      setFormError('');
      void queryClient.invalidateQueries({ queryKey: ['repairs'] });
    },
    onError: (err) => {
      setServerError(err instanceof ApiError ? err.message : t.networkError);
    },
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setServerError('');
    if (!customerId || !deviceId || !branchId || !problem.trim()) {
      setFormError(t.required);
      return;
    }
    create.mutate();
  };

  return (
    <PageContainer>
      <Typography variant="h1" component="h1" sx={{ mb: 3 }}>
        {t.repairsTitle}
      </Typography>

      <TextField
        fullWidth
        size="small"
        type="search"
        value={searchText}
        onChange={(e) => setSearchText(e.target.value)}
        placeholder={t.searchRepairs}
        slotProps={{ htmlInput: { 'aria-label': t.searchRepairs, maxLength: 60 } }}
        sx={{ mb: 1.5 }}
      />
      <Box
        role="group"
        aria-label={t.filterStatus}
        sx={{
          display: 'flex',
          gap: 1,
          mb: 2,
          overflowX: 'auto',
          pb: 0.5,
          mx: { xs: -2, sm: 0 },
          px: { xs: 2, sm: 0 },
        }}
      >
        <Chip
          label={t.allStatuses}
          clickable
          onClick={() => setFilter('status', '')}
          color={statusFilter === '' ? 'primary' : 'default'}
          variant={statusFilter === '' ? 'filled' : 'outlined'}
          sx={{ height: 44, flexShrink: 0 }}
          aria-pressed={statusFilter === ''}
        />
        {REPAIR_STATUSES.map((status) => (
          <Chip
            key={status}
            label={statusLabel(lang, status)}
            clickable
            onClick={() => setFilter('status', status)}
            color={statusFilter === status ? 'primary' : 'default'}
            variant={statusFilter === status ? 'filled' : 'outlined'}
            sx={{ height: 44, flexShrink: 0 }}
            aria-pressed={statusFilter === status}
          />
        ))}
      </Box>

      <FormControl sx={{ minWidth: { xs: '100%', sm: 240 }, mb: 3 }}>
        <InputLabel id="branch-filter-label">{t.filterBranch}</InputLabel>
        <Select
          labelId="branch-filter-label"
          value={branchFilter}
          label={t.filterBranch}
          onChange={(e) => setFilter('branchId', e.target.value)}
        >
          <MenuItem value="">{t.allBranches}</MenuItem>
          {branchIds.map((id) => (
            <MenuItem key={id} value={id}>
              {branchLabel(id)}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {repairs.isLoading && <CircularProgress aria-label="loading" />}
      {repairs.isError && (
        <Alert severity="error" sx={{ mb: 2 }} role="alert">
          {repairs.error instanceof ApiError ? repairs.error.message : t.networkError}
        </Alert>
      )}
      {repairs.data && repairItems.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t.noRepairs}
        </Typography>
      )}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mb: 2 }}>
        {repairItems.map((repair: RepairOrder) => (
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
              backgroundColor: 'background.paper',
              border: 1,
              borderColor: 'divider',
              borderRadius: 4,
              boxShadow: '0 1px 2px rgba(16, 40, 28, 0.06)',
              p: 2,
              minHeight: 72,
              '&:hover': { borderColor: 'primary.main' },
            }}
          >
            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
              <Typography variant="body1" sx={{ fontWeight: 700 }} noWrap>
                <bdi dir="ltr">#{shortRepairNumber(repair.id)}</bdi>
                {repair.customer?.name ? <> · {repair.customer.name}</> : null}
              </Typography>
              {(repair.device || repair.problemDescription) && (
                <Typography variant="body2" noWrap>
                  {[
                    repair.device ? `${repair.device.brand} ${repair.device.model}` : '',
                    repair.problemDescription ?? '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Typography>
              )}
              <Typography variant="body2" color="text.secondary" noWrap>
                {branchLabel(repair.branchId)} · <DateTime value={repair.createdAt} />
              </Typography>
            </Box>
            {repair.expectedReadyAt &&
              !['ready', 'delivered', 'cancelled', 'unrepairable'].includes(repair.status) &&
              new Date(repair.expectedReadyAt).getTime() < Date.now() && (
                <Chip size="small" color="error" label={t.overdue} sx={{ mx: 1 }} />
              )}
            <RepairStatusChip status={repair.status} />
          </Box>
        ))}
      </Box>
      {repairs.hasNextPage && (
        <Button
          variant="outlined"
          sx={{ mb: 3 }}
          onClick={() => void repairs.fetchNextPage()}
          disabled={repairs.isFetchingNextPage}
        >
          {repairs.isFetchingNextPage ? t.loadingMore : t.loadMore}
        </Button>
      )}

      <SectionCard title={t.newRepair}>
        {serverError && (
          <Alert severity="error" sx={{ mb: 2 }} role="alert">
            {serverError}
          </Alert>
        )}
        <Box component="form" onSubmit={submit} noValidate>
          <Box sx={{ mb: 1 }}>
            <SearchPicker
              label={t.searchCustomerPlaceholder}
              value={customerOption}
              onChange={handleCustomerChange}
              onSearch={searchCustomers}
            />
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {t.searchPickerHint}
          </Typography>
          {!customerId && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {t.selectCustomerFirst}
            </Typography>
          )}
          <FormControl fullWidth sx={{ mb: 2 }} disabled={!customerId}>
            <InputLabel id="device-label">{t.device}</InputLabel>
            <Select
              labelId="device-label"
              value={deviceId}
              label={t.device}
              onChange={(e) => setDeviceId(e.target.value)}
            >
              {devices.map((d) => (
                <MenuItem key={d.id} value={d.id}>
                  {d.brand} {d.model}
                  {d.serial ? ` — ${d.serial}` : ''}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl fullWidth sx={{ mb: 2 }}>
            <InputLabel id="branch-label">{t.branch}</InputLabel>
            <Select
              labelId="branch-label"
              value={branchId}
              label={t.branch}
              onChange={(e) => setBranchId(e.target.value)}
            >
              {branchIds.map((id) => (
                <MenuItem key={id} value={id}>
                  {branchLabel(id)}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField
            fullWidth
            label={t.problemDescription}
            value={problem}
            onChange={(e) => setProblem(e.target.value)}
            multiline
            rows={3}
            sx={{ mb: 2 }}
            required
          />
          <TextField
            fullWidth
            type="date"
            label={t.expectedReadyDate}
            value={expectedDate}
            onChange={(e) => setExpectedDate(e.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ mb: 2 }}
          />
          {formError && (
            <Alert severity="warning" sx={{ mb: 2 }} role="alert">
              {formError}
            </Alert>
          )}
          <Button type="submit" variant="contained" disabled={create.isPending}>
            {create.isPending ? <CircularProgress size={24} /> : t.createRepair}
          </Button>
        </Box>
      </SectionCard>
    </PageContainer>
  );
}
