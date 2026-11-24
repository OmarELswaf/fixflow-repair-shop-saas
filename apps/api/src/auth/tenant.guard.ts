import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { canAccessBranch, hasPermission } from '../tenancy/permissions';
import type { TenantContext } from '../tenancy/tenant-context';

export const REQUIRE_PERMISSION_KEY = 'fixflow:requirePermission';
export const REQUIRE_BRANCH_KEY = 'fixflow:requireBranch';

/** Require a permission on the resolved tenant context. */
export const RequirePermission = (permission: string) =>
  SetMetadata(REQUIRE_PERMISSION_KEY, permission);
/** Require the request's branchId (params or body) to be in scope. */
export const RequireBranch = () => SetMetadata(REQUIRE_BRANCH_KEY, true);

/**
 * TenantGuard: runs after JwtAuthGuard. Checks the required permission
 * and, when @RequireBranch() is set, that the requested branch is in
 * the user's branch scope. Branch authorization is separate from
 * tenant authorization.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.get<string>(REQUIRE_PERMISSION_KEY, context.getHandler());
    const requireBranch = this.reflector.get<boolean>(REQUIRE_BRANCH_KEY, context.getHandler());
    const req = context.switchToHttp().getRequest();
    const ctx = req.tenantContext as TenantContext | null;
    if (!ctx) throw new UnauthorizedException('No tenant selected for this request.');
    if (required && !hasPermission(ctx, required)) {
      throw new ForbiddenException(`Missing permission: ${required}.`);
    }
    if (requireBranch) {
      const branchId = req.params?.branchId ?? req.body?.branchId;
      if (typeof branchId !== 'string' || !canAccessBranch(ctx, branchId)) {
        throw new ForbiddenException('Branch is outside the user scope.');
      }
    }
    return true;
  }
}
