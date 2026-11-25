import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import { env } from '../env/env';
import { PrismaService } from '../prisma/prisma.service';
import { PASSWORD_HASHER, type PasswordHasher } from './ports';
import { clientIp, createRateLimiter, normalizeRateLimitEmail } from './rate-limit';
import { sendMail } from './mailer';

const TOKEN_TTL_MS = 30 * 60 * 1000;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const ForgotDto = z.object({ email: z.string().trim().toLowerCase().email().max(254) });
const ResetDto = z.object({
  token: z.string().min(20).max(200),
  password: z.string().max(1024).min(12, 'Password must be at least 12 characters.'),
});

function baseUrl(): string {
  const raw = env.PUBLIC_APP_URL ?? env.WEB_ORIGINS.split(',')[0] ?? '';
  return raw.trim().replace(/\/+$/, '');
}

@Controller('auth')
export class PasswordResetController {
  private readonly perIp = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10 });
  private readonly perEmail = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 3 });
  private readonly resetPerIp = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
  ) {}

  /** Always answers the same way so it cannot be used to discover which emails have accounts. */
  @Post('forgot-password')
  @HttpCode(200)
  async forgot(@Req() req: { ip?: string }, @Body() body: unknown) {
    const parsed = ForgotDto.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Enter a valid email address.');
    const email = normalizeRateLimitEmail(parsed.data.email);
    const ip = clientIp(req);
    const now = Date.now();
    if (
      !this.perIp.allow(`fp-ip:${ip}`, now).allowed ||
      !this.perEmail.allow(`fp:${email}`, now).allowed
    ) {
      throw new HttpException('Too many requests.', 429);
    }
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (user) {
      const token = randomBytes(32).toString('base64url');
      await this.prisma.passwordResetToken.create({
        data: { userId: user.id, tokenHash: sha(token), expiresAt: new Date(now + TOKEN_TTL_MS) },
      });
      const link = `${baseUrl()}/reset-password?token=${token}`;
      const sent = await sendMail(
        user.email,
        'إعادة تعيين كلمة المرور | FixFlow password reset',
        `<div dir="rtl" style="font-family:sans-serif"><p>طلبت إعادة تعيين كلمة المرور. الرابط صالح 30 دقيقة:</p><p><a href="${link}">${link}</a></p><p>لو لم تطلب ذلك تجاهل الرسالة.</p></div>` +
          `<div style="font-family:sans-serif"><p>You asked to reset your FixFlow password. This link works for 30 minutes:</p><p><a href="${link}">${link}</a></p><p>If this was not you, ignore this email.</p></div>`,
      );
      if (!sent)
        console.warn('forgot-password: email not sent (mail not configured or provider error)');
    }
    return { ok: true };
  }

  @Post('reset-password')
  @HttpCode(200)
  async reset(@Req() req: { ip?: string }, @Body() body: unknown) {
    if (!this.resetPerIp.allow(`rp-ip:${clientIp(req)}`, Date.now()).allowed) {
      throw new HttpException('Too many requests.', 429);
    }
    const parsed = ResetDto.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const rec = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: sha(parsed.data.token) },
    });
    if (!rec || rec.usedAt || rec.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('This reset link is invalid or has expired.');
    }
    const passwordHash = await this.hasher.hash(parsed.data.password);
    const used = await this.prisma.passwordResetToken.updateMany({
      where: { id: rec.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (used.count !== 1)
      throw new BadRequestException('This reset link is invalid or has expired.');
    await this.prisma.user.update({ where: { id: rec.userId }, data: { passwordHash } });
    // Sign out existing sessions (refresh sessions are tenant-scoped under RLS).
    const memberships = await this.prisma
      .$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.auth_user_id', ${rec.userId}, true)`;
        return tx.membership.findMany({ where: { userId: rec.userId } });
      })
      .catch(() => []);
    for (const m of memberships) {
      await this.prisma
        .withTenant(m.tenantId, (tx) =>
          tx.refreshSession.updateMany({
            where: { userId: rec.userId, revokedAt: null },
            data: { revokedAt: new Date() },
          }),
        )
        .catch(() => undefined);
    }
    return { ok: true };
  }
}
