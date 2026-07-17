import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { WebhooksDto } from '@gitroom/nestjs-libraries/dtos/webhooks/webhooks.dto';

@Injectable()
export class WebhooksRepository {
  constructor(
    private _webhooks: PrismaRepository<'webhooks' | 'integration'>
  ) {}

  getTotal(orgId: string) {
    return this._webhooks.model.webhooks.count({
      where: {
        organizationId: orgId,
        deletedAt: null,
      },
    });
  }

  getWebhooks(orgId: string) {
    return this._webhooks.model.webhooks.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
      },
      include: {
        integrations: {
          select: {
            integration: {
              select: {
                id: true,
                picture: true,
                name: true,
              },
            },
          },
        },
      },
    });
  }

  getWebhook(orgId: string, id: string) {
    return this._webhooks.model.webhooks.findFirst({
      where: {
        id,
        organizationId: orgId,
        deletedAt: null,
      },
      include: {
        integrations: {
          select: {
            integration: {
              select: {
                id: true,
                picture: true,
                name: true,
              },
            },
          },
        },
      },
    });
  }

  countOwnedIntegrations(orgId: string, integrationIds: string[]) {
    return this._webhooks.model.integration.count({
      where: {
        id: { in: integrationIds },
        organizationId: orgId,
        deletedAt: null,
      },
    });
  }

  async createWebhook(orgId: string, body: WebhooksDto) {
    const webhook = await this._webhooks.model.webhooks.create({
      data: {
        organizationId: orgId,
        url: body.url,
        name: body.name,
        integrations: {
          create: body.integrations.map((integration) => ({
            integrationId: integration.id,
          })),
        },
      },
      select: { id: true },
    });

    return webhook;
  }

  async updateWebhook(orgId: string, id: string, body: WebhooksDto) {
    return this._webhooks.model.webhooks.update({
      where: {
        id,
        organizationId: orgId,
        deletedAt: null,
      },
      data: {
        url: body.url,
        name: body.name,
        integrations: {
          deleteMany: {},
          create: body.integrations.map((integration) => ({
            integrationId: integration.id,
          })),
        },
      },
      select: { id: true },
    });
  }

  deleteWebhook(orgId: string, id: string) {
    return this._webhooks.model.webhooks.update({
      where: {
        id,
        organizationId: orgId,
        deletedAt: null,
      },
      data: {
        deletedAt: new Date(),
      },
      select: { id: true },
    });
  }
}
