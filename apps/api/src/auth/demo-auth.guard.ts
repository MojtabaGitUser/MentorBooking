import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Pool } from 'pg';
import { ALLOWED_ROLES, AuthenticatedRequest, AuthenticatedUser, denyAccess, PUBLIC_ROUTE, Role } from './access';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function unauthorized(): never {
  throw new UnauthorizedException({ code: 'USER_NOT_FOUND', message: 'Valid demo identity required.' });
}

@Injectable()
export class DemoAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly pool: Pool) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, targets)) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const id = request.headers['x-user-id'];
    if (process.env.DEMO_AUTH_ENABLED !== 'true' || typeof id !== 'string' || !uuid.test(id)) {
      unauthorized();
    }
    const { rows } = await this.pool.query<AuthenticatedUser>(
      'SELECT id, role, display_name AS "displayName", timezone FROM users WHERE id = $1', [id],
    );
    if (!rows[0]) unauthorized();
    request.user = rows[0];
    const roles = this.reflector.getAllAndOverride<Role[]>(ALLOWED_ROLES, targets);
    if (roles && !roles.includes(request.user.role)) denyAccess();
    return true;
  }
}
