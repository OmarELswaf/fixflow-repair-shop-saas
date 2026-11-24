import type { RefreshSessionRecord, RefreshSessionStore } from './ports';

/**
 * In-memory RefreshSessionStore — test helper only, never used in
 * production. Lives in its own file (not a *.spec.ts) so other spec
 * files can import it without re-registering tests.
 */
export class InMemoryRefreshSessionStore implements RefreshSessionStore {
  readonly sessions = new Map<string, RefreshSessionRecord>();
  private seq = 0;

  async rotateAtomic(
    session: RefreshSessionRecord,
    tokenHash: string,
    now: Date,
    expiresAt: Date,
  ): Promise<{ status: 'ok'; session: RefreshSessionRecord } | { status: 'reuse' | 'invalid' }> {
    const current = this.sessions.get(session.id);
    if (!current || current.expiresAt <= now) return { status: 'invalid' };
    if (current.revokedAt || current.replacedById) {
      await this.revokeFamily(current.userId, current.familyId);
      return { status: 'reuse' };
    }
    current.revokedAt = now;
    const created = await this.create({
      userId: current.userId,
      tenantId: current.tenantId,
      familyId: current.familyId,
      tokenHash,
      expiresAt,
    });
    current.replacedById = created.id;
    return { status: 'ok', session: created };
  }

  async create(input: {
    userId: string;
    tenantId: string;
    tokenHash: string;
    familyId: string;
    expiresAt: Date;
  }): Promise<RefreshSessionRecord> {
    const record: RefreshSessionRecord = {
      id: `session-${++this.seq}`,
      ...input,
      revokedAt: null,
      replacedById: null,
      lastUsedAt: null,
    };
    this.sessions.set(record.id, record);
    return record;
  }

  async findByTokenHash(tokenHash: string): Promise<RefreshSessionRecord | null> {
    for (const s of this.sessions.values()) {
      if (s.tokenHash === tokenHash) return s;
    }
    return null;
  }

  async revoke(id: string, replacedById: string | null = null): Promise<void> {
    const s = this.sessions.get(id);
    if (s) {
      s.revokedAt = new Date();
      s.replacedById = replacedById;
      s.lastUsedAt = new Date();
    }
  }

  async revokeFamily(userId: string, familyId: string): Promise<void> {
    for (const s of this.sessions.values()) {
      if (s.userId === userId && s.familyId === familyId && s.revokedAt === null) {
        s.revokedAt = new Date();
      }
    }
  }

  async revokeAllForUser(userId: string): Promise<void> {
    for (const s of this.sessions.values()) {
      if (s.userId === userId && s.revokedAt === null) s.revokedAt = new Date();
    }
  }
}
