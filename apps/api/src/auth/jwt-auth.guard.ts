import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AUTH_DB, type AuthDb } from './ports';
import { permissionsForRole } from '../tenancy/permissions';
import { resolveTenantContext } from '../tenancy/tenant-context';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  tenantId: string | null;
}

/**
 * JwtAuthGuard: validates the short-lived access JWT, loads the user's
 * memberships from the database, and attaches req.user and
 * req.tenantContext. A tenantId in the token that is not one of the
 * user's memberships is rejected — a client cannot self-assign a tenant.
 * When the token has no tenant (multi-tenant user before selection),
 * tenantContext is null and only /auth/select-tenant is usable.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    @Inject(AUTH_DB) private readonly db: AuthDb,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const auth = req.headers?.authorization as string | undefined;
    const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
    if (!token) throw new UnauthorizedException('Missing access token.');
    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired access token.');
    }
    if (
      typeof payload.sub !== 'string' ||
      (payload.tenantId !== null && typeof payload.tenantId !== 'string')
    ) {
      throw new UnauthorizedException('Invalid access token claims.');
    }
    const user = await this.db.findUserById(payload.sub);
    if (!user) throw new UnauthorizedException('Unknown user.');
    const memberships = await this.db.listMemberships(user.id);
    if (payload.tenantId !== null && !memberships.some((m) => m.tenantId === payload.tenantId)) {
      throw new UnauthorizedException('Token tenant is not a membership of this user.');
    }
    req.user = { id: user.id, email: user.email, memberships };
    req.tenantContext =
      payload.tenantId !== null
        ? resolveTenantContext(
            {
              id: user.id,
              memberships: memberships.map((m) => ({
                tenantId: m.tenantId,
                branchIds: m.branchIds,
                role: m.role,
                permissions: permissionsForRole(m.role),
                entitlements: [],
              })),
            },
            payload.tenantId,
          )
        : null;
    return true;
  }
}
