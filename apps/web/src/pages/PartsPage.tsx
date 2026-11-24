import DateTime from '../components/DateTime';
import { PageContainer, SectionCard } from '../components/SectionCard';
import { useEffect, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { ApiError, createPart, getPart, listParts, type Part } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useStrings } from '../i18n';

export default function PartsPage() {
  const t = useStrings();
  const { tenantContext } = useAuth();
  const canWrite = tenantContext?.permissions.includes('inventory:write') ?? false;
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedPartId, setSelectedPartId] = useState('');
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [formError, setFormError] = useState('');
  const [serverError, setServerError] = useState('');
  const [createInfo, setCreateInfo] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const parts = useInfiniteQuery({
    queryKey: ['parts', debouncedSearch],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      listParts({
        search: debouncedSearch || undefined,
        cursor: pageParam ?? undefined,
        limit: 50,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    retry: false,
  });
  const partItems = parts.data?.pages.flatMap((page) => page.items) ?? [];

  const detail = useQuery({
    queryKey: ['part', selectedPartId],
    queryFn: () => getPart(selectedPartId),
    enabled: Boolean(selectedPartId),
    retry: false,
  });

  const create = useMutation({
    mutationFn: () => createPart({ sku: sku.trim(), name: name.trim() }),
    onSuccess: () => {
      setSku('');
      setName('');
      setFormError('');
      setCreateInfo(t.partCreated);
      void queryClient.invalidateQueries({ queryKey: ['parts'] });
    },
    onError: (err) => {
      setCreateInfo('');
      setServerError(err instanceof ApiError ? err.message : t.networkError);
    },
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setServerError('');
    if (!sku.trim() || !name.trim()) {
      setFormError(t.required);
      return;
    }
    create.mutate();
  };

  return (
    <PageContainer>
      <Typography variant="h1" component="h1" sx={{ mb: 3 }}>
        {t.partsTitle}
      </Typography>
      <TextField
        fullWidth
        label={t.searchParts}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        sx={{ mb: 2 }}
      />
      {parts.isLoading && <CircularProgress aria-label="loading" />}
      {parts.isError && (
        <Alert severity="error" sx={{ mb: 2 }} role="alert">
          {parts.error instanceof ApiError ? parts.error.message : t.networkError}
        </Alert>
      )}
      {parts.data && partItems.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t.noParts}
        </Typography>
      )}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mb: 2 }}>
        {partItems.map((part: Part) => (
          <Box
            key={part.id}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              backgroundColor: 'background.paper',
              border: 1,
              borderColor: 'divider',
              borderRadius: 4,
              boxShadow: '0 1px 2px rgba(16, 40, 28, 0.06)',
              p: 2,
              minHeight: 72,
            }}
          >
            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
              <Typography variant="body1" sx={{ fontWeight: 700 }} noWrap>
                <bdi>{part.sku}</bdi> — {part.name}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                <DateTime value={part.createdAt} />
              </Typography>
            </Box>
            <Button
              size="small"
              variant={selectedPartId === part.id ? 'contained' : 'outlined'}
              onClick={() => setSelectedPartId((current) => (current === part.id ? '' : part.id))}
            >
              {t.partDetails}
            </Button>
          </Box>
        ))}
      </Box>
      {parts.hasNextPage && (
        <Button
          variant="outlined"
          sx={{ mb: 3 }}
          onClick={() => void parts.fetchNextPage()}
          disabled={parts.isFetchingNextPage}
        >
          {parts.isFetchingNextPage ? t.loadingMore : t.loadMore}
        </Button>
      )}

      {selectedPartId && (
        <SectionCard title={t.partDetails}>
          {detail.isLoading && <CircularProgress size={20} aria-label="loading" />}
          {detail.isError && (
            <Alert severity="error" role="alert">
              {detail.error instanceof ApiError ? detail.error.message : t.networkError}
            </Alert>
          )}
          {detail.data && (
            <>
              <Typography variant="body1" sx={{ fontWeight: 700 }}>
                <bdi>{detail.data.sku}</bdi> — {detail.data.name}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                {t.createdAt}: <DateTime value={detail.data.createdAt} />
              </Typography>
              <Typography variant="h3" component="h3" sx={{ mb: 1 }}>
                {t.branchStock}
              </Typography>
              {detail.data.stock.length === 0 && (
                <Typography variant="body2" color="text.secondary">
                  {t.noStock}
                </Typography>
              )}
              {detail.data.stock.length > 0 && (
                <TableContainer sx={{ mb: 1 }}>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>{t.branch}</TableCell>
                        <TableCell>{t.onHand}</TableCell>
                        <TableCell>{t.reserved}</TableCell>
                        <TableCell>{t.available}</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {detail.data.stock.map((row) => (
                        <TableRow key={row.branchId}>
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
            </>
          )}
          <Button variant="outlined" sx={{ mt: 2 }} onClick={() => setSelectedPartId('')}>
            {t.close}
          </Button>
        </SectionCard>
      )}

      {canWrite && (
        <SectionCard title={t.newPart}>
          {serverError && (
            <Alert severity="error" sx={{ mb: 2 }} role="alert">
              {serverError}
            </Alert>
          )}
          {createInfo && (
            <Alert severity="success" sx={{ mb: 2 }} role="alert">
              {createInfo}
            </Alert>
          )}
          <Box component="form" onSubmit={submit} noValidate>
            <TextField
              fullWidth
              label={t.sku}
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              sx={{ mb: 2 }}
              required
            />
            <TextField
              fullWidth
              label={t.partName}
              value={name}
              onChange={(e) => setName(e.target.value)}
              sx={{ mb: 2 }}
              required
            />
            {formError && (
              <Alert severity="warning" sx={{ mb: 2 }} role="alert">
                {formError}
              </Alert>
            )}
            <Button type="submit" variant="contained" disabled={create.isPending}>
              {create.isPending ? <CircularProgress size={24} /> : t.createPart}
            </Button>
          </Box>
        </SectionCard>
      )}
    </PageContainer>
  );
}
