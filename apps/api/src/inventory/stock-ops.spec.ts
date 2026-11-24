// NestJS 12 ships ESM that ts-jest/CJS cannot require. Mock the
// Nest module this spec touches; stock-ops throws the real exception
// classes in production, the HTTP harness covers the live mapping.
jest.mock('@nestjs/common', () => {
  class FakeHttpException extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  class UnprocessableEntityException extends FakeHttpException {
    constructor(message = 'Unprocessable Entity') {
      super(message, 422);
    }
  }
  class ConflictException extends FakeHttpException {
    constructor(message = 'Conflict') {
      super(message, 409);
    }
  }
  return { UnprocessableEntityException, ConflictException };
});

import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import type { TenantContext } from '../tenancy/tenant-context';
import { consumeStock, releaseStock, reserveStock } from './inventory';
import {
  applyStockChange,
  availableQty,
  claimIdempotency,
  findIdempotency,
  idempotencyResponse,
  isCheckViolation,
  isUniqueViolation,
  isValidIdempotencyKey,
  matchesIdempotencyRequest,
  recordMovement,
  releaseReservedParts,
  type IdempotencyRow,
  type RepairPartRow,
  type StockRow,
  type StockTx,
} from './stock-ops';
import { AdjustStockDto, ReleaseConsumePartDto, ReservePartDto } from './dto';

const CTX: TenantContext = {
  userId: 'u1',
  tenantId: 't1',
  branchIds: ['b1'],
  role: 'owner',
  permissions: [],
  entitlements: [],
};

function stockKey(tenantId: string, branchId: string, partId: string): string {
  return `${tenantId}:${branchId}:${partId}`;
}

/** In-memory StockTx: guards and increments behave like the real conditional writes. */
function makeFakeTx(initialStocks: StockRow[] = []) {
  const stocks = new Map<string, StockRow>(
    initialStocks.map((s) => [stockKey(s.tenantId, s.branchId, s.partId), { ...s }]),
  );
  const movements: Array<Record<string, unknown>> = [];
  const lines: RepairPartRow[] = [];
  const keys: IdempotencyRow[] = [];
  const fake = {
    stocks,
    movements,
    lines,
    keys,
    failNextUpdate: false,
    throwCheckOnce: false,
  };
  const whereOf = (args: Record<string, unknown>): Record<string, unknown> =>
    (args.where as Record<string, unknown>) ?? {};
  const tx = {
    branchStock: {
      findFirst: async (args: Record<string, unknown>) => {
        const w = whereOf(args);
        return (
          stocks.get(stockKey(String(w.tenantId), String(w.branchId), String(w.partId))) ?? null
        );
      },
      updateMany: async (args: Record<string, unknown>) => {
        if (fake.throwCheckOnce) {
          fake.throwCheckOnce = false;
          throw { code: 'P2004' };
        }
        if (fake.failNextUpdate) {
          fake.failNextUpdate = false;
          return { count: 0 };
        }
        const w = whereOf(args);
        const row = stocks.get(stockKey(String(w.tenantId), String(w.branchId), String(w.partId)));
        if (!row) return { count: 0 };
        if (typeof w.qtyOnHand === 'number' && row.qtyOnHand !== w.qtyOnHand) return { count: 0 };
        if (typeof w.reservedQty === 'number' && row.reservedQty !== w.reservedQty)
          return { count: 0 };
        const qtyGuard = w.qtyOnHand as { gte?: number } | undefined;
        const resGuard = w.reservedQty as { gte?: number } | undefined;
        if (qtyGuard?.gte !== undefined && row.qtyOnHand < qtyGuard.gte) return { count: 0 };
        if (resGuard?.gte !== undefined && row.reservedQty < resGuard.gte) return { count: 0 };
        const data = args.data as {
          qtyOnHand?: { increment?: number };
          reservedQty?: { increment?: number };
        };
        row.qtyOnHand += data.qtyOnHand?.increment ?? 0;
        row.reservedQty += data.reservedQty?.increment ?? 0;
        return { count: 1 };
      },
      upsert: async (args: Record<string, unknown>) => {
        const w = args.where as { tenantId_branchId_partId: StockRow };
        const key = w.tenantId_branchId_partId;
        const existing = stocks.get(stockKey(key.tenantId, key.branchId, key.partId));
        if (existing) return existing;
        const row = { ...key, qtyOnHand: 0, reservedQty: 0 };
        stocks.set(stockKey(row.tenantId, row.branchId, row.partId), row);
        return row;
      },
    },
    stockMovement: {
      create: async (args: Record<string, unknown>) => {
        movements.push({ ...(args.data as Record<string, unknown>) });
        return {};
      },
    },
    repairPart: {
      findMany: async (args: Record<string, unknown>) => {
        const w = whereOf(args);
        return lines.filter(
          (l) =>
            (!w.tenantId || l.tenantId === w.tenantId) &&
            (!w.orderId || l.orderId === w.orderId) &&
            (!w.partId || l.partId === w.partId) &&
            (!w.status || l.status === w.status),
        );
      },
      findFirst: async (args: Record<string, unknown>) => {
        const w = whereOf(args);
        return (
          lines.find(
            (l) =>
              (!w.id || l.id === w.id) &&
              (!w.tenantId || l.tenantId === w.tenantId) &&
              (!w.orderId || l.orderId === w.orderId) &&
              (!w.partId || l.partId === w.partId) &&
              (!w.status || l.status === w.status),
          ) ?? null
        );
      },
      create: async (args: Record<string, unknown>) => {
        const data = args.data as Omit<RepairPartRow, 'createdAt'>;
        const clash = lines.some(
          (l) =>
            l.tenantId === data.tenantId &&
            l.orderId === data.orderId &&
            l.partId === data.partId &&
            l.status === 'reserved',
        );
        if (clash) throw { code: 'P2002' };
        const row: RepairPartRow = { ...data, createdAt: new Date() };
        lines.push(row);
        return row;
      },
      updateMany: async (args: Record<string, unknown>) => {
        if (fake.failNextUpdate) {
          fake.failNextUpdate = false;
          return { count: 0 };
        }
        const w = whereOf(args);
        const data = args.data as { status?: string; qty?: { increment?: number } };
        const row = lines.find(
          (l) =>
            (!w.id || l.id === w.id) &&
            (!w.tenantId || l.tenantId === w.tenantId) &&
            (!w.status || l.status === w.status),
        );
        if (!row) return { count: 0 };
        if (data.status) row.status = data.status;
        if (data.qty?.increment) row.qty += data.qty.increment;
        return { count: 1 };
      },
    },
    stockIdempotency: {
      findFirst: async (args: Record<string, unknown>) => {
        const w = whereOf(args);
        return (
          keys.find((k) => k.tenantId === w.tenantId && k.scope === w.scope && k.key === w.key) ??
          null
        );
      },
      create: async (args: Record<string, unknown>) => {
        const data = args.data as Omit<IdempotencyRow, 'createdAt'>;
        if (
          keys.some(
            (k) => k.tenantId === data.tenantId && k.scope === data.scope && k.key === data.key,
          )
        ) {
          throw { code: 'P2002' };
        }
        const row: IdempotencyRow = { ...data, createdAt: new Date() } as IdempotencyRow;
        keys.push(row);
        return row;
      },
    },
  };
  return { fake, tx: tx as unknown as StockTx };
}

describe('availableQty and pure guard helpers', () => {
  it('available is on hand minus reserved', () => {
    expect(availableQty({ qtyOnHand: 10, reservedQty: 3 })).toBe(7);
    expect(availableQty({ qtyOnHand: 5, reservedQty: 5 })).toBe(0);
  });

  it('reserve beyond available fails; consume/release beyond reserved fail', () => {
    expect(() => reserveStock({ qtyOnHand: 10, reservedQty: 8 }, 3)).toThrow(
      'Cannot reserve more than on hand.',
    );
    expect(() => consumeStock({ qtyOnHand: 10, reservedQty: 1 }, 2)).toThrow(
      'Cannot consume more than reserved.',
    );
    expect(() => consumeStock({ qtyOnHand: 1, reservedQty: 5 }, 2)).toThrow(
      'Insufficient stock on hand.',
    );
    expect(() => releaseStock({ qtyOnHand: 10, reservedQty: 1 }, 2)).toThrow(
      'Cannot release more than reserved.',
    );
  });

  it('reserve raises reserved only, consume drops both once, release drops reserved only', () => {
    expect(reserveStock({ qtyOnHand: 10, reservedQty: 0 }, 3)).toEqual({
      qtyOnHand: 10,
      reservedQty: 3,
    });
    expect(consumeStock({ qtyOnHand: 10, reservedQty: 3 }, 3)).toEqual({
      qtyOnHand: 7,
      reservedQty: 0,
    });
    expect(releaseStock({ qtyOnHand: 10, reservedQty: 3 }, 2)).toEqual({
      qtyOnHand: 10,
      reservedQty: 1,
    });
  });
});

describe('applyStockChange (conditional writes)', () => {
  it('reserve raises reservedQty only, qtyOnHand unchanged', async () => {
    const { tx } = makeFakeTx([
      { tenantId: 't1', branchId: 'b1', partId: 'p1', qtyOnHand: 10, reservedQty: 2 },
    ]);
    const after = await applyStockChange(tx, 't1', 'b1', 'p1', {
      reservedDelta: 3,
      onHandDelta: 0,
    });
    expect(after).toEqual({
      tenantId: 't1',
      branchId: 'b1',
      partId: 'p1',
      qtyOnHand: 10,
      reservedQty: 5,
    });
  });

  it('consume decrements both exactly once', async () => {
    const { tx } = makeFakeTx([
      { tenantId: 't1', branchId: 'b1', partId: 'p1', qtyOnHand: 10, reservedQty: 5 },
    ]);
    const after = await applyStockChange(tx, 't1', 'b1', 'p1', {
      reservedDelta: -3,
      onHandDelta: -3,
    });
    expect(after.qtyOnHand).toBe(7);
    expect(after.reservedQty).toBe(2);
  });

  it('release decrements reserved only', async () => {
    const { tx } = makeFakeTx([
      { tenantId: 't1', branchId: 'b1', partId: 'p1', qtyOnHand: 10, reservedQty: 5 },
    ]);
    const after = await applyStockChange(tx, 't1', 'b1', 'p1', {
      reservedDelta: -2,
      onHandDelta: 0,
    });
    expect(after).toMatchObject({ qtyOnHand: 10, reservedQty: 3 });
  });

  it('reserve beyond available is a 422 and leaves the row untouched', async () => {
    const { fake, tx } = makeFakeTx([
      { tenantId: 't1', branchId: 'b1', partId: 'p1', qtyOnHand: 10, reservedQty: 8 },
    ]);
    await expect(
      applyStockChange(tx, 't1', 'b1', 'p1', { reservedDelta: 3, onHandDelta: 0 }),
    ).rejects.toThrow('Insufficient stock.');
    expect(fake.stocks.get('t1:b1:p1')).toMatchObject({ qtyOnHand: 10, reservedQty: 8 });
  });

  it('consume or release beyond reserved is a 422', async () => {
    const { tx } = makeFakeTx([
      { tenantId: 't1', branchId: 'b1', partId: 'p1', qtyOnHand: 10, reservedQty: 1 },
    ]);
    await expect(
      applyStockChange(tx, 't1', 'b1', 'p1', { reservedDelta: -2, onHandDelta: -2 }),
    ).rejects.toThrow('Insufficient stock.');
    await expect(
      applyStockChange(tx, 't1', 'b1', 'p1', { reservedDelta: -2, onHandDelta: 0 }),
    ).rejects.toThrow('Insufficient stock.');
  });

  it('adjust below zero or below reserved is a 422; adjust within bounds works', async () => {
    const { tx } = makeFakeTx([
      { tenantId: 't1', branchId: 'b1', partId: 'p1', qtyOnHand: 5, reservedQty: 5 },
    ]);
    await expect(
      applyStockChange(tx, 't1', 'b1', 'p1', { reservedDelta: 0, onHandDelta: -1 }),
    ).rejects.toThrow('Insufficient stock.');
    const after = await applyStockChange(tx, 't1', 'b1', 'p1', {
      reservedDelta: 0,
      onHandDelta: 4,
    });
    expect(after).toMatchObject({ qtyOnHand: 9, reservedQty: 5 });
  });

  it('missing stock row is a 422, not a 404', async () => {
    const { tx } = makeFakeTx([]);
    await expect(
      applyStockChange(tx, 't1', 'b1', 'p1', { reservedDelta: 1, onHandDelta: 0 }),
    ).rejects.toThrow('Stock row not found at this branch.');
  });

  it('a lost conditional update (count 0) is a 422', async () => {
    const { fake, tx } = makeFakeTx([
      { tenantId: 't1', branchId: 'b1', partId: 'p1', qtyOnHand: 10, reservedQty: 0 },
    ]);
    fake.failNextUpdate = true;
    await expect(
      applyStockChange(tx, 't1', 'b1', 'p1', { reservedDelta: 1, onHandDelta: 0 }),
    ).rejects.toThrow('Insufficient stock.');
  });

  it('a CHECK violation from a racing reservation is still a 422', async () => {
    const { fake, tx } = makeFakeTx([
      { tenantId: 't1', branchId: 'b1', partId: 'p1', qtyOnHand: 10, reservedQty: 0 },
    ]);
    fake.throwCheckOnce = true;
    await expect(
      applyStockChange(tx, 't1', 'b1', 'p1', { reservedDelta: 1, onHandDelta: 0 }),
    ).rejects.toThrow('Insufficient stock.');
  });

  it('throws the Nest 422 type, not a plain Error', async () => {
    const { tx } = makeFakeTx([
      { tenantId: 't1', branchId: 'b1', partId: 'p1', qtyOnHand: 1, reservedQty: 1 },
    ]);
    let caught: unknown;
    try {
      await applyStockChange(tx, 't1', 'b1', 'p1', { reservedDelta: 2, onHandDelta: 0 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnprocessableEntityException);
    expect((caught as { status?: number }).status).toBe(422);
  });
});

describe('recordMovement', () => {
  it('appends signed quantities with the reason', async () => {
    const { fake, tx } = makeFakeTx([]);
    await recordMovement(tx, 't1', 'b1', 'p1', 3, 'reserve');
    await recordMovement(tx, 't1', 'b1', 'p1', -3, 'consume');
    expect(fake.movements).toEqual([
      {
        tenantId: 't1',
        branchId: 'b1',
        partId: 'p1',
        qty: 3,
        reason: 'reserve',
        repairOrderId: null,
        repairPartId: null,
        operationKey: null,
        actorId: null,
      },
      {
        tenantId: 't1',
        branchId: 'b1',
        partId: 'p1',
        qty: -3,
        reason: 'consume',
        repairOrderId: null,
        repairPartId: null,
        operationKey: null,
        actorId: null,
      },
    ]);
  });
});

describe('releaseReservedParts', () => {
  it('releases every reserved line, restores stock, and returns the ids', async () => {
    const { fake, tx } = makeFakeTx([
      { tenantId: 't1', branchId: 'b1', partId: 'p1', qtyOnHand: 10, reservedQty: 3 },
    ]);
    fake.lines.push(
      {
        id: 'l1',
        tenantId: 't1',
        orderId: 'o1',
        partId: 'p1',
        branchId: 'b1',
        qty: 2,
        status: 'reserved',
        createdAt: new Date(),
      },
      {
        id: 'l2',
        tenantId: 't1',
        orderId: 'o1',
        partId: 'p1',
        branchId: 'b1',
        qty: 1,
        status: 'reserved',
        createdAt: new Date(),
      },
      {
        id: 'l3',
        tenantId: 't1',
        orderId: 'o1',
        partId: 'p1',
        branchId: 'b1',
        qty: 5,
        status: 'released',
        createdAt: new Date(),
      },
    );
    const released = await releaseReservedParts(tx, CTX, 'o1');
    expect(released).toEqual(['l1', 'l2']);
    expect(fake.stocks.get('t1:b1:p1')).toMatchObject({ qtyOnHand: 10, reservedQty: 0 });
    expect(fake.movements.map((m) => [m.qty, m.reason])).toEqual([
      [-2, 'release'],
      [-1, 'release'],
    ]);
    expect(fake.lines.find((l) => l.id === 'l3')?.status).toBe('released');
  });

  it('returns an empty list when nothing is reserved', async () => {
    const { fake, tx } = makeFakeTx([]);
    expect(await releaseReservedParts(tx, CTX, 'o-none')).toEqual([]);
    expect(fake.movements).toEqual([]);
  });

  it('a lost stock update inside release is a 422', async () => {
    const { fake, tx } = makeFakeTx([
      { tenantId: 't1', branchId: 'b1', partId: 'p1', qtyOnHand: 10, reservedQty: 2 },
    ]);
    fake.lines.push({
      id: 'l1',
      tenantId: 't1',
      orderId: 'o1',
      partId: 'p1',
      branchId: 'b1',
      qty: 2,
      status: 'reserved',
      createdAt: new Date(),
    });
    fake.failNextUpdate = true;
    await expect(releaseReservedParts(tx, CTX, 'o1')).rejects.toThrow('Insufficient stock.');
  });

  it('a lost line update is a 409 Conflict', async () => {
    const { fake, tx } = makeFakeTx([
      { tenantId: 't1', branchId: 'b1', partId: 'p1', qtyOnHand: 10, reservedQty: 2 },
    ]);
    fake.lines.push({
      id: 'l1',
      tenantId: 't1',
      orderId: 'o1',
      partId: 'p1',
      branchId: 'b1',
      qty: 2,
      status: 'reserved',
      createdAt: new Date(),
    });
    // Fail only the repairPart updateMany: the stock write succeeds,
    // then the line flip loses the race.
    tx.repairPart.updateMany = (async () => ({
      count: 0,
    })) as unknown as StockTx['repairPart']['updateMany'];
    await expect(releaseReservedParts(tx, CTX, 'o1')).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('idempotency helpers', () => {
  it('key must be 8..128 characters', () => {
    expect(isValidIdempotencyKey('1234567')).toBe(false);
    expect(isValidIdempotencyKey('12345678')).toBe(true);
    expect(isValidIdempotencyKey('x'.repeat(128))).toBe(true);
    expect(isValidIdempotencyKey('x'.repeat(129))).toBe(false);
    expect(isValidIdempotencyKey(12345678)).toBe(false);
    expect(isValidIdempotencyKey(undefined)).toBe(false);
  });

  it('claim then find round-trips; a duplicate claim is a P2002', async () => {
    const { tx } = makeFakeTx([]);
    await claimIdempotency(tx, 't1', 'repair-part-reserve', 'key-12345678', 'line-1', {
      request: { qty: 2 },
      response: { id: 'line-1' },
    });
    const found = await findIdempotency(tx, 't1', 'repair-part-reserve', 'key-12345678');
    expect(found?.entityId).toBe('line-1');
    expect(await findIdempotency(tx, 't1', 'repair-part-reserve', 'other-key')).toBeNull();
    expect(await findIdempotency(tx, 't1', 'repair-part-release', 'key-12345678')).toBeNull();
    let caught: unknown;
    try {
      await claimIdempotency(tx, 't1', 'repair-part-reserve', 'key-12345678', 'line-2', {});
    } catch (e) {
      caught = e;
    }
    expect(isUniqueViolation(caught)).toBe(true);
    expect(isCheckViolation(caught)).toBe(false);
    expect(isCheckViolation({ code: 'P2004' })).toBe(true);
  });

  it('matchesIdempotencyRequest compares the stored request exactly', () => {
    const stored = { request: { orderId: 'o1', partId: 'p1', qty: 2 }, response: { id: 'l1' } };
    expect(matchesIdempotencyRequest(stored, { orderId: 'o1', partId: 'p1', qty: 2 })).toBe(true);
    expect(matchesIdempotencyRequest(stored, { orderId: 'o1', partId: 'p1', qty: 3 })).toBe(false);
    expect(matchesIdempotencyRequest(stored, { orderId: 'o1', partId: 'p1' })).toBe(false);
    expect(
      matchesIdempotencyRequest(stored, { orderId: 'o1', partId: 'p1', qty: 2, extra: 1 }),
    ).toBe(false);
    expect(matchesIdempotencyRequest(null, { qty: 2 })).toBe(false);
    expect(matchesIdempotencyRequest({ response: {} }, { qty: 2 })).toBe(false);
    expect(idempotencyResponse<{ id: string }>(stored)).toEqual({ id: 'l1' });
    expect(idempotencyResponse(null)).toBeNull();
  });
});

describe('inventory DTOs (zod .strict())', () => {
  it('reserve requires a positive qty and an 8..128 char key', () => {
    expect(
      ReservePartDto.safeParse({ partId: 'p1', qty: 1, idempotencyKey: '12345678' }).success,
    ).toBe(true);
    expect(
      ReservePartDto.safeParse({ partId: 'p1', qty: 0, idempotencyKey: '12345678' }).success,
    ).toBe(false);
    expect(
      ReservePartDto.safeParse({ partId: 'p1', qty: 100001, idempotencyKey: '12345678' }).success,
    ).toBe(false);
    expect(
      ReservePartDto.safeParse({ partId: 'p1', qty: 1, idempotencyKey: 'short' }).success,
    ).toBe(false);
    expect(ReservePartDto.safeParse({ partId: 'p1', qty: 1 }).success).toBe(false);
    expect(
      ReservePartDto.safeParse({ partId: 'p1', qty: 1, idempotencyKey: '12345678', price: 5 })
        .success,
    ).toBe(false);
  });

  it('adjust requires a non-zero bounded delta and a key', () => {
    const base = { branchId: 'b1', partId: 'p1', idempotencyKey: '12345678' };
    expect(AdjustStockDto.safeParse({ ...base, delta: 5 }).success).toBe(true);
    expect(AdjustStockDto.safeParse({ ...base, delta: -5 }).success).toBe(true);
    expect(AdjustStockDto.safeParse({ ...base, delta: 0 }).success).toBe(false);
    expect(AdjustStockDto.safeParse({ ...base, delta: 100001 }).success).toBe(false);
    expect(AdjustStockDto.safeParse({ ...base, delta: 1.5 }).success).toBe(false);
    expect(AdjustStockDto.safeParse({ ...base, delta: 5, idempotencyKey: 'x' }).success).toBe(
      false,
    );
  });

  it('release/consume require only the key', () => {
    expect(ReleaseConsumePartDto.safeParse({ idempotencyKey: '12345678' }).success).toBe(true);
    expect(ReleaseConsumePartDto.safeParse({}).success).toBe(false);
    expect(ReleaseConsumePartDto.safeParse({ idempotencyKey: '12345678', qty: 1 }).success).toBe(
      false,
    );
  });
});
