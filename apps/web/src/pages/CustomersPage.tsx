import DateTime from '../components/DateTime';
import { PageContainer, SectionCard } from '../components/SectionCard';
import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Box, Button, CircularProgress, TextField, Typography } from '@mui/material';
import { ApiError, createCustomer, listCustomers, type Customer } from '../api/client';
import { useStrings } from '../i18n';

export default function CustomersPage() {
  const t = useStrings();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [formError, setFormError] = useState('');
  const [serverError, setServerError] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const customers = useInfiniteQuery({
    queryKey: ['customers', debouncedSearch],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      listCustomers({
        search: debouncedSearch || undefined,
        cursor: pageParam ?? undefined,
        limit: 50,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    retry: false,
  });
  const customerItems = customers.data?.pages.flatMap((page) => page.items) ?? [];

  const create = useMutation({
    mutationFn: () => createCustomer({ name: name.trim(), phone: phone.trim() || undefined }),
    onSuccess: () => {
      setName('');
      setPhone('');
      setFormError('');
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
    },
    onError: (err) => {
      setServerError(err instanceof ApiError ? err.message : t.networkError);
    },
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setServerError('');
    if (!name.trim()) {
      setFormError(t.required);
      return;
    }
    create.mutate();
  };

  return (
    <PageContainer>
      <Typography variant="h1" component="h1" sx={{ mb: 3 }}>
        {t.customersTitle}
      </Typography>
      <TextField
        fullWidth
        label={t.searchCustomers}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        sx={{ mb: 2 }}
      />
      {customers.isLoading && <CircularProgress aria-label="loading" />}
      {customers.isError && (
        <Alert severity="error" sx={{ mb: 2 }} role="alert">
          {customers.error instanceof ApiError ? customers.error.message : t.networkError}
        </Alert>
      )}
      {customers.data && customerItems.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t.noCustomers}
        </Typography>
      )}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mb: 2 }}>
        {customerItems.map((customer: Customer) => (
          <Box
            key={customer.id}
            component={RouterLink}
            to={`/customers/${customer.id}`}
            aria-label={customer.name}
            sx={{
              display: 'block',
              textDecoration: 'none',
              color: 'inherit',
              backgroundColor: 'background.paper',
              border: 1,
              borderColor: 'divider',
              borderRadius: 4,
              boxShadow: '0 1px 2px rgba(16, 40, 28, 0.06)',
              p: 2,
              '&:hover': { borderColor: 'primary.main' },
            }}
          >
            <Typography variant="body1" sx={{ fontWeight: 700 }}>
              {customer.name}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              <bdi>{customer.phone}</bdi> · <DateTime value={customer.createdAt} />
            </Typography>
          </Box>
        ))}
      </Box>
      {customers.hasNextPage && (
        <Button
          variant="outlined"
          sx={{ mb: 3 }}
          onClick={() => void customers.fetchNextPage()}
          disabled={customers.isFetchingNextPage}
        >
          {customers.isFetchingNextPage ? t.loadingMore : t.loadMore}
        </Button>
      )}

      <SectionCard title={t.newCustomer}>
        {serverError && (
          <Alert severity="error" sx={{ mb: 2 }} role="alert">
            {serverError}
          </Alert>
        )}
        <Box component="form" onSubmit={submit} noValidate>
          <TextField
            fullWidth
            label={t.customerName}
            value={name}
            onChange={(e) => setName(e.target.value)}
            sx={{ mb: 2 }}
            required
          />
          <TextField
            fullWidth
            label={t.phoneOptional}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            sx={{ mb: 2 }}
          />
          {formError && (
            <Alert severity="warning" sx={{ mb: 2 }} role="alert">
              {formError}
            </Alert>
          )}
          <Button type="submit" variant="contained" disabled={create.isPending}>
            {create.isPending ? <CircularProgress size={24} /> : t.createCustomer}
          </Button>
        </Box>
      </SectionCard>
    </PageContainer>
  );
}
