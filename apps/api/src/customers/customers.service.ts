import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import { buildCursorPagination } from '../common/pagination';
import type { TenantContext } from '../tenancy/tenant-context';

export interface CustomerListItem {
  id: string;
  name: string;
  phone: string | null;
  createdAt: Date;
}

export interface CustomerDetail extends CustomerListItem {
  devices: Array<{ id: string; brand: string; model: string; serial: string | null }>;
  repairs: Array<{
    id: string;
    status: string;
    branchId: string;
    deviceId: string;
    createdAt: Date;
  }>;
}

function audit(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  action: string,
  entity: string,
  entityId: string,
  after: Record<string, unknown>,
): Promise<unknown> {
  return tx.auditLog.create({
    data: {
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action,
      entity,
      entityId,
      after: after as Prisma.InputJsonValue,
    },
  });
}

/**
 * Customers and device intake. Every write runs inside a tenant-scoped
 * transaction (RLS) and writes an audit entry. No device unlock
 * password is ever accepted or stored — see dto.ts.
 */
@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async createCustomer(
    ctx: TenantContext,
    input: { name: string; phone?: string },
  ): Promise<CustomerListItem> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const customer = await tx.customer.create({
        data: { tenantId: ctx.tenantId, name: input.name, phone: input.phone ?? null },
      });
      await audit(tx, ctx, 'customer.create', 'customer', customer.id, { name: input.name });
      return {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        createdAt: customer.createdAt,
      };
    });
  }

  async listCustomers(
    ctx: TenantContext,
    input: { search?: string; cursor?: string; limit?: number },
  ): Promise<{ items: CustomerListItem[]; nextCursor: string | null }> {
    const page = buildCursorPagination({ cursor: input.cursor, limit: input.limit });
    const where: Prisma.CustomerWhereInput = { tenantId: ctx.tenantId };
    if (input.search) {
      const q = input.search;
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q, mode: 'insensitive' } },
      ];
    }
    const rows = await this.prisma.withTenant(ctx.tenantId, async (tx) =>
      tx.customer.findMany({
        where,
        take: page.take,
        ...(page.cursor ? { cursor: page.cursor, skip: page.skip } : {}),
        orderBy: page.orderBy,
        select: { id: true, name: true, phone: true, createdAt: true },
      }),
    );
    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      createdAt: r.createdAt,
    }));
    return { items, nextCursor: items.length === page.take ? items[items.length - 1].id : null };
  }

  async getCustomer(ctx: TenantContext, id: string): Promise<CustomerDetail> {
    const customer = await this.prisma.withTenant(ctx.tenantId, async (tx) =>
      tx.customer.findFirst({
        where: { id, tenantId: ctx.tenantId },
        include: {
          devices: {
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: { id: true, brand: true, model: true, serial: true },
          },
          orders: {
            where: {
              branchId: { in: ctx.branchIds },
              ...(ctx.role === 'technician' ? { assignedTechnicianId: ctx.userId } : {}),
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 10,
            select: { id: true, status: true, branchId: true, deviceId: true, createdAt: true },
          },
        },
      }),
    );
    // Cross-tenant lookups are 404 by design: no tenant existence leak.
    if (!customer) throw new NotFoundException('Customer not found.');
    return {
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      createdAt: customer.createdAt,
      devices: customer.devices,
      repairs: customer.orders.map((o) => ({
        id: o.id,
        status: o.status,
        branchId: o.branchId,
        deviceId: o.deviceId,
        createdAt: o.createdAt,
      })),
    };
  }

  async createDevice(
    ctx: TenantContext,
    customerId: string,
    input: { brand: string; model: string; serial?: string },
  ): Promise<{ id: string; brand: string; model: string; serial: string | null }> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: customerId, tenantId: ctx.tenantId },
        select: { id: true },
      });
      if (!customer) throw new NotFoundException('Customer not found.');
      // Composite FK (tenantId, customerId) -> customers(tenantId, id)
      // is enforced by the database as a backstop.
      const device = await tx.device.create({
        data: {
          tenantId: ctx.tenantId,
          customerId: customer.id,
          brand: input.brand,
          model: input.model,
          serial: input.serial ?? null,
        },
      });
      await audit(tx, ctx, 'device.create', 'device', device.id, {
        customerId: customer.id,
        brand: input.brand,
        model: input.model,
      });
      return { id: device.id, brand: device.brand, model: device.model, serial: device.serial };
    });
  }
}
