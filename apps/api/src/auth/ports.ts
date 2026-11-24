/**
 * Auth ports (interfaces). AuthService depends only on these — never on
 * Prisma or the generated client — so its unit tests run without a
 * database or a generated Prisma client. The Prisma implementations
 * live in prisma-auth.db.ts, which unit tests never import.
 */

export const AUTH_DB = Symbol('AUTH_DB');
export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');
export const REFRESH_SESSION_STORE = Symbol('REFRESH_SESSION_STORE');
export const AUTH_OPTIONS = Symbol('AUTH_OPTIONS');

export interface AuthOptions {
  /** Access JWT lifetime in seconds (default 900 = 15 minutes). */
  accessTtlSeconds: number;
  /** Refresh session lifetime in days (default 7). */
  refreshTtlDays: number;
}

export interface MembershipInfo {
  tenantId: string;
  branchIds: string[];
  role: string;
}

/** Membership plus the display names the UI needs (tenant + branch names). */
export interface MembershipDetail extends MembershipInfo {
  tenantName: string | null;
  branches: Array<{ id: string; name: string }>;
}

export interface UserRecord {
  id: string;
  email: string;
  name: string | null;
  passwordHash: string;
}

export interface RegisteredOwner {
  user: UserRecord;
  tenant: { id: string; name: string };
  branch: { id: string; name: string };
}

export interface AuthDb {
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(userId: string): Promise<UserRecord | null>;
  /** Creates user + tenant + initial branch + owner membership + audit in ONE transaction. */
  registerOwner(input: {
    email: string;
    passwordHash: string;
    name?: string;
    tenantName: string;
    branchName: string;
  }): Promise<RegisteredOwner>;
  listMemberships(userId: string): Promise<MembershipInfo[]>;
  /**
   * Same memberships plus tenant/branch display names for /me and the
   * tenant picker. Kept separate from listMemberships so the guard's
   * per-request check stays lean (no name lookups on every request).
   */
  listMembershipDetails(userId: string): Promise<MembershipDetail[]>;
  createAuditLog(input: {
    tenantId: string;
    actorId: string;
    action: string;
    entity: string;
    entityId: string;
    after?: unknown;
  }): Promise<void>;
}

export interface RefreshSessionRecord {
  id: string;
  userId: string;
  tenantId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedById: string | null;
  lastUsedAt: Date | null;
}

export interface RefreshSessionStore {
  rotateAtomic(
    session: RefreshSessionRecord,
    tokenHash: string,
    now: Date,
    expiresAt: Date,
  ): Promise<{ status: 'ok'; session: RefreshSessionRecord } | { status: 'reuse' | 'invalid' }>;
  create(input: {
    userId: string;
    tenantId: string;
    tokenHash: string;
    familyId: string;
    expiresAt: Date;
  }): Promise<RefreshSessionRecord>;
  findByTokenHash(tokenHash: string): Promise<RefreshSessionRecord | null>;
  /** Revokes one session; also stamps lastUsedAt = now. */
  revoke(id: string, replacedById?: string | null): Promise<void>;
  /** Revokes every live session in a family (reuse detection). */
  revokeFamily(userId: string, familyId: string): Promise<void>;
  revokeAllForUser(userId: string): Promise<void>;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}
