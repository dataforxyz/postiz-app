import { Role } from '@prisma/client';
import {
  CHECK_POLICIES_KEY,
  AbilityPolicy,
} from '@gitroom/backend/services/auth/permissions/permissions.ability';
import {
  AuthorizationActions,
  Sections,
} from '@gitroom/backend/services/auth/permissions/permission.exception.class';
import { WebhookController } from './webhooks.controller';

function policies(method: keyof WebhookController): AbilityPolicy[] {
  return Reflect.getMetadata(
    CHECK_POLICIES_KEY,
    WebhookController.prototype[method]
  );
}

describe('WebhookController management boundary', () => {
  const service = {
    getWebhooksForManagement: jest.fn(),
    createWebhook: jest.fn(),
    updateWebhook: jest.fn(),
    deleteWebhook: jest.fn(),
    testWebhook: jest.fn(),
  };
  const org = { id: 'org-1', users: [{ role: Role.ADMIN }] } as any;

  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['createAWebhook', AuthorizationActions.Create],
    ['updateWebhook', AuthorizationActions.Update],
    ['deleteWebhook', AuthorizationActions.Delete],
    ['sendWebhook', AuthorizationActions.Create],
  ] as const)('requires ADMIN policy for %s', (method, action) => {
    expect(policies(method)).toContainEqual([action, Sections.ADMIN]);
  });

  it('keeps the webhook quota policy on create', () => {
    expect(policies('createAWebhook')).toContainEqual([
      AuthorizationActions.Create,
      Sections.WEBHOOKS,
    ]);
  });

  it('passes only the caller org, role, and saved id to test delivery', async () => {
    service.testWebhook.mockResolvedValue({
      ok: false,
      destination: 'https://hooks.example.com',
      status: 503,
      error: 'http_error',
    });
    const controller = new WebhookController(service as any);

    await expect(
      controller.sendWebhook(org, { id: 'hook-1' })
    ).resolves.toEqual({
      send: false,
      destination: 'https://hooks.example.com',
      status: 503,
      error: 'http_error',
    });
    expect(service.testWebhook).toHaveBeenCalledWith(
      'org-1',
      Role.ADMIN,
      'hook-1'
    );
  });
});
