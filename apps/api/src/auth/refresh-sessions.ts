import { createHash, randomBytes } from 'node:crypto';
import type { RefreshSessionRecord, RefreshSessionStore } from './ports';

/** A refresh token is a random 32-byte value, hex-encoded. Only its sha256 hash is stored. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newFamilyId(): string {
  return randomBytes(16).toString('hex');
}

export class RefreshTokenReuseError extends Error {
  constructor() {
    super('Refresh token reuse detected.');
  }
}

export class InvalidRefreshTokenError extends Error {
  constructor() {
    super('Invalid or expired refresh token.');
  }
}

export interface RotatedTokens {
  session: RefreshSessionRecord;
  /** The new refresh token (plaintext, returned to the client exactly once). */
  refreshToken: string;
}

/**
 * Pure refresh rotation over a RefreshSessionStore. Unit-tested with an
 * in-memory store (refresh-sessions.spec.ts) — no database needed.
 *
 * Rules:
 * - Unknown hash, expired session, or missing session: generic failure.
 * - Presenting a session that was already revoked/replaced is REUSE:
 *   the whole family is revoked (all sessions for that user+family),
 *   the caller gets a generic 401, and the service writes an audit log.
 * - Otherwise: revoke the old session (linked to the new one), create
 *   a new session in the SAME family, return it with a new token.
 */
export async function rotateRefreshToken(
  store: RefreshSessionStore,
  refreshToken: string,
  now: Date,
  expiresAt: Date,
  onReuse?: (session: RefreshSessionRecord) => Promise<void>,
): Promise<RotatedTokens> {
  const tokenHash = hashRefreshToken(refreshToken);
  const session = await store.findByTokenHash(tokenHash);
  if (!session) throw new InvalidRefreshTokenError();
  if (session.revokedAt !== null || session.replacedById !== null) {
    // Reuse: a revoked/replaced token was presented again. Assume the
    // token was stolen; kill the whole family.
    await store.revokeFamily(session.userId, session.familyId);
    if (onReuse) await onReuse(session);
    throw new RefreshTokenReuseError();
  }
  if (session.expiresAt <= now) throw new InvalidRefreshTokenError();

  const newToken = generateRefreshToken();
  const result = await store.rotateAtomic(session, hashRefreshToken(newToken), now, expiresAt);
  if (result.status === 'reuse') {
    if (onReuse) await onReuse(session);
    throw new RefreshTokenReuseError();
  }
  if (result.status !== 'ok') throw new InvalidRefreshTokenError();
  const created = result.session;
  return { session: created, refreshToken: newToken };
}
