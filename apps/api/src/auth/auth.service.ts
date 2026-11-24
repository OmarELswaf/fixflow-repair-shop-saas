import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  AUTH_DB,
  AUTH_OPTIONS,
  PASSWORD_HASHER,
  REFRESH_SESSION_STORE,
  type AuthDb,
  type AuthOptions,
  type PasswordHasher,
  type RefreshSessionStore,
} from './ports';
import {
  generateRefreshToken,
  hashRefreshToken,
  newFamilyId,
  rotateRefreshToken,
  RefreshTokenReuseError,
} from './refresh-sessions';
import { permissionsForRole } from '../tenancy/permissions';
import { resolveTenantContext, type TenantContext } from '../tenancy/tenant-context';

export class DuplicateEmailError extends Error {
  constructor() {
    super('Email is already registered.');
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid email or password.');
  }
}

export class TenantNotMemberError extends Error {
  constructor() {
    super('User is not a member of this tenant.');
  }
}

export class RefreshReuseDetectedError extends Error {
  constructor() {
    super('Refresh token reuse detected.');
  }
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface LoginResult {
  user: { id: string; email: string; name: string | null };
  /** Null when the user has several tenants and must select one first. */
  tenantId: string | null;
  /** Present only when a tenant is selected (single membership). */
  tokens: TokenPair | null;
  /** Present only when tenant selection is required. */
  requiresTenantSelection?: boolean;
  tenants?: Array<{ tenantId: string; role: string; name: string | null }>;
}

const MIN_PASSWORD_LENGTH = 12;

/**
 * AuthService — registration, login, refresh rotation, logout, tenant
 * selection. All tenant ids come from server-side memberships; a
 * client-supplied tenantId that is not a membership is rejected.
 * No email verification or password reset is implemented in Phase 3
 * (see docs/AUTH.md) — emailVerifiedAt stays NULL.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(AUTH_DB) private readonly db: AuthDb,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(REFRESH_SESSION_STORE) private readonly sessions: RefreshSessionStore,
    private readonly jwt: JwtService,
    @Inject(AUTH_OPTIONS) private readonly options: AuthOptions,
  ) {}

  private async signAccess(
    userId: string,
    email: string,
    tenantId: string | null,
  ): Promise<string> {
    return this.jwt.signAsync(
      { sub: userId, email, tenantId },
      { expiresIn: this.options.accessTtlSeconds },
    );
  }

  private async issueTokens(userId: string, email: string, tenantId: string): Promise<TokenPair> {
    const accessToken = await this.signAccess(userId, email, tenantId);
    const refreshToken = generateRefreshToken();
    const expiresAt = new Date(Date.now() + this.options.refreshTtlDays * 24 * 60 * 60 * 1000);
    await this.sessions.create({
      userId,
      tenantId,
      tokenHash: hashRefreshToken(refreshToken),
      familyId: newFamilyId(),
      expiresAt,
    });
    return { accessToken, refreshToken };
  }

  async register(input: {
    email: string;
    password: string;
    name?: string;
    tenantName: string;
    branchName: string;
  }): Promise<{
    user: { id: string; email: string; name: string | null };
    tenant: { id: string; name: string };
    branch: { id: string; name: string };
    tokens: TokenPair;
  }> {
    if (input.password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    const existing = await this.db.findUserByEmail(input.email);
    if (existing) throw new DuplicateEmailError();
    const passwordHash = await this.hasher.hash(input.password);
    const created = await this.db.registerOwner({
      email: input.email,
      passwordHash,
      name: input.name,
      tenantName: input.tenantName,
      branchName: input.branchName,
    });
    const tokens = await this.issueTokens(created.user.id, created.user.email, created.tenant.id);
    return {
      user: { id: created.user.id, email: created.user.email, name: created.user.name },
      tenant: created.tenant,
      branch: created.branch,
      tokens,
    };
  }

  async login(email: string, password: string): Promise<LoginResult> {
    const user = await this.db.findUserByEmail(email);
    // Generic failure either way: no user enumeration.
    if (!user || !(await this.hasher.verify(user.passwordHash, password))) {
      throw new InvalidCredentialsError();
    }
    const memberships = await this.db.listMembershipDetails(user.id);
    if (memberships.length === 0) throw new InvalidCredentialsError();
    const publicUser = { id: user.id, email: user.email, name: user.name };
    if (memberships.length === 1) {
      const tenantId = memberships[0].tenantId;
      const tokens = await this.issueTokens(user.id, user.email, tenantId);
      return { user: publicUser, tenantId, tokens };
    }
    // Several tenants: issue an unscoped access token and let the
    // client pick a tenant via POST /auth/select-tenant. No refresh
    // token is issued until a tenant is selected.
    const accessToken = await this.signAccess(user.id, user.email, null);
    return {
      user: publicUser,
      tenantId: null,
      tokens: { accessToken, refreshToken: '' },
      requiresTenantSelection: true,
      tenants: memberships.map((m) => ({
        tenantId: m.tenantId,
        role: m.role,
        name: m.tenantName,
      })),
    };
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const expiresAt = new Date(Date.now() + this.options.refreshTtlDays * 24 * 60 * 60 * 1000);
    let rotated;
    try {
      rotated = await rotateRefreshToken(
        this.sessions,
        refreshToken,
        new Date(),
        expiresAt,
        async (session) => {
          await this.db.createAuditLog({
            tenantId: session.tenantId,
            actorId: session.userId,
            action: 'auth.refresh.reuse_detected',
            entity: 'refresh_session',
            entityId: session.id,
            after: { familyId: session.familyId },
          });
        },
      );
    } catch (e) {
      if (e instanceof RefreshTokenReuseError) {
        throw new RefreshReuseDetectedError();
      }
      throw e;
    }
    const session = rotated.session;
    const memberships = await this.db.listMemberships(session.userId);
    if (!memberships.some((m) => m.tenantId === session.tenantId)) {
      await this.sessions.revokeFamily(session.userId, session.familyId);
      throw new InvalidCredentialsError();
    }
    const email = await this.emailForUser(session.userId);
    const accessToken = await this.signAccess(session.userId, email, session.tenantId);
    return { accessToken, refreshToken: rotated.refreshToken };
  }

  protected async emailForUser(userId: string): Promise<string> {
    const user = await this.db.findUserById(userId);
    if (!user) throw new InvalidCredentialsError();
    return user.email;
  }

  async selectTenant(
    userId: string,
    tenantId: string,
  ): Promise<{ tokens: TokenPair; tenantContext: TenantContext }> {
    const memberships = await this.db.listMembershipDetails(userId);
    const membership = memberships.find((m) => m.tenantId === tenantId);
    if (!membership) throw new TenantNotMemberError();
    const user = await this.db.findUserById(userId);
    if (!user) throw new InvalidCredentialsError();
    const tokens = await this.issueTokens(userId, user.email, tenantId);
    const tenantContext = resolveTenantContext(
      {
        id: userId,
        memberships: memberships.map((m) => ({
          tenantId: m.tenantId,
          branchIds: m.branchIds,
          role: m.role,
          permissions: permissionsForRole(m.role),
          entitlements: [],
        })),
      },
      tenantId,
    );
    tenantContext.tenantName = membership.tenantName;
    return { tokens, tenantContext };
  }

  async logout(refreshToken: string): Promise<void> {
    if (!refreshToken) return;
    const session = await this.sessions.findByTokenHash(hashRefreshToken(refreshToken));
    if (!session) return;
    await this.sessions.revokeFamily(session.userId, session.familyId);
  }

  async logoutAll(userId: string): Promise<void> {
    await this.sessions.revokeAllForUser(userId);
  }

  async me(
    userId: string,
    selectedTenantId: string | null = null,
  ): Promise<{
    user: { id: string; email: string; name: string | null };
    memberships: Array<{
      tenantId: string;
      branchIds: string[];
      role: string;
      permissions: string[];
      tenantName: string | null;
      branches: Array<{ id: string; name: string }>;
    }>;
    tenantContext: TenantContext | null;
  }> {
    const user = await this.db.findUserById(userId);
    if (!user) throw new InvalidCredentialsError();
    const memberships = await this.db.listMembershipDetails(userId);
    const enriched = memberships.map((m) => ({
      tenantId: m.tenantId,
      branchIds: m.branchIds,
      role: m.role,
      permissions: permissionsForRole(m.role),
      tenantName: m.tenantName,
      branches: m.branches,
    }));
    const selected = enriched.find((m) => m.tenantId === selectedTenantId);
    const tenantContext =
      selectedTenantId !== null && selected
        ? {
            ...resolveTenantContext(
              {
                id: userId,
                memberships: enriched.map((m) => ({ ...m, entitlements: [] })),
              },
              selectedTenantId,
            ),
            tenantName: selected.tenantName,
          }
        : null;
    return {
      user: { id: user.id, email: user.email, name: user.name },
      memberships: enriched,
      tenantContext,
    };
  }
}
