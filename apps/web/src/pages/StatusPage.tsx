import { Typography } from '@mui/material';
import { useStrings } from '../i18n';
import { PageContainer } from '../components/SectionCard';

export default function StatusPage() {
  const t = useStrings();
  return (
    <PageContainer>
      <Typography variant="h1" component="h1" sx={{ mb: 1 }}>
        {t.status}
      </Typography>
      <Typography variant="body1">{t.foundation}</Typography>
    </PageContainer>
  );
}
