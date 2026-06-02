import { Request } from 'express';

export type RequestTokenScopes = {
  permissions: Array<'read' | 'write'>;
  integrationIds: string[] | null;
} | null;

export const getAllowedIntegrationIds = (
  req: Request & { tokenScopes?: RequestTokenScopes }
) => req.tokenScopes?.integrationIds || undefined;

export const hasTokenPermission = (
  scopes: RequestTokenScopes,
  permission: 'read' | 'write'
) => !scopes || scopes.permissions.includes(permission);
