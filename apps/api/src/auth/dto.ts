import { z } from 'zod';

export const RegisterDto = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().max(1024).min(12, 'Password must be at least 12 characters.'),
  name: z.string().min(1).max(200).optional(),
  tenantName: z.string().min(1).max(200),
  branchName: z.string().min(1).max(200),
});

export const LoginDto = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(1024),
});

export const RefreshDto = z.object({
  // Optional: the refresh token may come from the ff_refresh cookie
  // instead (browser flow). When present in the body it must still
  // match the 64-hex-char shape.
  refreshToken: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

export const SelectTenantDto = z.object({
  tenantId: z.string().min(1),
});

export const LogoutDto = z.object({
  refreshToken: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
