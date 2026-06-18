jest.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: {
    set: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
  },
}));

jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class {},
}));

jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service',
  () => ({ OrganizationService: class {} })
);

jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class {} })
);

jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/posts/posts.service',
  () => ({ PostsService: class {} })
);

import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { EnterpriseController } from './enterprise.controller';

describe('EnterpriseController redirectParams', () => {
  const jwtSecret = 'test-enterprise-secret';

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = jwtSecret;
  });

  it('stores a stable callback event id with the OAuth state', async () => {
    const integrationProvider = {
      generateAuthUrl: jest.fn().mockResolvedValue({
        codeVerifier: 'code-verifier-1',
        state: 'oauth-state-1',
        url: 'https://postiz.example/oauth',
      }),
    };
    const integrationManager = {
      getAllowedSocialsIntegrations: jest.fn().mockReturnValue(['x']),
      getSocialIntegration: jest.fn().mockReturnValue(integrationProvider),
    };
    const organizationService = {
      getOrgByApiKey: jest.fn().mockResolvedValue({ id: 'postiz-org-1' }),
    };
    const controller = new EnterpriseController(
      integrationManager as any,
      organizationService as any,
      {} as any,
      {} as any
    );

    const params = AuthService.signJWT({
      redirectUrl: 'https://juston.example/return',
      apiKey: 'pst_test_key',
      provider: 'x',
      webhookUrl: 'https://juston.example/api/v1/onboarding/postiz-callback',
    });

    await expect(controller.redirectParams(params)).resolves.toBe(
      'https://postiz.example/oauth'
    );

    expect(ioRedis.set).toHaveBeenCalledWith(
      'webhookUrl:oauth-state-1',
      'https://juston.example/api/v1/onboarding/postiz-callback',
      'EX',
      3600
    );
    expect(ioRedis.set).toHaveBeenCalledWith(
      'webhookEventId:oauth-state-1',
      expect.any(String),
      'EX',
      3600
    );
    expect(ioRedis.set).toHaveBeenCalledWith(
      'redirect:oauth-state-1',
      'https://juston.example/return',
      'EX',
      3600
    );
  });
});
