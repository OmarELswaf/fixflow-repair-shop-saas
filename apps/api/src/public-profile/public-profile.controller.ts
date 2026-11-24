import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermission, TenantGuard } from '../auth/tenant.guard';
import { parse } from '../common/parse';
import { PERMISSIONS } from '../tenancy/permissions';
import type { TenantContext } from '../tenancy/tenant-context';
import { UpsertPublicProfileDto } from './dto';
import { PublicProfileService } from './public-profile.service';

/**
 * Owner-only public-profile settings. ADMIN permission is owner-only
 * (see ROLE_PERMISSIONS: the admin role does not hold it). The
 * endpoints are tenant-scoped by the guard + withTenant: an owner can
 * only ever read or write their own tenant's profile. PUT is a full
 * replace; omitted optional fields are cleared.
 */
@Controller('tenants/me/public-profile')
@UseGuards(JwtAuthGuard, TenantGuard)
export class PublicProfileController {
  constructor(private readonly profiles: PublicProfileService) {}

  @Get()
  @RequirePermission(PERMISSIONS.ADMIN)
  async getOwn(@Req() req: { tenantContext: TenantContext }) {
    return this.profiles.getOwnProfile(req.tenantContext);
  }

  @Put()
  @RequirePermission(PERMISSIONS.ADMIN)
  async upsertOwn(@Req() req: { tenantContext: TenantContext }, @Body() body: unknown) {
    return this.profiles.upsertOwnProfile(req.tenantContext, parse(UpsertPublicProfileDto, body));
  }
}
