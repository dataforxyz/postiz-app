import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { WebhooksRepository } from '@gitroom/nestjs-libraries/database/prisma/webhooks/webhooks.repository';
import { WebhooksDto } from '@gitroom/nestjs-libraries/dtos/webhooks/webhooks.dto';
import {
  normalizeWebhookUrl,
  redactWebhookDestination,
  resolveWebhookAddresses,
} from '@gitroom/nestjs-libraries/dtos/webhooks/webhook.url.validator';
import { webhookTransport } from '@gitroom/nestjs-libraries/dtos/webhooks/webhook.transport';

export const WEBHOOK_TEST_PAYLOAD = Object.freeze([
  {
    id: 'cm6tcts4f0005qcwit25cis26',
    content: 'This is the first post to instagram',
    publishDate: '2025-02-06T13:09:00.000Z',
    releaseURL: 'https://facebook.com/release/release',
    state: 'PUBLISHED',
    integration: {
      id: 'cm6s4uyou0001i2r47pxix6z1',
      name: 'test',
      providerIdentifier: 'instagram',
      picture: 'https://uploads.gitroom.com/F6LSCD8wrrQ.jpeg',
      type: 'social',
    },
  },
  {
    id: 'cm6tcts4f0005qcwit25cis26',
    content: 'This is the second post to facebook',
    publishDate: '2025-02-06T13:09:00.000Z',
    releaseURL: 'https://facebook.com/release2/release2',
    state: 'PUBLISHED',
    integration: {
      id: 'cm6s4uyou0001i2r47pxix6z1',
      name: 'test2',
      providerIdentifier: 'facebook',
      picture: 'https://uploads.gitroom.com/F6LSCD8wrrQ.jpeg',
      type: 'social',
    },
  },
]);

@Injectable()
export class WebhooksService {
  constructor(private _webhooksRepository: WebhooksRepository) {}

  getTotal(orgId: string) {
    return this._webhooksRepository.getTotal(orgId);
  }

  async getWebhooks(orgId: string) {
    const webhooks = await this._webhooksRepository.getWebhooks(orgId);
    return webhooks.map((webhook) => ({
      ...webhook,
      url: redactWebhookDestination(webhook.url),
    }));
  }

  getWebhooksForDelivery(orgId: string) {
    return this._webhooksRepository.getWebhooks(orgId);
  }

  getWebhooksForManagement(orgId: string, role: Role) {
    this.assertCanManage(role);
    return this._webhooksRepository.getWebhooks(orgId);
  }

  async createWebhook(orgId: string, role: Role, body: WebhooksDto) {
    this.assertCanManage(role);
    const safeBody = await this.validateBody(orgId, body);
    return this._webhooksRepository.createWebhook(orgId, safeBody);
  }

  async updateWebhook(
    orgId: string,
    role: Role,
    body: WebhooksDto & { id: string }
  ) {
    this.assertCanManage(role);
    await this.getOwnedWebhookOrThrow(orgId, body.id);
    const safeBody = await this.validateBody(orgId, body);
    return this._webhooksRepository.updateWebhook(orgId, body.id, safeBody);
  }

  async deleteWebhook(orgId: string, role: Role, id: string) {
    this.assertCanManage(role);
    await this.getOwnedWebhookOrThrow(orgId, id);
    return this._webhooksRepository.deleteWebhook(orgId, id);
  }

  async testWebhook(orgId: string, role: Role, id: string) {
    this.assertCanManage(role);
    const webhook = await this.getOwnedWebhookOrThrow(orgId, id);
    return webhookTransport.sendJson(webhook.url, WEBHOOK_TEST_PAYLOAD);
  }

  private assertCanManage(role: Role) {
    if (role !== Role.ADMIN && role !== Role.SUPERADMIN) {
      throw new ForbiddenException('Webhook management permission required');
    }
  }

  private async getOwnedWebhookOrThrow(orgId: string, id: string) {
    const webhook = await this._webhooksRepository.getWebhook(orgId, id);
    if (!webhook) throw new NotFoundException('Webhook not found');
    return webhook;
  }

  private async validateBody(orgId: string, body: WebhooksDto) {
    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeWebhookUrl(body.url);
      await resolveWebhookAddresses(new URL(normalizedUrl).hostname);
    } catch {
      throw new BadRequestException('Webhook URL must be a public HTTPS URL');
    }

    if (
      !Array.isArray(body.integrations) ||
      body.integrations.length > 100 ||
      body.integrations.some(
        (integration) =>
          !integration || typeof integration.id !== 'string' || !integration.id
      )
    ) {
      throw new BadRequestException('Invalid webhook integrations');
    }

    const integrationIds = [
      ...new Set(body.integrations.map((integration) => integration.id)),
    ];
    if (integrationIds.length) {
      const owned = await this._webhooksRepository.countOwnedIntegrations(
        orgId,
        integrationIds
      );
      if (owned !== integrationIds.length) {
        throw new BadRequestException(
          'Every webhook integration must belong to the organization'
        );
      }
    }

    return {
      ...body,
      url: normalizedUrl,
      integrations: integrationIds.map((id) => ({ id })),
    };
  }
}
