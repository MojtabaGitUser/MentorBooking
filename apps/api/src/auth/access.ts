import { createParamDecorator, ExecutionContext, ForbiddenException, SetMetadata } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';

export type Role = 'mentor' | 'mentee' | 'admin';
export interface AuthenticatedUser {
  id: string;
  role: Role;
  displayName: string;
  timezone: string;
}

export interface AuthenticatedRequest extends IncomingMessage {
  user: AuthenticatedUser;
}

export const PUBLIC_ROUTE = Symbol('public route');
export const ALLOWED_ROLES = Symbol('allowed roles');
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
export const Roles = (...roles: Role[]) => SetMetadata(ALLOWED_ROLES, roles);
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) =>
  context.switchToHttp().getRequest<AuthenticatedRequest>().user);

export function denyAccess(): never {
  throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Access denied.' });
}

type ResourceAction = 'readWallet' | 'readSessions' | 'editAvailability' | 'editBlockout' | 'readLedger';
const ownerRoles: Record<ResourceAction, Role> = {
  readWallet: 'mentee', readSessions: 'mentee', editAvailability: 'mentor',
  editBlockout: 'mentor', readLedger: 'mentee',
};

// For an existing resource, pass its owner from the loaded row.
export function requireResourceAccess(user: AuthenticatedUser, action: ResourceAction, ownerId: string) {
  if (action === 'readLedger' && user.role === 'admin') return;
  if (user.role !== ownerRoles[action] || user.id !== ownerId) denyAccess();
}
