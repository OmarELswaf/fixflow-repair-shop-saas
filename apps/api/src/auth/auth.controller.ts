import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  AuthService,
  DuplicateEmailError,
  InvalidCredentialsError,
  RefreshReuseDetectedError,
  TenantNotMemberError,
} from './auth.service';
import { InvalidRefreshTokenError } from './refresh-sessions';
import { JwtAuthGuard } from './jwt-auth.guard';
import { LoginDto, LogoutDto, RefreshDto, RegisterDto, SelectTenantDto } from './dto';
import {
  clearRefreshCookieHeader,
  parseCookies,
  refreshCookieHeader,
  REFRESH_COOKIE_NAME,
} from './cookies';
import { env } from '../env/env';

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(result.error.issues.map((i) => i.message).join('; '));
  }
  return result.data;
}

/** Minimal shape of the Express response the controller touches. */
export interface PassthroughResponse {
  setHeader(name: string, value: string): void;
}

function refreshCookieMaxAgeSeconds(): number {
  return env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60;
}

function refreshCookieSecure(): boolean {
  return env.NODE_ENV === 'production';
}

function setRefreshCookie(res: PassthroughResponse, token: string): void {
  res.setHeader(
    'Set-Cookie',
    refreshCookieHeader(token, refreshCookieMaxAgeSeconds(), refreshCookieSecure()),
  );
}

function clearRefreshCookie(res: PassthroughResponse): void {
  res.setHeader('Set-Cookie', clearRefreshCookieHeader(refreshCookieSecure()));
}

type BrowserRequest = { headers?: { cookie?: string; origin?: string; referer?: string } };
/** Browser responses never expose the refresh secret to JavaScript. */
function responseTokens<T>(result: T, req: BrowserRequest): T {
  if (!req.headers?.origin && !req.headers?.referer && !req.headers?.cookie) return result;
  const copy = JSON.parse(JSON.stringify(result));
  if (copy.tokens) delete copy.tokens.refreshToken;
  delete copy.refreshToken;
  return copy;
}

/** Refresh token resolution: the ff_refresh cookie wins, else the JSON body. */
function resolveRefreshToken(
  req: { headers?: { cookie?: string } },
  bodyToken: string | undefined,
): string | undefined {
  return parseCookies(req.headers?.cookie)[REFRESH_COOKIE_NAME] ?? bodyToken;
}

/**
 * Auth endpoints. No email verification or password-reset delivery is
 * implemented in Phase 3 — those routes deliberately do not exist
 * (see docs/AUTH.md). Error messages are generic where they could
 * otherwise leak whether an email is registered.
 *
 * Browser token design (docs/AUTH.md "Browser token design"): the
 * refresh token is delivered as an HttpOnly SameSite=Lax cookie.
 * Only non-browser requests without Origin, Referer or cookies also
 * receive it in JSON. Browser JSON contains the access token only.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  async register(
    @Req() req: BrowserRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: PassthroughResponse,
  ) {
    if (env.REGISTRATION_ENABLED === 'false')
      throw new ForbiddenException('Registration is disabled on this demo.');
    const dto = parse(RegisterDto, body);
    try {
      const result = await this.auth.register(dto);
      setRefreshCookie(res, result.tokens.refreshToken);
      return responseTokens(result, req);
    } catch (e) {
      if (e instanceof DuplicateEmailError) throw new ConflictException(e.message);
      throw e;
    }
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Req() req: BrowserRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: PassthroughResponse,
  ) {
    const dto = parse(LoginDto, body);
    try {
      const result = await this.auth.login(dto.email, dto.password);
      if (result.tokens && result.tokens.refreshToken) {
        setRefreshCookie(res, result.tokens.refreshToken);
      } else {
        clearRefreshCookie(res);
      }
      return responseTokens(result, req);
    } catch (e) {
      if (e instanceof InvalidCredentialsError) throw new UnauthorizedException(e.message);
      throw e;
    }
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: BrowserRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: PassthroughResponse,
  ) {
    const dto = parse(RefreshDto, body ?? {});
    const token = resolveRefreshToken(req, dto.refreshToken);
    if (!token) throw new BadRequestException('Refresh token is required.');
    try {
      const result = await this.auth.refresh(token);
      setRefreshCookie(res, result.refreshToken);
      return responseTokens(result, req);
    } catch (e) {
      if (
        e instanceof InvalidCredentialsError ||
        e instanceof InvalidRefreshTokenError ||
        e instanceof RefreshReuseDetectedError
      ) {
        throw new UnauthorizedException('Invalid or expired refresh token.');
      }
      throw e;
    }
  }

  @Post('select-tenant')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async selectTenant(
    @Req() req: BrowserRequest & { user: { id: string } },
    @Body() body: unknown,
    @Res({ passthrough: true }) res: PassthroughResponse,
  ) {
    const dto = parse(SelectTenantDto, body);
    try {
      const result = await this.auth.selectTenant(req.user.id, dto.tenantId);
      setRefreshCookie(res, result.tokens.refreshToken);
      return responseTokens(result, req);
    } catch (e) {
      if (e instanceof TenantNotMemberError) throw new ForbiddenException(e.message);
      if (e instanceof InvalidCredentialsError) throw new UnauthorizedException(e.message);
      throw e;
    }
  }

  @Post('logout')
  @HttpCode(200)
  async logout(
    @Req() req: BrowserRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: PassthroughResponse,
  ) {
    const dto = parse(LogoutDto, body ?? {});
    const token = resolveRefreshToken(req, dto.refreshToken);
    if (token) await this.auth.logout(token);
    clearRefreshCookie(res);
    return { ok: true };
  }

  @Post('logout-all')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async logoutAll(
    @Req() req: BrowserRequest & { user: { id: string } },
    @Res({ passthrough: true }) res: PassthroughResponse,
  ) {
    await this.auth.logoutAll(req.user.id);
    clearRefreshCookie(res);
    return { ok: true };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@Req() req: { user: { id: string }; tenantContext?: { tenantId: string } | null }) {
    return this.auth.me(req.user.id, req.tenantContext?.tenantId ?? null);
  }
}
