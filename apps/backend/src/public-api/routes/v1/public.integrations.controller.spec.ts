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
  const integrationService = {};
  const postsService = {
    mapTypeToPost: jest.fn(),
    validatePosts: jest.fn(),
    createPost: jest.fn(),
    changePostStatus: jest.fn(),
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
      controller.createPost(
        { id: 'org-1' } as any,
        { type: 'schedule' },
        { tokenScopes: null } as any
      )
    ).rejects.toBeInstanceOf(PostValidationException);
  });
});
