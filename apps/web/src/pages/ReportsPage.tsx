import DateTime from '../components/DateTime';
import { PageContainer, SectionCard } from '../components/SectionCard';
import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  CircularProgress,
  FormControl,
  InputLabel,
  Link,
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
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {
  ApiError,
  fetchRepairsSummary,
  fetchStockOverview,
  type StockReportRow,
} from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { agingLabel, REPAIR_STATUSES, statusLabel, useLanguage, useStrings } from '../i18n';

/**
 * Read-only operational reports: repair counts by status and age, and
 * stock/reservation reconciliation. All queries are bounded
 * (cursor-based) and branch-scoped to the user's scope.
 *
 * Layout: summary cards first, filters collapsed behind an accordion,
 * stock rows as cards on a phone and a table on desktop. The
 * per-response snapshot disclosure is kept verbatim.
 */
export default function ReportsPage() {
  const t = useStrings();
  const lang = useLanguage();
  const { tenantContext, memberships } = useAuth();
  const canReadReports = tenantContext?.permissions.includes('report:read') ?? false;

  const branchIds = tenantContext?.branchIds ?? memberships.flatMap((m) => m.branchIds);
  const selectedMembership =
    memberships.find((m) => m.tenantId === tenantContext?.tenantId) ?? memberships[0];
  const branchLabel = (id: string) =>
    selectedMembership?.branches?.find((b) => b.id === id)?.name ?? id;

  const [branchFilter, setBranchFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const repairsSummary = useQuery({
    queryKey: ['reports-repairs', statusFilter, branchFilter, fromDate, toDate],
    queryFn: () =>
      fetchRepairsSummary({
        status: statusFilter || undefined,
        branchId: branchFilter || undefined,
        from: fromDate ? new Date(`${fromDate}T00:00:00`).toISOString() : undefined,
        to: toDate ? new Date(`${toDate}T23:59:59.999`).toISOString() : undefined,
      }),
    enabled: canReadReports,
    retry: false,
  });

  // Each response is snapshot-consistent. Later pages use newer snapshots.
  const stockOverview = useInfiniteQuery({
    queryKey: ['reports-stock-overview', branchFilter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      fetchStockOverview({
        branchId: branchFilter || undefined,
        cursor: pageParam ?? undefined,
        limit: 20,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: canReadReports,
    retry: false,
  });
  const stockSummary = stockOverview.data?.pages[0]?.summary ?? null;
  const stockSnapshotAt = stockOverview.data?.pages[0]?.snapshotAt ?? null;
  const stockRows = stockOverview.data?.pages.flatMap((page) => page.items) ?? [];

  if (!canReadReports) {
    return (
      <PageContainer>
        <Alert severity="warning" role="alert">
          {t.noAccess}
        </Alert>
      </PageContainer>
    );
  }

  const repairsLink = new URLSearchParams();
  if (statusFilter) repairsLink.set('status', statusFilter);
  if (branchFilter) repairsLink.set('branchId', branchFilter);
  const repairsSuffix = repairsLink.toString();

  return (
    <PageContainer>
      <Typography variant="h1" component="h1" sx={{ mb: 3 }}>
        {t.reportsTitle}
      </Typography>

      <Accordion sx={{ mb: 3 }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="body1" sx={{ fontWeight: 700 }}>
            {t.filters}
          </Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' },
              gap: 2,
            }}
          >
            <FormControl fullWidth>
              <InputLabel id="reports-branch-filter-label">{t.filterBranch}</InputLabel>
              <Select
                labelId="reports-branch-filter-label"
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
            <FormControl fullWidth>
              <InputLabel id="reports-status-filter-label">{t.filterStatus}</InputLabel>
              <Select
                labelId="reports-status-filter-label"
                value={statusFilter}
                label={t.filterStatus}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <MenuItem value="">{t.allStatuses}</MenuItem>
                {REPAIR_STATUSES.map((status) => (
                  <MenuItem key={status} value={status}>
                    {statusLabel(lang, status)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <TextField
              fullWidth
              label={t.fromDate}
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              fullWidth
              label={t.toDate}
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
            />
          </Box>
        </AccordionDetails>
      </Accordion>

      <SectionCard title={t.repairsSummary}>
        {repairsSummary.isLoading && <CircularProgress aria-label="loading" />}
        {repairsSummary.isError && (
          <Alert severity="error" sx={{ mb: 2 }} role="alert">
            {repairsSummary.error instanceof ApiError
              ? repairsSummary.error.message
              : t.networkError}
          </Alert>
        )}
        {repairsSummary.data && (
          <>
            <Box sx={{ mb: 2 }}>
              <Typography variant="h2" component="p" sx={{ fontSize: '2rem' }}>
                <bdi>{repairsSummary.data.total}</bdi>
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {t.totalRepairs}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {t.asOf} <DateTime value={repairsSummary.data.snapshotAt} />
              </Typography>
            </Box>
            <Typography variant="h3" component="h3" sx={{ mb: 1 }}>
              {t.countByStatus}
            </Typography>
            {repairsSummary.data.byStatus.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                {t.noData}
              </Typography>
            ) : (
              <Box sx={{ mb: 2 }}>
                {repairsSummary.data.byStatus.map((row) => (
                  <Box
                    key={row.status}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 2,
                      py: 1,
                      borderTop: 1,
                      borderColor: 'divider',
                      '&:first-of-type': { borderTop: 0 },
                    }}
                  >
                    <Typography variant="body1">{statusLabel(lang, row.status)}</Typography>
                    <Typography variant="body1" sx={{ fontWeight: 700 }}>
                      <bdi>{row.count}</bdi>
                    </Typography>
                  </Box>
                ))}
              </Box>
            )}
            <Typography variant="h3" component="h3" sx={{ mb: 1 }}>
              {t.aging}
            </Typography>
            <Box sx={{ mb: 2 }}>
              {repairsSummary.data.aging.map((bucket) => (
                <Box
                  key={bucket.bucket}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 2,
                    py: 1,
                    borderTop: 1,
                    borderColor: 'divider',
                    '&:first-of-type': { borderTop: 0 },
                  }}
                >
                  <Typography variant="body1">{agingLabel(lang, bucket.bucket)}</Typography>
                  <Typography variant="body1" sx={{ fontWeight: 700 }}>
                    <bdi>{bucket.count}</bdi>
                  </Typography>
                </Box>
              ))}
            </Box>
            <Link component={RouterLink} to={`/repairs${repairsSuffix ? `?${repairsSuffix}` : ''}`}>
              {t.viewRepairs}
            </Link>
          </>
        )}
      </SectionCard>

      <SectionCard title={t.stockReconciliation}>
        {stockOverview.isLoading && <CircularProgress aria-label="loading" />}
        {stockOverview.isError && (
          <Alert severity="error" sx={{ mb: 2 }} role="alert">
            {stockOverview.error instanceof ApiError ? stockOverview.error.message : t.networkError}
          </Alert>
        )}
        {stockSummary && (
          <>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(5, 1fr)' },
                gap: 2,
                mb: 2,
              }}
            >
              {[
                { label: t.totalParts, value: stockSummary.totalParts },
                { label: t.totalOnHand, value: stockSummary.totalOnHand },
                { label: t.totalReserved, value: stockSummary.totalReserved },
                { label: t.totalAvailable, value: stockSummary.totalAvailable },
                { label: t.mismatchedRows, value: stockSummary.mismatchedRows },
              ].map((stat) => (
                <Box key={stat.label}>
                  <Typography
                    variant="h2"
                    component="p"
                    sx={{
                      fontSize: '1.5rem',
                      color:
                        stat.label === t.mismatchedRows && stat.value > 0
                          ? 'error.main'
                          : undefined,
                    }}
                  >
                    <bdi>{stat.value}</bdi>
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {stat.label}
                  </Typography>
                </Box>
              ))}
            </Box>
            {stockSnapshotAt && (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                {t.asOf} <DateTime value={stockSnapshotAt} />
              </Typography>
            )}
          </>
        )}
        {stockOverview.data && stockRows.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {t.noData}
          </Typography>
        )}
        {(stockOverview.data?.pages.length ?? 0) > 1 && (
          <Alert severity="info" sx={{ mb: 2 }}>
            {lang === 'ar'
              ? 'كل صفحة لها وقت قراءة مختلف. الإجمالي أعلاه يخص الصفحة الأولى، وقد تتغير الصفوف اللاحقة أثناء العمل.'
              : 'Each page has its own read time. Totals above belong to the first page; later rows may change during use.'}
          </Alert>
        )}
        {stockRows.length > 0 && (
          <Box sx={{ display: { xs: 'grid', md: 'none' }, gap: 2, mb: 2 }}>
            {stockRows.map((row) => (
              <Box
                key={`${row.branchId}:${row.partId}`}
                sx={{
                  border: 1,
                  borderColor: row.reconciled ? 'divider' : 'error.main',
                  p: 2,
                  borderRadius: 3,
                }}
              >
                <Typography sx={{ fontWeight: 700 }}>
                  <bdi>{row.partSku}</bdi> · {row.partName}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {t.branch}: {row.branchName}
                </Typography>
                <Typography variant="body2">
                  {t.onHand}: <bdi>{row.qtyOnHand}</bdi> · {t.reserved}:{' '}
                  <bdi>{row.reservedQty}</bdi> · {t.available}: <bdi>{row.available}</bdi>
                </Typography>
                <Typography variant="body2">
                  {t.reservedLinesTotal}: <bdi>{row.reservedLinesTotal}</bdi>
                </Typography>
                <Typography variant="body2">
                  {t.discrepancy}: <bdi>{row.discrepancy}</bdi> · {t.reconciled}:{' '}
                  {row.reconciled ? t.reconciled : t.notReconciled}
                </Typography>
              </Box>
            ))}
          </Box>
        )}
        {stockRows.length > 0 && (
          <TableContainer sx={{ mb: 2, display: { xs: 'none', md: 'block' } }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t.partName}</TableCell>
                  <TableCell>{t.branch}</TableCell>
                  <TableCell>{t.onHand}</TableCell>
                  <TableCell>{t.reserved}</TableCell>
                  <TableCell>{t.available}</TableCell>
                  <TableCell>{t.reservedLinesTotal}</TableCell>
                  <TableCell>{t.discrepancy}</TableCell>
                  <TableCell>{t.reconciled}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {stockRows.map((row: StockReportRow) => {
                  const mismatched = row.discrepancy !== 0 || !row.reconciled;
                  return (
                    <TableRow
                      key={`${row.branchId}:${row.partId}`}
                      sx={
                        mismatched
                          ? { backgroundColor: 'error.light', '& td': { fontWeight: 600 } }
                          : undefined
                      }
                    >
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
                      <TableCell>
                        <bdi>{row.reservedLinesTotal}</bdi>
                      </TableCell>
                      <TableCell>
                        <bdi>{row.discrepancy}</bdi>
                      </TableCell>
                      <TableCell>{row.reconciled ? t.reconciled : t.notReconciled}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
        {stockOverview.hasNextPage && (
          <Button
            variant="outlined"
            onClick={() => void stockOverview.fetchNextPage()}
            disabled={stockOverview.isFetchingNextPage}
          >
            {stockOverview.isFetchingNextPage ? t.loadingMore : t.loadMore}
          </Button>
        )}
      </SectionCard>
    </PageContainer>
  );
}
