import 'reflect-metadata';

jest.mock('@sentry/nestjs', () => ({
  metrics: {
    count: jest.fn(),
  },
}));

jest.mock('@gitroom/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: {
    createStorage: jest.fn(() => ({
      uploadFile: jest.fn(),
    })),
  },
}));

jest.mock('@gitroom/nestjs-libraries/upload/custom.upload.validation', () => ({
  CustomFileValidationPipe: class {
    transform(value: unknown) {
      return value;
    }
  },
}));

jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  socialIntegrationList: [],
  IntegrationManager: class {},
}));

jest.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: {},
}));

jest.mock('@gitroom/helpers/utils/sanitize.post.content', () => ({
  sanitizePostContent: (value: unknown) => value,
}));

jest.mock('file-type', () => ({
  fromBuffer: jest.fn(),
}));

import { PublicIntegrationsController } from './public.integrations.controller';
import { PostValidationException } from '@gitroom/backend/api/routes/posts.validation.exception';

describe('PublicIntegrationsController', () => {
  const integrationService = {
    getInternalIntegrationsList: jest.fn(),
    getIntegrationHealthList: jest.fn(),
  };
  const postsService = {
    mapTypeToPost: jest.fn(),
    validatePosts: jest.fn(),
    createPost: jest.fn(),
    changePostStatus: jest.fn(),
    getInternalPostsByIds: jest.fn(),
    getInternalPostsByIntegrationWindow: jest.fn(),
  };
  const mediaService = {};
  const notificationService = {};
  const integrationManager = {};
  const refreshIntegrationService = {};

  let controller: PublicIntegrationsController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new PublicIntegrationsController(
      integrationService as any,
      postsService as any,
      mediaService as any,
      notificationService as any,
      integrationManager as any,
      refreshIntegrationService as any
    );
  });

  it('requires write permission for public post status changes', () => {
    expect(
      Reflect.getMetadata(
        'token_permission',
        PublicIntegrationsController.prototype.changePostStatus
      )
    ).toBe('write');
  });

  it('forwards token integration scope when changing post status', async () => {
    postsService.changePostStatus.mockResolvedValue({
      id: 'post-1',
      state: 'QUEUE',
    });

    await controller.changePostStatus(
      { id: 'org-1' } as any,
      'post-1',
      { status: 'schedule' },
      {
        tokenScopes: {
          permissions: ['write'],
          integrationIds: ['integration-1'],
        },
      } as any
    );

    expect(postsService.changePostStatus).toHaveBeenCalledWith(
      'org-1',
      'post-1',
      'schedule',
      ['integration-1']
    );
  });

  it('preserves post validation exceptions for the validation filter', async () => {
    postsService.mapTypeToPost.mockResolvedValue({
      type: 'schedule',
      posts: [
        {
          value: [{ image: [] }],
          integration: { id: 'integration-1' },
        },
      ],
    });
    postsService.validatePosts.mockResolvedValue([
      {
        identifier: 'x',
        name: 'X',
        emptyContent: true,
      },
    ]);

    await expect(
      controller.createPost({ id: 'org-1' } as any, { type: 'schedule' }, {
        tokenScopes: null,
      } as any)
    ).rejects.toBeInstanceOf(PostValidationException);
  });

  it('returns integration health without raw credentials', async () => {
    integrationService.getIntegrationHealthList.mockResolvedValue([
      {
        id: 'integration-1',
        name: 'TikTok',
        providerIdentifier: 'tiktok',
        token: 'access-token',
        refreshToken: 'refresh-token',
        internalId: 'user-1',
        profile: 'profile',
        picture: 'pic',
        disabled: false,
        refreshNeeded: false,
        inBetweenSteps: false,
        tokenExpiration: new Date('2030-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        customer: { id: 'group-1', name: 'Group' },
      },
      {
        id: 'integration-2',
        name: 'Expired YouTube',
        providerIdentifier: 'youtube',
        token: '',
        refreshToken: 'refresh-token',
        internalId: 'user-2',
        profile: 'profile-2',
        picture: 'pic-2',
        disabled: true,
        refreshNeeded: true,
        inBetweenSteps: false,
        tokenExpiration: null,
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
        customer: null,
      },
      {
        id: 'integration-3',
        name: 'Connecting Instagram',
        providerIdentifier: 'instagram',
        token: '',
        refreshToken: '',
        internalId: '',
        profile: null,
        picture: null,
        disabled: false,
        refreshNeeded: false,
        inBetweenSteps: true,
        tokenExpiration: null,
        updatedAt: new Date('2026-01-03T00:00:00.000Z'),
        customer: null,
      },
    ]);

    const result = await controller.listIntegrationHealth(
      { id: 'org-1' } as any,
      {
        tokenScopes: {
          permissions: ['read'],
          integrationIds: ['integration-1'],
        },
      } as any
    );

    expect(integrationService.getIntegrationHealthList).toHaveBeenCalledWith(
      'org-1',
      ['integration-1']
    );
    expect(result.integrations[0]).toMatchObject({
      id: 'integration-1',
      provider: 'tiktok',
      internalId: 'user-1',
      auth: {
        needs_reconnect: false,
      },
    });
    expect(result.integrations[1]).toMatchObject({
      id: 'integration-2',
      provider: 'youtube',
      disabled: true,
      auth: {
        needs_reconnect: true,
      },
    });
    expect(result.integrations[2]).toMatchObject({
      id: 'integration-3',
      provider: 'instagram',
      auth: {
        status: 'unknown',
      },
    });
    expect(result.integrations[0]).not.toHaveProperty('token');
    expect(result.integrations[0]).not.toHaveProperty('refreshToken');
  });

  it('exposes credential-free post status on the non-internal route', async () => {
    postsService.getInternalPostsByIds.mockResolvedValue([
      {
        id: 'post-1',
        state: 'PUBLISHED',
        integrationId: 'integration-1',
        error: '',
      },
    ]);

    const result = await controller.getPostsStatus(
      { id: 'org-1' } as any,
      'post-1',
      {
        tokenScopes: {
          permissions: ['read'],
          integrationIds: ['integration-1'],
        },
      } as any
    );

    expect(postsService.getInternalPostsByIds).toHaveBeenCalledWith(
      'org-1',
      ['post-1'],
      ['integration-1']
    );
    expect(result.posts).toEqual([
      {
        id: 'post-1',
        state: 'PUBLISHED',
        integrationId: 'integration-1',
        error: '',
      },
    ]);
  });

  it('exposes credential-free post history on the non-internal route', async () => {
    postsService.getInternalPostsByIntegrationWindow.mockResolvedValue([
      {
        id: 'post-1',
        state: 'PUBLISHED',
        integrationId: 'integration-1',
      },
    ]);

    const result = await controller.getPostsHistory(
      { id: 'org-1' } as any,
      'integration-1',
      '2026-01-01T00:00:00Z',
      '2026-01-31T00:00:00Z',
      '25',
      {
        tokenScopes: {
          permissions: ['read'],
          integrationIds: ['integration-1'],
        },
      } as any
    );

    expect(
      postsService.getInternalPostsByIntegrationWindow
    ).toHaveBeenCalledWith(
      'org-1',
      ['integration-1'],
      {
        startDate: '2026-01-01T00:00:00Z',
        endDate: '2026-01-31T00:00:00Z',
        states: ['PUBLISHED'],
        limit: 25,
      },
      ['integration-1']
    );
    expect(result.posts).toEqual([
      {
        id: 'post-1',
        state: 'PUBLISHED',
        integrationId: 'integration-1',
      },
    ]);
  });
});
