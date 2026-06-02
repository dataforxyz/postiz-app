import { getTokenScopes } from '@gitroom/nestjs-libraries/chat/async.storage';

export const ensureToolPermission = (permission: 'read' | 'write') => {
  const scopes = getTokenScopes();
  if (!scopes) {
    return;
  }

  if (!scopes.permissions.includes(permission)) {
    throw new Error(`Token does not have ${permission} permission`);
  }
};

export const getAllowedToolIntegrationIds = () =>
  getTokenScopes()?.integrationIds || undefined;

export const isToolIntegrationAllowed = (integrationId: string) => {
  const allowedIds = getAllowedToolIntegrationIds();
  return !allowedIds?.length || allowedIds.includes(integrationId);
};
