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

jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class {},
}));

jest.mock('@gitroom/helpers/utils/sanitize.post.content', () => ({
  sanitizePostContent: (value: unknown) => value,
}));

import { BadRequestException } from '@nestjs/common';
import { PostsService } from './posts.service';

describe('PostsService', () => {
  const postRepository = {
    getPostById: jest.fn(),
    changeState: jest.fn(),
  };
  const integrationManager = {};
  const integrationService = {};
  const mediaService = {};
  const shortLinkService = {};
  const openaiService = {};
  const temporalService = {};
  const refreshIntegrationService = {};

  let service: PostsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PostsService(
      postRepository as any,
      integrationManager as any,
      integrationService as any,
      mediaService as any,
      shortLinkService as any,
      openaiService as any,
      temporalService as any,
      refreshIntegrationService as any
    );
    jest.spyOn(service, 'startWorkflow').mockResolvedValue(undefined as any);
  });

  it('changes status for posts inside the allowed integration scope', async () => {
    postRepository.getPostById.mockResolvedValue({
      id: 'post-1',
      integrationId: 'integration-1',
      integration: {
        providerIdentifier: 'x',
      },
    });

    await expect(
      service.changePostStatus('org-1', 'post-1', 'schedule', [
        'integration-1',
      ])
    ).resolves.toEqual({ id: 'post-1', state: 'QUEUE' });

    expect(postRepository.changeState).toHaveBeenCalledWith('post-1', 'QUEUE');
  });

  it('rejects status changes outside the allowed integration scope', async () => {
    postRepository.getPostById.mockResolvedValue({
      id: 'post-1',
      integrationId: 'integration-2',
      integration: {
        providerIdentifier: 'x',
      },
    });

    await expect(
      service.changePostStatus('org-1', 'post-1', 'schedule', [
        'integration-1',
      ])
    ).rejects.toThrow(BadRequestException);

    expect(postRepository.changeState).not.toHaveBeenCalled();
  });
});
