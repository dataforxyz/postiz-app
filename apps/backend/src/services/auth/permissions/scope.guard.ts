import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  SetMetadata,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { hasTokenPermission, RequestTokenScopes } from '../token-scopes';

const TOKEN_PERMISSION_KEY = 'token_permission';

export const RequiresTokenPermission = (permission: 'read' | 'write') =>
  SetMetadata(TOKEN_PERMISSION_KEY, permission);

@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(private _reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermission = this._reflector.getAllAndOverride<
      'read' | 'write'
    >(TOKEN_PERMISSION_KEY, [context.getHandler(), context.getClass()]);

    if (!requiredPermission) {
      return true;
    }

    const request = context.switchToHttp().getRequest<
      Request & { tokenScopes?: RequestTokenScopes }
    >();

    if (hasTokenPermission(request.tokenScopes || null, requiredPermission)) {
      return true;
    }

    throw new ForbiddenException('Token does not have required permission');
  }
}
