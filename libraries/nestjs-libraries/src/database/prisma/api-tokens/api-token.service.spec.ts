import { BadRequestException, NotFoundException } from '@nestjs/common';

jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({
    IntegrationService: class {},
  })
);

import { ApiTokenService } from './api-token.service';

describe('ApiTokenService', () => {
  const repository = {
    createToken: jest.fn(),
    listTokens: jest.fn(),
    findTokenByHash: jest.fn(),
    updateLastUsedAt: jest.fn(),
    revokeToken: jest.fn(),
    getTokenById: jest.fn(),
    replaceToken: jest.fn(),
  };
  const integrationService = {
    getIntegrationsList: jest.fn(),
  };

  let service: ApiTokenService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ApiTokenService(repository as any, integrationService as any);
  });

  it('creates and validates a token', async () => {
    integrationService.getIntegrationsList.mockResolvedValue([
      { id: 'integration-a' },
    ]);
    repository.createToken.mockResolvedValue({
      id: 'token-id',
    });

    const created = await service.createToken(
      'org-1',
      'Read token',
      ['read'],
      ['integration-a']
    );

    const createCall = repository.createToken.mock.calls[0][0];
    repository.findTokenByHash.mockResolvedValue({
      id: 'token-id',
      organizationId: 'org-1',
      permissions: ['read'],
      scopes: [{ integrationId: 'integration-a' }],
    });

    const validated = await service.validateToken(created.token);

    expect(created.id).toBe('token-id');
    expect(createCall.permissions).toEqual(['read']);
    expect(createCall.integrationIds).toEqual(['integration-a']);
    expect(validated).toEqual({
      id: 'token-id',
      orgId: 'org-1',
      permissions: ['read'],
      integrationIds: ['integration-a'],
    });
    expect(repository.updateLastUsedAt).toHaveBeenCalledWith('token-id');
  });

  it('rejects invalid permissions', async () => {
    await expect(
      service.createToken('org-1', 'Bad token', ['admin'])
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('revokes a token', async () => {
    repository.revokeToken.mockResolvedValue({ count: 1 });

    await expect(service.revokeToken('org-1', 'token-id')).resolves.toEqual({
      success: true,
    });
  });

  it('fails revocation when token does not exist', async () => {
    repository.revokeToken.mockResolvedValue({ count: 0 });

    await expect(service.revokeToken('org-1', 'missing')).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('requires scoped integrations to belong to the org', async () => {
    integrationService.getIntegrationsList.mockResolvedValue([
      { id: 'integration-a' },
    ]);

    await expect(
      service.createToken('org-1', 'Scoped token', ['read'], [
        'integration-a',
        'integration-b',
      ])
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
