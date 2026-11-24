import { z } from 'zod';

export const tenantIdSchema = z.string().min(1);

export const moneySchema = z
  .string()
  .regex(/^-?\d+(\.\d{1,4})?$/, 'Money must be a Decimal string, e.g. "12.50".');

export const PaginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export interface PaginatedResponse<T> {
  items: T[];
  nextCursor: string | null;
}

export interface HealthResponse {
  status: string;
}

export interface TenantContextDTO {
  userId: string;
  tenantId: string;
  branchIds: string[];
  role: string;
  permissions: string[];
}
