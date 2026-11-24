import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  ApiError,
  adjustStock,
  clearTenantCaches,
  listRepairParts,
  UnauthorizedError,
  fetchMe,
  getAccessToken,
  login,
  setAccessToken,
} from './client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('api client — memory-only tokens', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    setAccessToken(null);
    clearTenantCaches();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  it('normalizes the actual array repair-parts response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, [{ id: 'line1' }]));
    expect(await listRepairParts('repair1')).toEqual({
      items: [{ id: 'line1' }],
      nextCursor: null,
    });
  });

  it('reuses a stock operation key after uncertain network failure', async () => {
    const input = { branchId: 'b', partId: 'p', delta: 10, idempotencyKey: 'first-key' };
    fetchMock.mockRejectedValueOnce(new TypeError('network'));
    await expect(adjustStock(input)).rejects.toThrow('network');
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { qtyOnHand: 10 }));
    await adjustStock({ ...input, idempotencyKey: 'second-key' });
    const first = JSON.parse(fetchMock.mock.calls[0][1].body);
    const retry = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(first.idempotencyKey).toBe('first-key');
    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
  });

  it('login stores the access token in memory only, never in localStorage', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        user: { id: 'u1', email: 'a@example.test', name: null },
        tenantId: 't1',
        tokens: { accessToken: 'access-123', refreshToken: 'ignored' },
      }),
    );
    await login('a@example.test', 'twelve-chars-min');
    expect(getAccessToken()).toBe('access-123');
    expect(window.localStorage.getItem('accessToken')).toBeNull();
    expect(window.localStorage.getItem('access_token')).toBeNull();
    expect(setItemSpy).not.toHaveBeenCalledWith(expect.stringMatching(/token/i), expect.anything());
    setItemSpy.mockRestore();
  });

  it('sends the Authorization header and credentials:include on authenticated calls', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        user: { id: 'u1', email: 'a@example.test', name: null },
        tenantId: 't1',
        tokens: { accessToken: 'access-123', refreshToken: '' },
      }),
    );
    await login('a@example.test', 'twelve-chars-min');
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        user: { id: 'u1', email: 'a@example.test', name: null },
        memberships: [],
        tenantContext: null,
      }),
    );
    await fetchMe();
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-123');
  });

  it('on 401 refreshes exactly once, then retries the request', async () => {
    setAccessToken('stale-token');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { statusCode: 401, message: 'Unauthorized' }))
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'fresh-token', refreshToken: '' }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          user: { id: 'u1', email: 'a@example.test', name: null },
          memberships: [],
          tenantContext: null,
        }),
      );
    const me = await fetchMe();
    expect(me.user.id).toBe('u1');
    expect(getAccessToken()).toBe('fresh-token');
    const refreshCalls = fetchMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.includes('/auth/refresh'),
    );
    expect(refreshCalls).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never retries a write under a different account after cookie refresh', async () => {
    const jwt = (sub: string, tenantId: string) =>
      'header.' + btoa(JSON.stringify({ sub, tenantId })) + '.signature';
    setAccessToken(jwt('user-a', 'tenant-a'));
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, {}))
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: jwt('user-b', 'tenant-b') }));
    await expect(
      adjustStock({ branchId: 'b', partId: 'p', delta: 1, idempotencyKey: 'scope-change-key' }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getAccessToken()).toBeNull();
  });

  it('a failed refresh clears the token and throws UnauthorizedError', async () => {
    setAccessToken('stale-token');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { statusCode: 401, message: 'Unauthorized' }))
      .mockResolvedValueOnce(jsonResponse(401, { statusCode: 401, message: 'Unauthorized' }));
    await expect(fetchMe()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(getAccessToken()).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });

  it('surfaces server error messages (string and array forms)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { statusCode: 400, message: ['bad email', 'short password'] }),
    );
    const err = await login('bad', 'short').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).message).toBe('bad email; short password');
  });
});
