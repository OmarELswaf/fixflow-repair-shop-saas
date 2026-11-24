import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequireBranch, RequirePermission, TenantGuard } from '../auth/tenant.guard';
import { PERMISSIONS } from '../tenancy/permissions';
import type { TenantContext } from '../tenancy/tenant-context';
import { parse } from '../common/parse';
import {
  AdjustStockDto,
  CreatePartDto,
  ListMovementsQuery,
  ListPartsQuery,
  ListStockQuery,
  ReleaseConsumePartDto,
  ReservePartDto,
} from './dto';
import { InventoryService } from './inventory.service';

/**
 * Parts catalog, branch stock, stock movements and repair-part
 * reservation. Repair-part routes live here (not in RepairsController)
 * because they are stock operations; the ':id/parts' paths have more
 * segments than the repairs ':id' routes, so there is no route clash.
 */
@Controller()
@UseGuards(JwtAuthGuard, TenantGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('parts')
  @RequirePermission(PERMISSIONS.INVENTORY_READ)
  async listParts(@Req() req: { tenantContext: TenantContext }, @Query() query: unknown) {
    return this.inventory.listParts(req.tenantContext, parse(ListPartsQuery, query));
  }

  @Post('parts')
  @RequirePermission(PERMISSIONS.INVENTORY_WRITE)
  async createPart(@Req() req: { tenantContext: TenantContext }, @Body() body: unknown) {
    return this.inventory.createPart(req.tenantContext, parse(CreatePartDto, body));
  }

  @Get('parts/:id')
  @RequirePermission(PERMISSIONS.INVENTORY_READ)
  async getPart(@Req() req: { tenantContext: TenantContext }, @Param('id') id: string) {
    return this.inventory.getPart(req.tenantContext, id);
  }

  @Get('stock')
  @RequirePermission(PERMISSIONS.INVENTORY_READ)
  async listStock(@Req() req: { tenantContext: TenantContext }, @Query() query: unknown) {
    return this.inventory.listStock(req.tenantContext, parse(ListStockQuery, query));
  }

  @Post('stock/adjust')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.INVENTORY_WRITE)
  @RequireBranch()
  async adjustStock(@Req() req: { tenantContext: TenantContext }, @Body() body: unknown) {
    return this.inventory.adjustStock(req.tenantContext, parse(AdjustStockDto, body));
  }

  @Get('stock/movements')
  @RequirePermission(PERMISSIONS.INVENTORY_READ)
  async listMovements(@Req() req: { tenantContext: TenantContext }, @Query() query: unknown) {
    return this.inventory.listMovements(req.tenantContext, parse(ListMovementsQuery, query));
  }

  @Get('repairs/:id/parts')
  @RequirePermission(PERMISSIONS.REPAIR_READ)
  async listRepairParts(@Req() req: { tenantContext: TenantContext }, @Param('id') id: string) {
    return this.inventory.listRepairParts(req.tenantContext, id);
  }

  @Post('repairs/:id/parts')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.STOCK_RESERVE)
  async reservePart(
    @Req() req: { tenantContext: TenantContext },
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.inventory.reservePart(req.tenantContext, id, parse(ReservePartDto, body));
  }

  @Post('repairs/:id/parts/:lineId/release')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.STOCK_RELEASE)
  async releasePart(
    @Req() req: { tenantContext: TenantContext },
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: unknown,
  ) {
    return this.inventory.releasePart(
      req.tenantContext,
      id,
      lineId,
      parse(ReleaseConsumePartDto, body),
    );
  }

  @Post('repairs/:id/parts/:lineId/consume')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.STOCK_CONSUME)
  async consumePart(
    @Req() req: { tenantContext: TenantContext },
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: unknown,
  ) {
    return this.inventory.consumePart(
      req.tenantContext,
      id,
      lineId,
      parse(ReleaseConsumePartDto, body),
    );
  }
}
