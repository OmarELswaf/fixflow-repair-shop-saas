import { z } from 'zod';
import { REPAIR_STATUSES } from './repair-status';

export const CreateRepairDto = z
  .object({
    customerId: z.string().min(1).max(200),
    deviceId: z.string().min(1).max(200),
    branchId: z.string().min(1).max(200),
    problemDescription: z.string().trim().min(1).max(2000),
    expectedReadyAt: z.iso.datetime().optional(),
  })
  .strict();

export const AssignDto = z
  .object({
    technicianUserId: z.string().min(1).max(200),
  })
  .strict();

export const TransitionDto = z
  .object({
    toStatus: z.enum(REPAIR_STATUSES),
    expectedVersion: z.number().int().min(0),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const TechniciansQuery = z
  .object({
    branchId: z.string().min(1).max(200),
  })
  .strict();

export const ListRepairsQuery = z
  .object({
    status: z.enum(REPAIR_STATUSES).optional(),
    branchId: z.string().min(1).max(200).optional(),
    cursor: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
