import DateTime from '../components/DateTime';
import { PageContainer, SectionCard } from '../components/SectionCard';
import { RepairStatusChip } from '../components/StatusChip';
import { Link as RouterLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Card,
  CardActionArea,
  Chip,
  CircularProgress,
  Link,
  Typography,
} from '@mui/material';
import AssessmentIcon from '@mui/icons-material/Assessment';
import BuildIcon from '@mui/icons-material/Build';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import PeopleIcon from '@mui/icons-material/People';
import {
  ApiError,
  fetchHealth,
  fetchRepairsSummary,
  fetchStockOverview,
  listRepairs,
} from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { roleLabel, statusLabel, useLanguage, useStrings } from '../i18n';

/**
 * Dashboard: only real operational data, from the endpoints the app
 * already has. Repair counts come from the repairs summary, stock
 * figures from the stock overview, and the latest repairs from the
 * repairs list (newest first). No revenue, no invented metrics, no
 * charts. Quick actions link to real flows; a card is shown only
 * when the user has the permission that flow needs.
 */
export default function HomePage() {
  const t = useStrings();
  const lang = useLanguage();
  const { tenantContext, memberships } = useAuth();
  const canWriteInventory = tenantContext?.permissions.includes('inventory:write') ?? false;
  const canReadReports = tenantContext?.permissions.includes('report:read') ?? false;
  const role = tenantContext?.role ?? memberships[0]?.role ?? '';
  const branchIds = tenantContext?.branchIds ?? memberships.flatMap((m) => m.branchIds);
  const selectedMembership =
    memberships.find((m) => m.tenantId === tenantContext?.tenantId) ?? memberships[0];
  const branchLabel = (id: string) =>
    selectedMembership?.branches?.find((b) => b.id === id)?.name ?? id;
  const shopName = tenantContext?.tenantName ?? t.appName;

  const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth, retry: false });
  const repairsSummary = useQuery({
    queryKey: ['dashboard-repairs-summary'],
    queryFn: () => fetchRepairsSummary({}),
    enabled: canReadReports,
    retry: false,
  });
  const stockOverview = useQuery({
    queryKey: ['dashboard-stock-overview'],
    queryFn: () => fetchStockOverview({ limit: 1 }),
    enabled: canReadReports,
    retry: false,
  });
  const latestRepairs = useQuery({
    queryKey: ['dashboard-latest-repairs'],
    queryFn: () => listRepairs({ limit: 6 }),
    retry: false,
  });

  const byStatus = repairsSummary.data?.byStatus ?? [];
  const countOf = (status: string) => byStatus.find((row) => row.status === status)?.count ?? 0;
  const total = repairsSummary.data?.total ?? 0;
  const open = total - countOf('delivered') - countOf('cancelled') - countOf('unrepairable');
  const needsAttention = countOf('awaiting_approval') + countOf('awaiting_parts');
  const over30 = repairsSummary.data?.aging.find((b) => b.bucket === '30d+')?.count ?? 0;
  const stockSummary = stockOverview.data?.summary ?? null;

  const quickActions = [
    {
      to: '/repairs',
      label: t.newRepair,
      hint: t.quickNewRepairHint,
      icon: <BuildIcon />,
      show: true,
    },
    {
      to: '/customers',
      label: t.newCustomer,
      hint: t.quickNewCustomerHint,
      icon: <PeopleIcon />,
      show: true,
    },
    {
      to: '/stock',
      label: t.adjustStock,
      hint: t.quickAdjustStockHint,
      icon: <Inventory2Icon />,
      show: canWriteInventory,
    },
    {
      to: '/reports',
      label: t.reports,
      hint: t.quickReportsHint,
      icon: <AssessmentIcon />,
      show: canReadReports,
    },
  ].filter((action) => action.show);

  return (
    <PageContainer>
      <Typography variant="h1" component="h1" sx={{ mb: 0.5 }}>
        {shopName}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        {role ? `${t.role}: ${roleLabel(lang, role)}` : ''}
        {branchIds.length > 0
          ? `${role ? ' · ' : ''}${t.branches}: ${branchIds.map(branchLabel).join(', ')}`
          : ''}
      </Typography>

      <Typography variant="h2" component="h2" sx={{ mb: 2, fontSize: '1.125rem' }}>
        {t.quickActions}
      </Typography>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'repeat(2, 1fr)', md: 'repeat(4, 1fr)' },
          gap: 2,
          mb: 3,
        }}
      >
        {quickActions.map((action) => (
          <Card key={action.to}>
            <CardActionArea
              component={RouterLink}
              to={action.to}
              sx={{
                p: 2,
                minHeight: 108,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 1,
              }}
            >
              <Box sx={{ color: 'primary.main', display: 'flex' }}>{action.icon}</Box>
              <Typography variant="body1" sx={{ fontWeight: 700, lineHeight: 1.4 }}>
                {action.label}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.5 }}>
                {action.hint}
              </Typography>
            </CardActionArea>
          </Card>
        ))}
      </Box>

      {canReadReports && (
        <SectionCard title={t.repairsSummary}>
          {repairsSummary.isLoading && <CircularProgress aria-label="loading" />}
          {repairsSummary.isError && (
            <Alert severity="error" role="alert">
              {repairsSummary.error instanceof ApiError
                ? repairsSummary.error.message
                : t.networkError}
            </Alert>
          )}
          {repairsSummary.data && (
            <>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(4, 1fr)' },
                  gap: 2,
                  mb: 2,
                }}
              >
                <Box>
                  <Typography variant="h2" component="p" sx={{ fontSize: '1.75rem' }}>
                    <bdi>{total}</bdi>
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {t.totalRepairs}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="h2" component="p" sx={{ fontSize: '1.75rem' }}>
                    <bdi>{open}</bdi>
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {t.openRepairs}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {t.openRepairsHint}
                  </Typography>
                </Box>
                <Box>
                  <Typography
                    variant="h2"
                    component="p"
                    sx={{
                      fontSize: '1.75rem',
                      color: needsAttention > 0 ? 'warning.dark' : undefined,
                    }}
                  >
                    <bdi>{needsAttention}</bdi>
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {t.needsAttention}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {t.needsAttentionHint}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="h2" component="p" sx={{ fontSize: '1.75rem' }}>
                    <bdi>{over30}</bdi>
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {t.over30Days}
                  </Typography>
                </Box>
              </Box>
              {byStatus.length > 0 && (
                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1 }}>
                  {byStatus.map((row) => (
                    <Chip
                      key={row.status}
                      component={RouterLink}
                      to={`/repairs?status=${row.status}`}
                      clickable
                      label={`${statusLabel(lang, row.status)} · ${row.count}`}
                      sx={{ height: 44 }}
                    />
                  ))}
                </Box>
              )}
              <Typography variant="body2" color="text.secondary">
                {t.asOf} <DateTime value={repairsSummary.data.snapshotAt} />
              </Typography>
            </>
          )}
        </SectionCard>
      )}

      {canReadReports && (
        <SectionCard
          title={t.stock}
          action={
            <Link component={RouterLink} to="/reports">
              {t.reports}
            </Link>
          }
        >
          {stockOverview.isLoading && <CircularProgress aria-label="loading" />}
          {stockOverview.isError && (
            <Alert severity="error" role="alert">
              {stockOverview.error instanceof ApiError
                ? stockOverview.error.message
                : t.networkError}
            </Alert>
          )}
          {stockSummary && (
            <>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(5, 1fr)' },
                  gap: 2,
                  mb: 1,
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
              {stockSummary.mismatchedRows > 0 && (
                <Alert severity="warning" sx={{ mb: 1 }} role="alert">
                  {t.mismatchedWarning}
                </Alert>
              )}
              {stockOverview.data?.snapshotAt && (
                <Typography variant="body2" color="text.secondary">
                  {t.asOf} <DateTime value={stockOverview.data.snapshotAt} />
                </Typography>
              )}
            </>
          )}
        </SectionCard>
      )}

      <SectionCard
        title={t.latestRepairs}
        action={
          <Link component={RouterLink} to="/repairs">
            {t.viewAllRepairs}
          </Link>
        }
      >
        {latestRepairs.isLoading && <CircularProgress aria-label="loading" />}
        {latestRepairs.isError && (
          <Alert severity="error" role="alert">
            {latestRepairs.error instanceof ApiError ? latestRepairs.error.message : t.networkError}
          </Alert>
        )}
        {latestRepairs.data && latestRepairs.data.items.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            {t.noRepairs}
          </Typography>
        )}
        {latestRepairs.data && latestRepairs.data.items.length > 0 && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            {latestRepairs.data.items.map((repair) => (
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
                  borderRadius: '12px',
                  p: 2,
                  minHeight: 64,
                  '&:hover': { borderColor: 'primary.main' },
                }}
              >
                <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                  <Typography variant="body1" sx={{ fontWeight: 700 }} noWrap>
                    <bdi>{repair.id}</bdi>
                  </Typography>
                  {repair.problemDescription && (
                    <Typography variant="body2" noWrap>
                      {repair.problemDescription}
                    </Typography>
                  )}
                  <Typography variant="body2" color="text.secondary">
                    <DateTime value={repair.createdAt} />
                  </Typography>
                </Box>
                <RepairStatusChip status={repair.status} />
              </Box>
            ))}
          </Box>
        )}
      </SectionCard>

      {health.isError ? (
        <Alert severity="warning" role="alert">
          {t.health}: {t.networkError}
        </Alert>
      ) : (
        health.data && (
          <Typography variant="body2" color="text.secondary">
            {t.health}: {health.data.status}
          </Typography>
        )
      )}
    </PageContainer>
  );
}
