import { useQuery } from '@tanstack/react-query';
import { Alert, CircularProgress } from '@mui/material';
import { useParams } from 'react-router-dom';
import { ApiError, fetchPublicShop } from '../api/client';
import { useStrings } from '../i18n';
import { PageContainer } from '../components/SectionCard';
import PublicShopView from '../components/PublicShopView';

/**
 * Public landing page at /s/:slug. No auth, no app shell navigation,
 * no private data: it renders only the eight public fields of a
 * published profile. An unpublished or unknown slug is the same
 * not-found message — the page never says which one it was.
 */
export default function PublicShopPage() {
  const t = useStrings();
  const { slug } = useParams<{ slug: string }>();
  const shop = useQuery({
    queryKey: ['public-shop', slug],
    queryFn: () => fetchPublicShop(slug ?? ''),
    enabled: Boolean(slug),
    retry: false,
  });

  return (
    <PageContainer>
      {shop.isLoading && <CircularProgress aria-label="loading" />}
      {shop.isError && (
        <Alert severity="error" role="alert">
          {shop.error instanceof ApiError && shop.error.status === 404
            ? t.publicPageNotFound
            : shop.error instanceof ApiError
              ? shop.error.message
              : t.networkError}
        </Alert>
      )}
      {shop.data && <PublicShopView profile={shop.data} />}
    </PageContainer>
  );
}
