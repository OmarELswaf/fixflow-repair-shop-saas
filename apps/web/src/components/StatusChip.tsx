import { Chip } from '@mui/material';
import { partLineStatusLabel, statusLabel, useLanguage } from '../i18n';

/**
 * Status chip: the label is always present as text — colour is never
 * the only signal. Every (background, text) pair is AA-contrast for
 * normal text. Used for repair statuses and repair-part line
 * statuses.
 */
const REPAIR_STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  received: { bg: '#e9edf2', fg: '#3d4a5c' },
  diagnosing: { bg: '#e3e8fd', fg: '#3730a3' },
  awaiting_approval: { bg: '#fdf0d3', fg: '#7c4a03' },
  awaiting_parts: { bg: '#ffeedd', fg: '#8a3d0b' },
  in_repair: { bg: '#dbeafe', fg: '#1d4ed8' },
  quality_check: { bg: '#ede9fe', fg: '#5b21b6' },
  ready: { bg: '#dcf2e4', fg: '#14532d' },
  delivered: { bg: '#ccfbf1', fg: '#0f766e' },
  cancelled: { bg: '#eef1f4', fg: '#475569' },
  unrepairable: { bg: '#fee2e2', fg: '#991b1b' },
};

const PART_LINE_STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  reserved: { bg: '#fdf0d3', fg: '#7c4a03' },
  consumed: { bg: '#dcf2e4', fg: '#14532d' },
  released: { bg: '#eef1f4', fg: '#475569' },
};

const FALLBACK = { bg: '#eef1f4', fg: '#475569' };

export function RepairStatusChip({ status }: { status: string }) {
  const lang = useLanguage();
  const colors = REPAIR_STATUS_COLORS[status] ?? FALLBACK;
  return (
    <Chip
      label={statusLabel(lang, status)}
      size="small"
      sx={{ backgroundColor: colors.bg, color: colors.fg, height: 28, fontSize: '0.8125rem' }}
    />
  );
}

export function PartLineStatusChip({ status }: { status: string }) {
  const lang = useLanguage();
  const colors = PART_LINE_STATUS_COLORS[status] ?? FALLBACK;
  return (
    <Chip
      label={partLineStatusLabel(lang, status)}
      size="small"
      sx={{ backgroundColor: colors.bg, color: colors.fg, height: 28, fontSize: '0.8125rem' }}
    />
  );
}
