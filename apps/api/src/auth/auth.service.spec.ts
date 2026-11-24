// NestJS 12 ships ESM that ts-jest/CJS cannot require (same reason the
// Phase 2 app.controller.spec.ts was deleted). Mock the two Nest modules
// this spec touches; the service is tested through its own logic, and
// the real JwtService is exercised by the gated e2e tests.
jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  Inject: () => () => undefined,
}));
jest.mock('@nestjs/jwt', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const jwt = require('jsonwebtoken') as typeof import('jsonwebtoken');
  class FakeJwtService {
    constructor(private readonly opts: { secret: string }) {}
    signAsync(payload: object, options?: { expiresIn?: number }): Promise<string> {
      return Promise.resolve(
        jwt.sign(payload, this.opts.secret, { expiresIn: options?.expiresIn ?? 900 }),
      );
    }
    verifyAsync<T>(token: string): Promise<T> {
      return Promise.resolve(jwt.verify(token, this.opts.secret) as T);
    }
  }
  return { JwtService: FakeJwtService };
});

import { JwtService } from '@nestjs/jwt';
import {
  AuthService,
  DuplicateEmailError,
  InvalidCredentialsError,
  RefreshReuseDetectedError,
  TenantNotMemberError,
} from './auth.service';
import type { AuthDb, MembershipDetail, MembershipInfo, PasswordHasher, UserRecord } from './ports';
import { InMemoryRefreshSessionStore } from './in-memory-store';

class FakeDb implements AuthDb {
  users: UserRecord[] = [];
  memberships: MembershipInfo[] = [];
  audit: Array<Record<string, unknown>> = [];

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    return this.users.find((u) => u.email === email) ?? null;
  }

  async findUserById(userId: string): Promise<UserRecord | null> {
    return this.users.find((u) => u.id === userId) ?? null;
  }

  async registerOwner(input: {
    email: string;
    passwordHash: string;
    name?: string;
    tenantName: string;
    branchName: string;
  }) {
    const user: UserRecord = {
      id: 'user-1',
      email: input.email,
      name: input.name ?? null,
      passwordHash: input.passwordHash,
    };
    this.users.push(user);
    this.memberships.push({ tenantId: 'tenant-1', branchIds: ['branch-1'], role: 'owner' });
    return {
      user,
      tenant: { id: 'tenant-1', name: input.tenantName },
      branch: { id: 'branch-1', name: input.branchName },
    };
  }

  async listMemberships(userId: string): Promise<MembershipInfo[]> {
    void userId;
    return this.memberships;
  }

  async listMembershipDetails(userId: string): Promise<MembershipDetail[]> {
    void userId;
    return this.memberships.map((m) => ({
      ...m,
      tenantName: m.tenantId === 'tenant-1' ? 'Shop' : null,
      branches: m.branchIds.map((id) => ({
        id,
        name: id === 'branch-1' ? 'Main' : id,
      })),
    }));
  }

  async createAuditLog(input: Record<string, unknown>): Promise<void> {
    this.audit.push(input);
  }
}

class FakeHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return `hash:${password}`;
  }
  async verify(hash: string, password: string): Promise<boolean> {
    return hash === `hash:${password}`;
  }
}

describe('AuthService', () => {
  let db: FakeDb;
  let service: AuthService;
  let jwt: JwtService;

  beforeEach(() => {
    db = new FakeDb();
    jwt = new JwtService({ secret: 'test-secret-that-is-long-enough' });
    service = new AuthService(db, new FakeHasher(), new InMemoryRefreshSessionStore(), jwt, {
      accessTtlSeconds: 900,
      refreshTtlDays: 7,
    });
  });

  it('registers an owner and issues tokens scoped to the new tenant', async () => {
    const result = await service.register({
      email: 'owner@example.test',
      password: 'twelve-chars-min',
      tenantName: 'Shop',
      branchName: 'Main',
    });
    expect(result.tenant.id).toBe('tenant-1');
    expect(result.tokens.accessToken.length).toBeGreaterThan(10);
    expect(result.tokens.refreshToken.length).toBeGreaterThan(10);
    const payload = await jwt.verifyAsync(result.tokens.accessToken);
    expect(payload.sub).toBe('user-1');
    expect(payload.tenantId).toBe('tenant-1');
  });

  it('rejects a duplicate email and a short password', async () => {
    await service.register({
      email: 'owner@example.test',
      password: 'twelve-chars-min',
      tenantName: 'Shop',
      branchName: 'Main',
    });
    await expect(
      service.register({
        email: 'owner@example.test',
        password: 'twelve-chars-min',
        tenantName: 'Shop',
        branchName: 'Main',
      }),
    ).rejects.toBeInstanceOf(DuplicateEmailError);
    await expect(
      service.register({
        email: 'other@example.test',
        password: 'short',
        tenantName: 'Shop',
        branchName: 'Main',
      }),
    ).rejects.toThrow('at least 12');
  });

  it('login: wrong password fails generically; correct login issues tokens', async () => {
    await service.register({
      email: 'owner@example.test',
      password: 'twelve-chars-min',
      tenantName: 'Shop',
      branchName: 'Main',
    });
    await expect(service.login('owner@example.test', 'wrong-password')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    await expect(service.login('unknown@example.test', 'twelve-chars-min')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    const result = await service.login('owner@example.test', 'twelve-chars-min');
    expect(result.tenantId).toBe('tenant-1');
    expect(result.tokens).not.toBeNull();
  });

  it('login with several tenants requires selection and issues no refresh token', async () => {
    await service.register({
      email: 'owner@example.test',
      password: 'twelve-chars-min',
      tenantName: 'Shop',
      branchName: 'Main',
    });
    db.memberships.push({ tenantId: 'tenant-2', branchIds: ['branch-2'], role: 'manager' });
    const result = await service.login('owner@example.test', 'twelve-chars-min');
    expect(result.requiresTenantSelection).toBe(true);
    expect(result.tenantId).toBeNull();
    expect(result.tokens?.refreshToken).toBe('');
    expect(result.tenants).toHaveLength(2);
  });

  it('select-tenant rejects a tenant the user is not a member of', async () => {
    await service.register({
      email: 'owner@example.test',
      password: 'twelve-chars-min',
      tenantName: 'Shop',
      branchName: 'Main',
    });
    await expect(service.selectTenant('user-1', 'tenant-other')).rejects.toBeInstanceOf(
      TenantNotMemberError,
    );
    const selected = await service.selectTenant('user-1', 'tenant-1');
    expect(selected.tenantContext.tenantId).toBe('tenant-1');
    expect(selected.tenantContext.role).toBe('owner');
    expect(selected.tenantContext.permissions).toContain('admin');
  });

  it('me returns tenant and branch names for the UI', async () => {
    await service.register({
      email: 'owner@example.test',
      password: 'twelve-chars-min',
      tenantName: 'Shop',
      branchName: 'Main',
    });
    const me = await service.me('user-1', 'tenant-1');
    expect(me.memberships).toHaveLength(1);
    expect(me.memberships[0].tenantName).toBe('Shop');
    expect(me.memberships[0].branches).toEqual([{ id: 'branch-1', name: 'Main' }]);
    expect(me.tenantContext?.tenantName).toBe('Shop');
  });

  it('refresh rotates and logout revokes; replaying a rotated token fails as reuse', async () => {
    const registered = await service.register({
      email: 'owner@example.test',
      password: 'twelve-chars-min',
      tenantName: 'Shop',
      branchName: 'Main',
    });
    const first = await service.refresh(registered.tokens.refreshToken);
    expect(first.refreshToken).not.toBe(registered.tokens.refreshToken);
    // Replaying the original refresh token is reuse: the family dies.
    await expect(service.refresh(registered.tokens.refreshToken)).rejects.toBeInstanceOf(
      RefreshReuseDetectedError,
    );
    // Even the legitimate rotated token is now dead.
    await expect(service.refresh(first.refreshToken)).rejects.toBeInstanceOf(
      RefreshReuseDetectedError,
    );
    // Logout of an unknown token is a silent no-op.
    await service.logout('no-such-token');
    const again = await service.login('owner@example.test', 'twelve-chars-min');
    await service.logout(again.tokens!.refreshToken);
    await expect(service.refresh(again.tokens!.refreshToken)).rejects.toThrow();
  });
});
