import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as argon2 from 'argon2';

/**
 * DEMO ONLY — local-only demo fixtures. Not production data.
 * The demo password is hashed at seed time from DEMO_PASSWORD
 * in the environment. No real credential is stored in this repo.
 */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true')
    throw new Error('Demo seed needs ALLOW_DEMO_SEED=true in production (public demo only)');
  const connectionString = process.env.DATABASE_OWNER_URL;
  if (!connectionString) throw new Error('DATABASE_OWNER_URL required for local seed');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const demoPassword = process.env.DEMO_PASSWORD;
  if (!demoPassword || demoPassword.includes('CHANGE_ME')) {
    throw new Error('Set DEMO_PASSWORD in the environment before seeding demo data.');
  }
  const passwordHash = await argon2.hash(demoPassword);
  const tenant = await prisma.tenant.upsert({
    where: { id: 'demo-tenant' },
    update: {},
    create: { id: 'demo-tenant', name: 'Demo Repair Shop (DEMO ONLY)' },
  });
  const branch = await prisma.branch.upsert({
    where: { tenantId_id: { tenantId: tenant.id, id: 'demo-branch' } },
    update: {},
    create: { id: 'demo-branch', tenantId: tenant.id, name: 'Demo Branch' },
  });
  const user = await prisma.user.upsert({
    where: { email: 'demo@example.local' },
    update: {},
    create: { id: 'demo-user', email: 'demo@example.local', passwordHash },
  });
  await prisma.membership.upsert({
    where: { userId_tenantId: { userId: user.id, tenantId: tenant.id } },
    update: {},
    create: { userId: user.id, tenantId: tenant.id, role: 'owner', branchIds: [branch.id] },
  });
  const customer = await prisma.customer.upsert({
    where: { tenantId_id: { tenantId: tenant.id, id: 'demo-customer' } },
    update: {},
    create: { id: 'demo-customer', tenantId: tenant.id, name: 'Demo Customer' },
  });
  await prisma.device.upsert({
    where: { tenantId_id: { tenantId: tenant.id, id: 'demo-device' } },
    update: {},
    create: {
      id: 'demo-device',
      tenantId: tenant.id,
      customerId: customer.id,
      brand: 'Demo',
      model: 'Phone (DEMO ONLY)',
    },
  });
  await prisma.part.upsert({
    where: { tenantId_sku: { tenantId: tenant.id, sku: 'DEMO-SCREEN-01' } },
    update: {},
    create: { id: 'demo-part', tenantId: tenant.id, sku: 'DEMO-SCREEN-01', name: 'Demo Screen' },
  });
  await prisma.tenantPublicProfile.upsert({
    where: { tenantId: tenant.id },
    update: {},
    create: {
      tenantId: tenant.id,
      slug: 'demo-repair-shop',
      published: true,
      displayName: 'ورشة النور للصيانة (تجريبي)',
      description: 'صفحة تجريبية لورشة صيانة موبايلات ولابتوبات. كل البيانات وهمية.',
      theme: 'green',
      services: [
        { name: 'تغيير شاشات الموبايل', description: 'شاشات أصلية وتجارية.' },
        { name: 'صيانة اللابتوب', description: 'تنظيف وتغيير بطارية وهارد.' },
      ],
      contact: { phone: '+20 100 000 0000', whatsapp: '+20 100 000 0000' },
      hours: { sat: { open: '10:00', close: '22:00' }, fri: null },
    },
  });
  const existing = await prisma.repairOrder.count({ where: { tenantId: tenant.id } });
  if (existing === 0) {
    const problems = ['الشاشة لا تعمل', 'البطارية تنفد بسرعة', 'الجهاز لا يشحن'];
    for (const problemDescription of problems) {
      await prisma.repairOrder.create({
        data: {
          tenantId: tenant.id,
          branchId: branch.id,
          customerId: customer.id,
          deviceId: 'demo-device',
          problemDescription,
        },
      });
    }
  }
  await prisma.$disconnect();
}

main().catch((e: unknown) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
