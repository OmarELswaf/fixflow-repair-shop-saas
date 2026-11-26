import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
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
import { ApprovalsService } from './approvals.service';

const CreateEstimateDto = z
  .object({
    amount: z.number().positive().max(10_000_000),
    description: z.string().trim().min(1).max(500).optional(),
    days: z.number().int().min(1).max(30).optional(),
  })
  .strict();
const DecisionDto = z.object({ decision: z.enum(['approve', 'reject']) }).strict();
const PolicyDto = z.object({ requireEstimateApproval: z.boolean() }).strict();

@Controller()
@UseGuards(JwtAuthGuard, TenantGuard)
export class ApprovalsStaffController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Post('repairs/:id/estimates')
  @RequirePermission(PERMISSIONS.REPAIR_WRITE)
  async create(
    @Req() req: { tenantContext: TenantContext },
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.approvals.createEstimate(req.tenantContext, id, parse(CreateEstimateDto, body));
  }

  @Get('repairs/:id/estimates')
  @RequirePermission(PERMISSIONS.REPAIR_READ)
  async list(@Req() req: { tenantContext: TenantContext }, @Param('id') id: string) {
    return this.approvals.listEstimates(req.tenantContext, id);
  }

  @Get('tenants/me/approval-policy')
  @RequirePermission(PERMISSIONS.ADMIN)
  async getPolicy(@Req() req: { tenantContext: TenantContext }) {
    return this.approvals.getPolicy(req.tenantContext);
  }

  @Put('tenants/me/approval-policy')
  @RequirePermission(PERMISSIONS.ADMIN)
  async setPolicy(@Req() req: { tenantContext: TenantContext }, @Body() body: unknown) {
    return this.approvals.setPolicy(
      req.tenantContext,
      parse(PolicyDto, body).requireEstimateApproval,
    );
  }
}

/** Unauthenticated: /api/public/approve/:token (rate limited by middleware). */
@Controller('public/approve')
export class ApprovalsPublicController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get(':token')
  async view(
    @Param('token') token: string,
    @Res({ passthrough: true }) res: { setHeader(k: string, v: string): void },
  ) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return this.approvals.viewByToken(token);
  }

  @Post(':token')
  @HttpCode(200)
  async decide(
    @Param('token') token: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: { setHeader(k: string, v: string): void },
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.approvals.decide(token, parse(DecisionDto, body).decision);
  }
}
