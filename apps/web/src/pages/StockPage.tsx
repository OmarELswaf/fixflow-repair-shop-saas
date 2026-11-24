import DateTime from '../components/DateTime';
import { PageContainer, SectionCard } from '../components/SectionCard';
import SearchPicker, { type SearchPickerOption } from '../components/SearchPicker';
import { useCallback, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  FormControl,
  InputLabel,
  Link,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Select,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import {
  ApiError,
  adjustStock,
  listMovements,
  listParts,
  listStock,
  newIdempotencyKey,
  type StockMovement,
  type StockRow,
} from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { movementReasonLabel, useLanguage, useStrings } from '../i18n';

export default function StockPage() {
  const t = useStrings();
  const lang = useLanguage();
  const { tenantContext, memberships } = useAuth();
  const canWrite = tenantContext?.permissions.includes('inventory:write') ?? false;
  const queryClient = useQueryClient();

  const branchIds = tenantContext?.branchIds ?? memberships.flatMap((m) => m.branchIds);
  const selectedMembership =
    memberships.find((m) => m.tenantId === tenantContext?.tenantId) ?? memberships[0];
  const branchLabel = (id: string) =>
    selectedMembership?.branches?.find((b) => b.id === id)?.name ?? id;

  const [branchFilter, setBranchFilter] = useState('');
  const [partFilter, setPartFilter] = useState('');
  const [partFilterOption, setPartFilterOption] = useState<SearchPickerOption | null>(null);

  const handlePartFilterChange = (option: SearchPickerOption | null) => {
    setPartFilterOption(option);
    setPartFilter(option?.id ?? '');
  };

  const stock = useInfiniteQuery({
    queryKey: ['stock', branchFilter, partFilter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      listStock({
        branchId: branchFilter || undefined,
        partId: partFilter || undefined,
        cursor: pageParam ?? undefined,
        limit: 50,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    retry: false,
  });
  const stockItems = stock.data?.pages.flatMap((page) => page.items) ?? [];

  const movements = useInfiniteQuery({
    queryKey: ['movements', branchFilter, partFilter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      listMovements({
        branchId: branchFilter || undefined,
        partId: partFilter || undefined,
        cursor: pageParam ?? undefined,
        limit: 50,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    retry: false,
  });
  const movementItems = movements.data?.pages.flatMap((page) => page.items) ?? [];

  // --- Adjust form ---
  const [adjustBranchId, setAdjustBranchId] = useState('');
  const [adjustPartOption, setAdjustPartOption] = useState<SearchPickerOption | null>(null);
  const [adjustPartId, setAdjustPartId] = useState('');
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState('');
  const [serverError, setServerError] = useState('');
  const [adjustedRow, setAdjustedRow] = useState<StockRow | null>(null);

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

  const handleAdjustPartChange = (option: SearchPickerOption | null) => {
    setAdjustPartOption(option);
    setAdjustPartId(option?.id ?? '');
  };

  const adjust = useMutation({
    mutationFn: () =>
      adjustStock({
        branchId: adjustBranchId,
        partId: adjustPartId,
        delta: Number(delta),
        reason: reason.trim() || undefined,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: (row) => {
      setAdjustedRow(row);
      setAdjustPartOption(null);
      setAdjustPartId('');
      setDelta('');
      setReason('');
      setFormError('');
      void queryClient.invalidateQueries({ queryKey: ['stock'] });
      void queryClient.invalidateQueries({ queryKey: ['movements'] });
    },
    onError: (err) => {
      setAdjustedRow(null);
      if (err instanceof ApiError && err.status === 422) {
        setServerError(t.insufficientStock);
      } else if (err instanceof ApiError) {
        setServerError(err.message);
      } else {
        setServerError(t.networkError);
      }
    },
  });

  const submitAdjust = (event: React.FormEvent) => {
    event.preventDefault();
    setServerError('');
    const parsed = Number(delta);
    if (!adjustBranchId || !adjustPartId || !Number.isInteger(parsed) || parsed === 0) {
      setFormError(t.required);
      return;
    }
    adjust.mutate();
  };

  const sortedMovements = [...movementItems].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <PageContainer>
      <Typography variant="h1" component="h1" sx={{ mb: 3 }}>
        {t.stockTitle}
      </Typography>

      <Box sx={{ display: 'flex', gap: 2, mb: 2, flexWrap: 'wrap' }}>
        <FormControl sx={{ minWidth: 180 }}>
          <InputLabel id="stock-branch-filter-label">{t.filterBranch}</InputLabel>
          <Select
            labelId="stock-branch-filter-label"
            value={branchFilter}
            label={t.filterBranch}
            onChange={(e) => setBranchFilter(e.target.value)}
          >
            <MenuItem value="">{t.allBranches}</MenuItem>
            {branchIds.map((id) => (
              <MenuItem key={id} value={id}>
                {branchLabel(id)}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Box sx={{ minWidth: 220, flexGrow: 1 }}>
          <SearchPicker
            label={t.filterPart}
            value={partFilterOption}
            onChange={handlePartFilterChange}
            onSearch={searchParts}
          />
        </Box>
      </Box>

      {stock.isLoading && <CircularProgress aria-label="loading" />}
      {stock.isError && (
        <Alert severity="error" sx={{ mb: 2 }} role="alert">
          {stock.error instanceof ApiError ? stock.error.message : t.networkError}
        </Alert>
      )}
      {stock.data && stockItems.length === 0 && (
        <Typography variant="body2" sx={{ mb: 2 }}>
          {t.noStock}
        </Typography>
      )}
      {stock.data && stockItems.length > 0 && (
        <TableContainer sx={{ mb: 3 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t.partName}</TableCell>
                <TableCell>{t.branch}</TableCell>
                <TableCell>{t.onHand}</TableCell>
                <TableCell>{t.reserved}</TableCell>
                <TableCell>{t.available}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {stockItems.map((row: StockRow) => (
                <TableRow key={`${row.branchId}:${row.partId}`}>
                  <TableCell>
                    <bdi>{row.partSku}</bdi> — {row.partName}
                  </TableCell>
                  <TableCell>{row.branchName}</TableCell>
                  <TableCell>
                    <bdi>{row.qtyOnHand}</bdi>
                  </TableCell>
                  <TableCell>
                    <bdi>{row.reservedQty}</bdi>
                  </TableCell>
                  <TableCell>
                    <bdi>{row.available}</bdi>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {stock.hasNextPage && (
        <Button
          variant="outlined"
          sx={{ mb: 3 }}
          onClick={() => void stock.fetchNextPage()}
          disabled={stock.isFetchingNextPage}
        >
          {stock.isFetchingNextPage ? t.loadingMore : t.loadMore}
        </Button>
      )}

      {canWrite && (
        <SectionCard title={t.adjustStock}>
          {serverError && (
            <Alert severity="error" sx={{ mb: 2 }} role="alert">
              {serverError}
            </Alert>
          )}
          {adjustedRow && (
            <Alert severity="success" sx={{ mb: 2 }} role="alert">
              {t.stockAdjusted} <bdi>{adjustedRow.partSku}</bdi> — {adjustedRow.branchName}:{' '}
              {t.onHand} <bdi>{adjustedRow.qtyOnHand}</bdi> · {t.reserved}{' '}
              <bdi>{adjustedRow.reservedQty}</bdi> · {t.available}{' '}
              <bdi>{adjustedRow.available}</bdi>
            </Alert>
          )}
          <Box component="form" onSubmit={submitAdjust} noValidate>
            <FormControl fullWidth sx={{ mb: 2 }}>
              <InputLabel id="adjust-branch-label">{t.branch}</InputLabel>
              <Select
                labelId="adjust-branch-label"
                value={adjustBranchId}
                label={t.branch}
                onChange={(e) => setAdjustBranchId(e.target.value)}
              >
                {branchIds.map((id) => (
                  <MenuItem key={id} value={id}>
                    {branchLabel(id)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Box sx={{ mb: 2 }}>
              <SearchPicker
                label={t.selectPart}
                value={adjustPartOption}
                onChange={handleAdjustPartChange}
                onSearch={searchParts}
              />
            </Box>
            <TextField
              fullWidth
              type="number"
              label={t.delta}
              value={delta}
              onChange={(e) => setDelta(e.target.value)}
              sx={{ mb: 1 }}
              required
            />
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {t.deltaHint}
            </Typography>
            <TextField
              fullWidth
              label={t.reason}
              placeholder={t.reasonPlaceholder}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              sx={{ mb: 2 }}
            />
            {formError && (
              <Alert severity="warning" sx={{ mb: 2 }} role="alert">
                {formError}
              </Alert>
            )}
            <Button type="submit" variant="contained" disabled={adjust.isPending}>
              {adjust.isPending ? <CircularProgress size={24} /> : t.adjust}
            </Button>
          </Box>
        </SectionCard>
      )}

      <SectionCard title={t.movements}>
        {movements.isLoading && <CircularProgress size={20} aria-label="loading" />}
        {movements.isError && (
          <Alert severity="error" sx={{ mb: 2 }} role="alert">
            {movements.error instanceof ApiError ? movements.error.message : t.networkError}
          </Alert>
        )}
        {movements.data && sortedMovements.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            {t.noMovements}
          </Typography>
        )}
        <List>
          {sortedMovements.map((m: StockMovement) => (
            <ListItem key={m.id} divider>
              <ListItemText
                primary={
                  <>
                    <bdi>{m.partSku}</bdi> — {m.partName} ·{' '}
                    <bdi>{m.qty > 0 ? `+${m.qty}` : `${m.qty}`}</bdi> ·{' '}
                    {movementReasonLabel(lang, m.reason)}
                  </>
                }
                secondary={
                  <>
                    {m.branchName} · <DateTime value={m.createdAt} />
                    {m.actorName ? ` · ${m.actorName}` : ''}
                    {m.repairOrderId ? (
                      <>
                        {' · '}
                        {t.repairLink}:{' '}
                        <Link component={RouterLink} to={`/repairs/${m.repairOrderId}`}>
                          <bdi>{m.repairOrderId}</bdi>
                        </Link>
                      </>
                    ) : (
                      ''
                    )}
                  </>
                }
              />
            </ListItem>
          ))}
        </List>
        {movements.hasNextPage && (
          <Button
            variant="outlined"
            sx={{ mt: 1 }}
            onClick={() => void movements.fetchNextPage()}
            disabled={movements.isFetchingNextPage}
          >
            {movements.isFetchingNextPage ? t.loadingMore : t.loadMore}
          </Button>
        )}
      </SectionCard>
    </PageContainer>
  );
}
