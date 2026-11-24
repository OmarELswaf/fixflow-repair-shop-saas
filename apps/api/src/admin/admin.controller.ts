import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermission, TenantGuard } from '../auth/tenant.guard';
import { PERMISSIONS } from '../tenancy/permissions';
import type { TenantContext } from '../tenancy/tenant-context';
import { AdminService } from './admin.service';

/**
 * Local admin read-only view. Owner only (ADMIN permission); no
 * writes of any kind. The frontend uses this to render staff and
 * branch scopes it already has — it grants nothing new.
 */
@Controller('admin')
@UseGuards(JwtAuthGuard, TenantGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('team')
  @RequirePermission(PERMISSIONS.ADMIN)
  async getTeam(@Req() req: { tenantContext: TenantContext }) {
    return this.admin.getTeam(req.tenantContext);
  }
}
