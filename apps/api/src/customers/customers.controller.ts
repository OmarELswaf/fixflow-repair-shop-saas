import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermission, TenantGuard } from '../auth/tenant.guard';
import { PERMISSIONS } from '../tenancy/permissions';
import type { TenantContext } from '../tenancy/tenant-context';
import { parse } from '../common/parse';
import { CreateCustomerDto, CreateDeviceDto, ListCustomersQuery } from './dto';
import { CustomersService } from './customers.service';

@Controller('customers')
@UseGuards(JwtAuthGuard, TenantGuard)
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Post()
  @RequirePermission(PERMISSIONS.CUSTOMER_WRITE)
  async create(@Req() req: { tenantContext: TenantContext }, @Body() body: unknown) {
    return this.customers.createCustomer(req.tenantContext, parse(CreateCustomerDto, body));
  }

  @Get()
  @RequirePermission(PERMISSIONS.CUSTOMER_READ)
  async list(@Req() req: { tenantContext: TenantContext }, @Query() query: unknown) {
    return this.customers.listCustomers(req.tenantContext, parse(ListCustomersQuery, query));
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.CUSTOMER_READ)
  async detail(@Req() req: { tenantContext: TenantContext }, @Param('id') id: string) {
    return this.customers.getCustomer(req.tenantContext, id);
  }

  @Post(':id/devices')
  @RequirePermission(PERMISSIONS.DEVICE_WRITE)
  async createDevice(
    @Req() req: { tenantContext: TenantContext },
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.customers.createDevice(req.tenantContext, id, parse(CreateDeviceDto, body));
  }
}
