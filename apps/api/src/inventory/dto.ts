import { z } from 'zod';

/**
 * Inventory / stock DTOs. `.strict()` rejects unknown fields. Parts
 * carry no price: pricing is deliberately out of scope for Phase 5.
 */
export const CreatePartDto = z
  .object({
    sku: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(200),
  })
  .strict();

export const ListPartsQuery = z
  .object({
    search: z.string().trim().min(1).max(100).optional(),
    cursor: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export const ListStockQuery = z
  .object({
    branchId: z.string().min(1).max(200).optional(),
    partId: z.string().min(1).max(200).optional(),
    cursor: z.string().min(1).max(400).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const idempotencyKey = z.string().min(8).max(128);

export const AdjustStockDto = z
  .object({
    branchId: z.string().min(1).max(200),
    partId: z.string().min(1).max(200),
    delta: z
      .number()
      .int()
      .min(-100000)
      .max(100000)
      .refine((d) => d !== 0, 'Delta must not be zero.'),
    reason: z.string().trim().min(1).max(200).optional(),
    idempotencyKey,
  })
  .strict();

export const ListMovementsQuery = z
  .object({
    branchId: z.string().min(1).max(200).optional(),
    partId: z.string().min(1).max(200).optional(),
    /**
     * Exact match on the movement's operation key (the idempotency
     * key for reserve/release/consume/adjust, or the deterministic
     * auto-release key). Validated exactly like idempotency keys:
     * 8..128 characters. Used by the frontend's durable-retry
     * reconciliation: after a reload, look up whether a pending
     * operation already landed instead of retrying blindly.
     */
    operationKey: z.string().min(8).max(128).optional(),
    cursor: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export const ReservePartDto = z
  .object({
    partId: z.string().min(1).max(200),
    qty: z.number().int().min(1).max(100000),
    idempotencyKey,
  })
  .strict();

export const ReleaseConsumePartDto = z
  .object({
    idempotencyKey,
  })
  .strict();
