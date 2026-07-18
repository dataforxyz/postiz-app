jest.mock('@gitroom/nestjs-libraries/dtos/webhooks/webhook.transport', () => ({
  webhookTransport: { sendJson: jest.fn() },
}));

jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/posts/posts.service',
  () => ({ PostsService: class {} })
);

jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/notifications/notification.service',
  () => ({ NotificationService: class {} })
);

jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class {},
}));

jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class {} })
);

jest.mock(
  '@gitroom/nestjs-libraries/integrations/refresh.integration.service',
  () => ({ RefreshIntegrationService: class {} })
);

jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/webhooks/webhooks.service',
  () => ({ WebhooksService: class {} })
);

jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/subscriptions/subscription.service',
  () => ({ SubscriptionService: class {} })
);

jest.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: {},
}));

import { webhookTransport } from '@gitroom/nestjs-libraries/dtos/webhooks/webhook.transport';
import { PostActivity } from './post.activity';

describe('PostActivity customer webhook delivery', () => {
  it('uses the hardened transport with the unchanged payload and filtering', async () => {
    const post = [
      {
        id: 'post-1',
        state: 'PUBLISHED',
        content: 'legacy webhook payload',
      },
    ];
    const postService = {
      getPostByForWebhookId: jest.fn().mockResolvedValue(post),
    };
    const webhookService = {
      getWebhooksForDelivery: jest.fn().mockResolvedValue([
        { id: 'all', url: 'https://all.example/hook', integrations: [] },
        {
          id: 'matching',
          url: 'https://matching.example/hook',
          integrations: [{ integration: { id: 'integration-1' } }],
        },
        {
          id: 'other',
          url: 'https://other.example/hook',
          integrations: [{ integration: { id: 'integration-2' } }],
        },
      ]),
    };
    const sendJson = jest.mocked(webhookTransport.sendJson);
    sendJson.mockResolvedValue({
      ok: true,
      destination: 'https://all.example',
      status: 200,
    });
    const activity = new PostActivity(
      postService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      webhookService as any,
      {} as any,
      {} as any
    );

    await activity.sendWebhooks('post-1', 'org-1', 'integration-1');

    expect(webhookService.getWebhooksForDelivery).toHaveBeenCalledWith('org-1');
    expect(postService.getPostByForWebhookId).toHaveBeenCalledWith('post-1');
    expect(sendJson).toHaveBeenCalledTimes(2);
    expect(sendJson).toHaveBeenCalledWith('https://all.example/hook', post);
    expect(sendJson).toHaveBeenCalledWith(
      'https://matching.example/hook',
      post
    );
    expect(sendJson).not.toHaveBeenCalledWith(
      'https://other.example/hook',
      expect.anything()
    );
  });
});
