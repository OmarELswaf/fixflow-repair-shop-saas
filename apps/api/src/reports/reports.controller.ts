import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermission, TenantGuard } from '../auth/tenant.guard';
import { PERMISSIONS } from '../tenancy/permissions';
import type { TenantContext } from '../tenancy/tenant-context';
import { parse } from '../common/parse';
import { RepairsSummaryQuery, StockReportQuery, StockSummaryQuery } from './dto';
import { ReportsService } from './reports.service';

/** Read-only operational reports. No writes, no pagination of raw rows. */
@Controller('reports')
@UseGuards(JwtAuthGuard, TenantGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('repairs/summary')
  @RequirePermission(PERMISSIONS.REPORT_READ)
  async repairsSummary(@Req() req: { tenantContext: TenantContext }, @Query() query: unknown) {
    return this.reports.repairsSummary(req.tenantContext, parse(RepairsSummaryQuery, query));
  }

  @Get('stock')
  @RequirePermission(PERMISSIONS.REPORT_READ)
  async stockReconciliation(@Req() req: { tenantContext: TenantContext }, @Query() query: unknown) {
    return this.reports.stockReconciliation(req.tenantContext, parse(StockReportQuery, query));
  }

  /**
   * Combined overview: summary + one page of reconciliation rows
   * from a single snapshot. Same query params as /reports/stock
   * (StockReportQuery), same permission. The separate /stock and
   * /stock/summary endpoints stay for compatibility.
   */
  @Get('stock/overview')
  @RequirePermission(PERMISSIONS.REPORT_READ)
  async stockOverview(@Req() req: { tenantContext: TenantContext }, @Query() query: unknown) {
    return this.reports.stockOverview(req.tenantContext, parse(StockReportQuery, query));
  }

  @Get('stock/summary')
  @RequirePermission(PERMISSIONS.REPORT_READ)
  async stockSummary(@Req() req: { tenantContext: TenantContext }, @Query() query: unknown) {
    return this.reports.stockSummary(req.tenantContext, parse(StockSummaryQuery, query));
  }
}
