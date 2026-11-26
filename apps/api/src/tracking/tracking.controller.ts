import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermission, TenantGuard } from '../auth/tenant.guard';
import { PERMISSIONS } from '../tenancy/permissions';
import type { TenantContext } from '../tenancy/tenant-context';
import { parse } from '../common/parse';
import { TrackingService } from './tracking.service';

const CreateLinkDto = z.object({ days: z.number().int().min(1).max(90).optional() }).strict();

@Controller('repairs/:id/tracking-link')
@UseGuards(JwtAuthGuard, TenantGuard)
export class TrackingStaffController {
  constructor(private readonly tracking: TrackingService) {}

  @Post()
  @RequirePermission(PERMISSIONS.REPAIR_WRITE)
  async create(
    @Req() req: { tenantContext: TenantContext },
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const dto = parse(CreateLinkDto, body ?? {});
    return this.tracking.createLink(req.tenantContext, id, dto.days);
  }

  @Delete()
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.REPAIR_WRITE)
  async revoke(@Req() req: { tenantContext: TenantContext }, @Param('id') id: string) {
    return this.tracking.revokeLinks(req.tenantContext, id);
  }
}

/** Unauthenticated: GET /api/public/track/:token (rate limited by middleware). */
@Controller('public/track')
export class TrackingPublicController {
  constructor(private readonly tracking: TrackingService) {}

  @Get(':token')
  async get(
    @Param('token') token: string,
    @Res({ passthrough: true }) res: { setHeader(k: string, v: string): void },
  ) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return this.tracking.lookup(token);
  }
}
