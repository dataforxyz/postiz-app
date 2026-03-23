import { randomBytes, createHash } from 'crypto';
import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ApiTokenRepository } from './api-token.repository';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';

export type TokenPermission = 'read' | 'write';

export type ValidatedApiToken = {
  id: string;
  orgId: string;
  permissions: TokenPermission[];
  integrationIds: string[] | null;
};

@Injectable()
export class ApiTokenService {
  constructor(
    private _apiTokenRepository: ApiTokenRepository,
    @Inject(forwardRef(() => IntegrationService))
    private _integrationService: IntegrationService
  ) {}

  private hashToken(rawToken: string) {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  private generateToken() {
    return `pst_${randomBytes(24).toString('hex')}`;
  }

  private validatePermissions(permissions: string[]): TokenPermission[] {
    const unique = Array.from(new Set(permissions || []));
    if (!unique.length) {
      throw new BadRequestException('At least one permission is required');
    }

    if (unique.some((permission) => !['read', 'write'].includes(permission))) {
      throw new BadRequestException('Invalid token permissions');
    }

    return unique as TokenPermission[];
  }

  private async validateIntegrationScope(
    orgId: string,
    integrationIds?: string[] | null
  ) {
    const uniqueIds = Array.from(new Set((integrationIds || []).filter(Boolean)));
    if (!uniqueIds.length) {
      return [];
    }

    const integrations = await this._integrationService.getIntegrationsList(
      orgId,
      uniqueIds
    );

    if (integrations.length !== uniqueIds.length) {
      throw new BadRequestException('One or more integrations are invalid');
    }

    return uniqueIds;
  }

  async createToken(
    orgId: string,
    name: string,
    permissions: string[],
    integrationIds?: string[] | null
  ) {
    if (!name?.trim()) {
      throw new BadRequestException('Token name is required');
    }

    const rawToken = this.generateToken();
    const normalizedPermissions = this.validatePermissions(permissions);
    const scopedIntegrationIds = await this.validateIntegrationScope(
      orgId,
      integrationIds
    );

    const token = await this._apiTokenRepository.createToken({
      name: name.trim(),
      tokenHash: this.hashToken(rawToken),
      permissions: normalizedPermissions,
      organizationId: orgId,
      integrationIds: scopedIntegrationIds,
    });

    return {
      id: token.id,
      token: rawToken,
    };
  }

  async revokeToken(orgId: string, tokenId: string) {
    const updated = await this._apiTokenRepository.revokeToken(orgId, tokenId);
    if (!updated.count) {
      throw new NotFoundException('API token not found');
    }

    return { success: true };
  }

  async listTokens(orgId: string) {
    const tokens = await this._apiTokenRepository.listTokens(orgId);
    return tokens.map(({ tokenHash, scopes, ...token }) => ({
      ...token,
      integrationIds: scopes.length ? scopes.map((scope) => scope.integrationId) : null,
      scopes: scopes.map((scope) => scope.integration),
    }));
  }

  async validateToken(rawToken: string): Promise<ValidatedApiToken | null> {
    const token = await this._apiTokenRepository.findTokenByHash(
      this.hashToken(rawToken)
    );

    if (!token) {
      return null;
    }

    await this._apiTokenRepository.updateLastUsedAt(token.id);

    return {
      id: token.id,
      orgId: token.organizationId,
      permissions: token.permissions as TokenPermission[],
      integrationIds: token.scopes.length
        ? token.scopes.map((scope) => scope.integrationId)
        : null,
    };
  }

  async rotateToken(orgId: string, tokenId: string) {
    const current = await this._apiTokenRepository.getTokenById(orgId, tokenId);
    if (!current) {
      throw new NotFoundException('API token not found');
    }

    const rawToken = this.generateToken();
    await this._apiTokenRepository.replaceToken(orgId, tokenId, {
      tokenHash: this.hashToken(rawToken),
    });

    return { token: rawToken };
  }
}
