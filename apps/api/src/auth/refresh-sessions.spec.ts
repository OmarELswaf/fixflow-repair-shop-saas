import {
  generateRefreshToken,
  hashRefreshToken,
  newFamilyId,
  rotateRefreshToken,
  InvalidRefreshTokenError,
  RefreshTokenReuseError,
} from './refresh-sessions';
import { InMemoryRefreshSessionStore } from './in-memory-store';

const NOW = new Date('2026-11-24T06:00:00.000Z');
const EXPIRY = new Date('2026-12-01T06:00:00.000Z');

describe('rotateRefreshToken', () => {
  it('rotates: old token revoked, new token in the same family', async () => {
    const store = new InMemoryRefreshSessionStore();
    const token = generateRefreshToken();
    const first = await store.create({
      userId: 'user-1',
      tenantId: 'tenant-1',
      tokenHash: hashRefreshToken(token),
      familyId: newFamilyId(),
      expiresAt: EXPIRY,
    });
    const rotated = await rotateRefreshToken(store, token, NOW, EXPIRY);
    expect(rotated.refreshToken).not.toBe(token);
    expect(rotated.session.familyId).toBe(first.familyId);
    const old = await store.findByTokenHash(hashRefreshToken(token));
    expect(old?.revokedAt).not.toBeNull();
    expect(old?.replacedById).toBe(rotated.session.id);
    // The new token works.
    const again = await rotateRefreshToken(store, rotated.refreshToken, NOW, EXPIRY);
    expect(again.session.familyId).toBe(first.familyId);
  });

  it('reuse detection: presenting an already-rotated token revokes the whole family', async () => {
    const store = new InMemoryRefreshSessionStore();
    const token = generateRefreshToken();
    await store.create({
      userId: 'user-1',
      tenantId: 'tenant-1',
      tokenHash: hashRefreshToken(token),
      familyId: 'family-1',
      expiresAt: EXPIRY,
    });
    const rotated = await rotateRefreshToken(store, token, NOW, EXPIRY);
    // Attacker replays the ORIGINAL token.
    await expect(rotateRefreshToken(store, token, NOW, EXPIRY)).rejects.toBeInstanceOf(
      RefreshTokenReuseError,
    );
    // The family is dead: even the legitimate new token no longer works.
    await expect(
      rotateRefreshToken(store, rotated.refreshToken, NOW, EXPIRY),
    ).rejects.toBeInstanceOf(RefreshTokenReuseError);
    for (const s of store.sessions.values()) {
      expect(s.revokedAt).not.toBeNull();
    }
  });

  it('rejects unknown tokens and expired sessions', async () => {
    const store = new InMemoryRefreshSessionStore();
    await expect(
      rotateRefreshToken(store, generateRefreshToken(), NOW, EXPIRY),
    ).rejects.toBeInstanceOf(InvalidRefreshTokenError);
    const token = generateRefreshToken();
    await store.create({
      userId: 'user-1',
      tenantId: 'tenant-1',
      tokenHash: hashRefreshToken(token),
      familyId: 'family-1',
      expiresAt: new Date('2026-11-24T05:00:00.000Z'),
    });
    await expect(rotateRefreshToken(store, token, NOW, EXPIRY)).rejects.toBeInstanceOf(
      InvalidRefreshTokenError,
    );
  });
});

describe('concurrent refresh regression', () => {
  it('permits at most one rotation and invalidates family on racing reuse', async () => {
    const store = new InMemoryRefreshSessionStore();
    const token = generateRefreshToken();
    await store.create({
      userId: 'u',
      tenantId: 't',
      tokenHash: hashRefreshToken(token),
      familyId: 'f',
      expiresAt: EXPIRY,
    });
    const results = await Promise.allSettled([
      rotateRefreshToken(store, token, NOW, EXPIRY),
      rotateRefreshToken(store, token, NOW, EXPIRY),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    for (const row of store.sessions.values()) expect(row.revokedAt).not.toBeNull();
  });
});
