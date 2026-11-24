import { createTheme, type Theme } from '@mui/material/styles';

/**
 * FixFlow design system (Phase 10).
 *
 * Contemporary, calm, repair-shop SaaS: deep green primary, soft
 * neutral surfaces, one gold accent used sparingly, generous radius
 * and spacing, 44px minimum touch targets, AA-contrast text.
 * System font stack only — no webfont downloads, so Arabic renders
 * well offline. No dark mode: the light theme is the whole system.
 *
 * Motion is restrained (small, fast transitions) and disabled under
 * `prefers-reduced-motion`.
 */
const theme: Theme = createTheme({
  palette: {
    primary: {
      main: '#0d3b2e',
      dark: '#092a20',
      light: '#dcebe2',
      contrastText: '#ffffff',
    },
    secondary: {
      main: '#b98a1d',
      dark: '#8a6a12',
      light: '#f7ecd0',
      contrastText: '#1c1a12',
    },
    background: { default: '#f4f6f3', paper: '#ffffff' },
    text: { primary: '#182420', secondary: '#54655c', disabled: '#8a978f' },
    divider: '#e2e8e3',
    success: { main: '#177245', dark: '#0f5132', light: '#dcf2e4', contrastText: '#ffffff' },
    warning: { main: '#8a5a00', dark: '#6b4500', light: '#fdf0d3', contrastText: '#ffffff' },
    error: { main: '#b3261e', dark: '#7a1a15', light: '#fdecea', contrastText: '#ffffff' },
    info: { main: '#175cd3', dark: '#0b3d91', light: '#e3edfd', contrastText: '#ffffff' },
  },
  shape: { borderRadius: 12 },
  typography: {
    fontFamily: "'Noto Sans Arabic', 'Segoe UI', system-ui, -apple-system, sans-serif",
    h1: { fontSize: '1.75rem', lineHeight: 1.3, fontWeight: 700 },
    h2: { fontSize: '1.375rem', lineHeight: 1.35, fontWeight: 700 },
    h3: { fontSize: '1.125rem', lineHeight: 1.4, fontWeight: 700 },
    h4: { fontSize: '1.125rem', lineHeight: 1.4, fontWeight: 700 },
    h5: { fontSize: '1rem', lineHeight: 1.5, fontWeight: 700 },
    h6: { fontSize: '0.9375rem', lineHeight: 1.5, fontWeight: 700 },
    subtitle1: { fontSize: '1rem', lineHeight: 1.7 },
    body1: { fontSize: '1rem', lineHeight: 1.7 },
    body2: { fontSize: '0.875rem', lineHeight: 1.65 },
    button: { fontSize: '0.9375rem', fontWeight: 600, letterSpacing: 0, textTransform: 'none' },
    caption: { fontSize: '0.75rem', lineHeight: 1.5 },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        '@media (prefers-reduced-motion: reduce)': {
          '*, *::before, *::after': {
            animationDuration: '0.01ms !important',
            animationIterationCount: '1 !important',
            transitionDuration: '0.01ms !important',
            scrollBehavior: 'auto !important',
          },
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: { minHeight: 44, borderRadius: 10, textTransform: 'none', fontWeight: 600 },
        sizeSmall: { minHeight: 44, paddingInline: 12 },
      },
    },
    MuiIconButton: {
      styleOverrides: { root: { minWidth: 44, minHeight: 44, padding: 10 } },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: 16,
          border: '1px solid #e2e8e3',
          boxShadow: '0 1px 2px rgba(16, 40, 28, 0.06)',
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        outlined: { borderColor: '#e2e8e3' },
      },
    },
    MuiAlert: {
      styleOverrides: { root: { borderRadius: 12 } },
    },
    MuiChip: {
      styleOverrides: {
        root: { borderRadius: 8, fontWeight: 600 },
      },
    },
    MuiBottomNavigation: {
      styleOverrides: {
        root: {
          height: 64,
          borderTop: '1px solid #e2e8e3',
          backgroundColor: '#ffffff',
        },
      },
    },
    MuiBottomNavigationAction: {
      styleOverrides: {
        root: {
          minWidth: 0,
          minHeight: 64,
          paddingTop: 8,
          paddingBottom: 6,
          color: '#54655c',
          '&.Mui-selected': { color: '#0d3b2e' },
        },
        label: { fontSize: '0.75rem', fontWeight: 600 },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          minHeight: 48,
          borderRadius: 10,
          '&.Mui-selected': {
            backgroundColor: '#dcebe2',
            color: '#092a20',
            fontWeight: 700,
            '& .MuiListItemIcon-root': { color: '#0d3b2e' },
          },
        },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: { padding: '12px 16px', borderColor: '#eef2ee' },
        head: { fontWeight: 700, color: '#182420', backgroundColor: '#f7f9f7' },
      },
    },
    MuiAccordion: {
      styleOverrides: {
        root: {
          borderRadius: 16,
          border: '1px solid #e2e8e3',
          boxShadow: '0 1px 2px rgba(16, 40, 28, 0.06)',
          '&::before': { display: 'none' },
          '&.Mui-expanded': { margin: 0 },
        },
      },
    },
    MuiAccordionSummary: {
      styleOverrides: { root: { minHeight: 48, borderRadius: 16 } },
    },
  },
});

export default theme;
