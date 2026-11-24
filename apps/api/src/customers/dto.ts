import { z } from 'zod';

/**
 * Customer / device DTOs. `.strict()` rejects unknown fields — in
 * particular there is NO password / PIN / unlock-code field on a
 * device: device unlock passwords are never collected or stored.
 */
export const CreateCustomerDto = z
  .object({
    name: z.string().trim().min(1).max(200),
    phone: z
      .string()
      .trim()
      .regex(/^[+0-9 ()-]{6,30}$/, 'Phone must be 6-30 characters of digits, +, spaces, () or -.')
      .optional(),
  })
  .strict();

export const CreateDeviceDto = z
  .object({
    brand: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(100),
    serial: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export const ListCustomersQuery = z
  .object({
    search: z.string().trim().min(1).max(100).optional(),
    cursor: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
