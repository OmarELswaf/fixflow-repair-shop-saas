import { z } from 'zod';

/** Report DTOs. `.strict()` rejects unknown fields. All reports are read-only. */

export const REPAIR_STATUSES = [
  'received',
  'diagnosing',
  'awaiting_approval',
  'awaiting_parts',
  'in_repair',
  'quality_check',
  'ready',
  'delivered',
  'cancelled',
  'unrepairable',
] as const;

const isoDate = z
  .string()
  .refine(
    (s) =>
      /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(s) &&
      !Number.isNaN(Date.parse(s)),
    'Must be an ISO date string.',
  );

export const RepairsSummaryQuery = z
  .object({
    status: z.enum(REPAIR_STATUSES).optional(),
    branchId: z.string().min(1).max(200).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .strict()
  .refine(
    (value) => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to),
    'From must not be after to.',
  );

export const StockReportQuery = z
  .object({
    partId: z.string().min(1).max(200).optional(),
    branchId: z.string().min(1).max(200).optional(),
    cursor: z.string().min(1).max(400).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export const StockSummaryQuery = z
  .object({
    branchId: z.string().min(1).max(200).optional(),
  })
  .strict();
