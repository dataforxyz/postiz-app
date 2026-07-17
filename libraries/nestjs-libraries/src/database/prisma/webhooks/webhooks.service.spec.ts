import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { webhookTransport } from '@gitroom/nestjs-libraries/dtos/webhooks/webhook.transport';
import { WEBHOOK_TEST_PAYLOAD, WebhooksService } from './webhooks.service';

describe('WebhooksService authorization', () => {
  const repository = {
    getTotal: jest.fn(),
    getWebhooks: jest.fn(),
    getWebhook: jest.fn(),
    countOwnedIntegrations: jest.fn(),
    createWebhook: jest.fn(),
    updateWebhook: jest.fn(),
    deleteWebhook: jest.fn(),
  };

  let service: WebhooksService;

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    service = new WebhooksService(repository as any);
  });

  it('enforces the management role in the service layer', async () => {
    await expect(
      service.createWebhook('org-1', Role.USER, {
        name: 'test',
        url: 'https://93.184.216.34/hook',
        integrations: [],
      })
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.createWebhook).not.toHaveBeenCalled();
  });

  it('enforces the management role for saved test delivery too', async () => {
    await expect(
      service.testWebhook('org-1', Role.USER, 'hook-1')
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.getWebhook).not.toHaveBeenCalled();
  });

  it('rejects integration ids that are not all owned by the organization', async () => {
    repository.countOwnedIntegrations.mockResolvedValue(1);

    await expect(
      service.createWebhook('org-1', Role.ADMIN, {
        name: 'test',
        url: 'https://93.184.216.34/hook',
        integrations: [{ id: 'owned' }, { id: 'other-org' }],
      })
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(repository.countOwnedIntegrations).toHaveBeenCalledWith('org-1', [
      'owned',
      'other-org',
    ]);
    expect(repository.createWebhook).not.toHaveBeenCalled();
  });

  it('requires update and delete targets to belong to the organization', async () => {
    repository.getWebhook.mockResolvedValue(null);

    await expect(
      service.updateWebhook('org-1', Role.ADMIN, {
        id: 'other-org-hook',
        name: 'test',
        url: 'https://93.184.216.34/hook',
        integrations: [],
      })
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.deleteWebhook('org-1', Role.ADMIN, 'other-org-hook')
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(repository.updateWebhook).not.toHaveBeenCalled();
    expect(repository.deleteWebhook).not.toHaveBeenCalled();
  });

  it('tests only the saved endpoint owned by the organization', async () => {
    repository.getWebhook.mockResolvedValue({
      id: 'hook-1',
      organizationId: 'org-1',
      url: 'https://93.184.216.34/private/path?token=secret',
      integrations: [],
    });
    const send = jest.spyOn(webhookTransport, 'sendJson').mockResolvedValue({
      ok: true,
      destination: 'https://93.184.216.34',
      status: 204,
    });

    await expect(
      service.testWebhook('org-1', Role.SUPERADMIN, 'hook-1')
    ).resolves.toEqual({
      ok: true,
      destination: 'https://93.184.216.34',
      status: 204,
    });
    expect(repository.getWebhook).toHaveBeenCalledWith('org-1', 'hook-1');
    expect(send).toHaveBeenCalledWith(
      'https://93.184.216.34/private/path?token=secret',
      WEBHOOK_TEST_PAYLOAD
    );
  });

  it('denies testing a missing or cross-organization saved endpoint', async () => {
    repository.getWebhook.mockResolvedValue(null);
    const send = jest.spyOn(webhookTransport, 'sendJson');

    await expect(
      service.testWebhook('org-1', Role.ADMIN, 'other-org-hook')
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(send).not.toHaveBeenCalled();
  });

  it('redacts destinations outside management and delivery authority flows', async () => {
    repository.getWebhooks.mockResolvedValue([
      {
        id: 'hook-1',
        url: 'https://hooks.example.com/customer/path?token=secret',
        integrations: [],
      },
    ]);

    await expect(service.getWebhooks('org-1')).resolves.toEqual([
      {
        id: 'hook-1',
        url: 'https://hooks.example.com',
        integrations: [],
      },
    ]);
    await expect(
      service.getWebhooksForManagement('org-1', Role.ADMIN)
    ).resolves.toEqual([
      {
        id: 'hook-1',
        url: 'https://hooks.example.com/customer/path?token=secret',
        integrations: [],
      },
    ]);
  });
});
