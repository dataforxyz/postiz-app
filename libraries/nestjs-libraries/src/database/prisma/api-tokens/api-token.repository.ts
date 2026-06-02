import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

@Injectable()
export class ApiTokenRepository {
  constructor(
    private _apiToken: PrismaRepository<'apiToken'>
  ) {}

  createToken(data: {
    name: string;
    tokenHash: string;
    permissions: string[];
    organizationId: string;
    integrationIds?: string[];
  }) {
    return this._apiToken.model.apiToken.create({
      data: {
        name: data.name,
        tokenHash: data.tokenHash,
        permissions: data.permissions,
        organizationId: data.organizationId,
        ...(data.integrationIds?.length
          ? {
              scopes: {
                create: data.integrationIds.map((integrationId) => ({
                  integrationId,
                })),
              },
            }
          : {}),
      },
      include: {
        scopes: true,
      },
    });
  }

  listTokens(organizationId: string) {
    return this._apiToken.model.apiToken.findMany({
      where: {
        organizationId,
      },
      include: {
        scopes: {
          include: {
            integration: {
              select: {
                id: true,
                name: true,
                providerIdentifier: true,
                picture: true,
              },
            },
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  findTokenByHash(tokenHash: string) {
    return this._apiToken.model.apiToken.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
      },
      include: {
        scopes: true,
      },
    });
  }

  updateLastUsedAt(id: string) {
    return this._apiToken.model.apiToken.update({
      where: {
        id,
      },
      data: {
        lastUsedAt: new Date(),
      },
    });
  }

  revokeToken(organizationId: string, id: string) {
    return this._apiToken.model.apiToken.updateMany({
      where: {
        id,
        organizationId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
  }

  getTokenById(organizationId: string, id: string) {
    return this._apiToken.model.apiToken.findFirst({
      where: {
        id,
        organizationId,
      },
      include: {
        scopes: true,
      },
    });
  }

  async replaceToken(
    _organizationId: string,
    id: string,
    data: {
      tokenHash: string;
    }
  ) {
    return this._apiToken.model.apiToken.update({
      where: {
        id,
      },
      data: {
        tokenHash: data.tokenHash,
        revokedAt: null,
        lastUsedAt: null,
      },
      include: {
        scopes: true,
      },
    });
  }
}
