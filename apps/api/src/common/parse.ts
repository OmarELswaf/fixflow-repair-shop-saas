import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

/** Parse a request body/query with a zod schema; invalid input is a 400. */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestException(result.error.issues.map((i) => i.message).join('; '));
  }
  return result.data;
}
