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
  AssignDto,
  CreateRepairDto,
  ListRepairsQuery,
  TechniciansQuery,
  TransitionDto,
} from './dto';
import { RepairsService } from './repairs.service';

@Controller('repairs')
@UseGuards(JwtAuthGuard, TenantGuard)
export class RepairsController {
  constructor(private readonly repairs: RepairsService) {}

  @Post()
  @RequirePermission(PERMISSIONS.REPAIR_WRITE)
  @RequireBranch()
  async create(@Req() req: { tenantContext: TenantContext }, @Body() body: unknown) {
    return this.repairs.createRepair(req.tenantContext, parse(CreateRepairDto, body));
  }

  @Get()
  @RequirePermission(PERMISSIONS.REPAIR_READ)
  async list(@Req() req: { tenantContext: TenantContext }, @Query() query: unknown) {
    return this.repairs.listRepairs(req.tenantContext, parse(ListRepairsQuery, query));
  }

  // Static route before ':id': 'technicians' must not be read as an id.
  @Get('technicians')
  @RequirePermission(PERMISSIONS.REPAIR_ASSIGN)
  async technicians(@Req() req: { tenantContext: TenantContext }, @Query() query: unknown) {
    return this.repairs.listTechnicians(req.tenantContext, parse(TechniciansQuery, query).branchId);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.REPAIR_READ)
  async detail(@Req() req: { tenantContext: TenantContext }, @Param('id') id: string) {
    return this.repairs.getRepair(req.tenantContext, id);
  }

  @Get(':id/receipt')
  @RequirePermission(PERMISSIONS.REPAIR_READ)
  async receipt(@Req() req: { tenantContext: TenantContext }, @Param('id') id: string) {
    return this.repairs.getReceipt(req.tenantContext, id);
  }

  @Post(':id/assign')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.REPAIR_ASSIGN)
  async assign(
    @Req() req: { tenantContext: TenantContext },
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const dto = parse(AssignDto, body);
    return this.repairs.assignTechnician(req.tenantContext, id, dto.technicianUserId);
  }

  @Post(':id/transition')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.REPAIR_TRANSITION)
  async transition(
    @Req() req: { tenantContext: TenantContext },
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.repairs.transitionRepair(req.tenantContext, id, parse(TransitionDto, body));
  }
}
