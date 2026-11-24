import { Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';

/**
 * Standard page container: centred content, responsive gutters,
 * wider than the old 800–900px columns so tables and card grids
 * breathe on desktop without going edge-to-edge on a phone.
 */
export function PageContainer({ children }: { children: ReactNode }) {
  return (
    <Box sx={{ px: { xs: 2, sm: 3 }, py: { xs: 2, sm: 3 }, maxWidth: 1080, mx: 'auto' }}>
      {children}
    </Box>
  );
}

/**
 * One content section: a soft card with an optional heading,
 * subheading and action area. Sections are the unit of hierarchy —
 * pages compose sections instead of one long undifferentiated stack.
 */
export function SectionCard({
  title,
  subtitle,
  action,
  children,
  id,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <Box
      id={id}
      sx={{
        backgroundColor: 'background.paper',
        border: 1,
        borderColor: 'divider',
        borderRadius: '16px',
        boxShadow: '0 1px 2px rgba(16, 40, 28, 0.06)',
        p: { xs: 2, sm: 3 },
        mb: 3,
      }}
    >
      {(title || action) && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 2,
            mb: subtitle ? 0.5 : 2,
          }}
        >
          {title ? (
            <Typography variant="h2" component="h2" sx={{ fontSize: '1.125rem' }}>
              {title}
            </Typography>
          ) : (
            <span />
          )}
          {action}
        </Box>
      )}
      {subtitle && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {subtitle}
        </Typography>
      )}
      {children}
    </Box>
  );
}
