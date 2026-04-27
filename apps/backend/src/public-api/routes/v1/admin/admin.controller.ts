import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Logger,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { ApiTokenService } from '@gitroom/nestjs-libraries/database/prisma/api-tokens/api-token.service';
import {
  IntegrationManager,
  socialIntegrationList,
} from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { IntegrationCapabilities } from '@gitroom/nestjs-libraries/integrations/social/social.integrations.capabilities';

/**
 * Instance-admin API for operator tooling. Mounted at /public/v1/admin.
 *
 * Authenticated by `InstanceAdminAuthMiddleware` (bearer against
 * INSTANCE_ADMIN_KEY env var). Callers act across all orgs; no user
 * context is resolved.
 *
 * Motivation: the shorts-analytics onboarding wizard needs to create
 * orgs, mint scoped API tokens, and invite users without the
 * /enterprise/* path's email mangling + ULTIMATE subscription side
 * effects, and without the /settings/team cookie-auth + invite-URL
 * dance. See shorts-analytics issue #16 + #17 for the full motivation.
 */
@ApiTags('Instance Admin')
@Controller('/admin')
export class AdminController {
  private readonly logger = new Logger(AdminController.name);

  constructor(
    private _orgService: OrganizationService,
    private _apiTokenService: ApiTokenService,
    private _integrationManager: IntegrationManager
  ) {}

  /**
   * Returns the static posting-capability shape for every registered
   * social provider. Read by juston-app to drive compose-time validation
   * (text length, media kinds, video duration caps) without hard-coding.
   *
   * Pulled directly from each provider's `capabilities()` method so the
   * source of truth lives next to the posting code. No env / version /
   * hostname leaks — only the static shape.
   */
  @Get('/capabilities')
  capabilities(): Record<string, IntegrationCapabilities> {
    return socialIntegrationList.reduce<
      Record<string, IntegrationCapabilities>
    >((acc, provider) => {
      const cap = provider.capabilities();
      acc[cap.identifier] = cap;
      return acc;
    }, {});
  }

  @Get('/capabilities/:identifier')
  capability(@Param('identifier') identifier: string): IntegrationCapabilities {
    const provider = socialIntegrationList.find(
      (p) => p.capabilities().identifier === identifier
    );
    if (!provider) {
      throw new NotFoundException(`Unknown provider: ${identifier}`);
    }
    return provider.capabilities();
  }

  @Post('/orgs')
  async createOrg(
    @Body()
    body: {
      name?: string;
      ownerEmail?: string;
      ownerPassword?: string;
    }
  ) {
    const name = (body.name || '').trim();
    const email = (body.ownerEmail || '').trim().toLowerCase();
    if (!name || !email) {
      throw new BadRequestException('name and ownerEmail are required');
    }

    const result = await this._orgService.adminCreateOrgAndOwner(
      name,
      email,
      body.ownerPassword
    );

    this.logger.log(
      `adminCreateOrg name='${name}' email='${email}' -> org ${result.id}`
    );

    return {
      id: result.id,
      apiKey: result.apiKey,
      ownerUserId: result.users?.[0]?.userId,
    };
  }

  @Get('/orgs')
  async listOrgs() {
    const orgs = await this._orgService.adminListOrgs();
    return orgs.map((o) => ({
      id: o.id,
      name: o.name,
      createdAt: o.createdAt,
      userCount: o._count?.users ?? 0,
      integrationCount: o._count?.Integration ?? 0,
    }));
  }

  @Delete('/orgs/:id')
  @HttpCode(204)
  async deleteOrg(@Param('id') id: string) {
    try {
      await this._orgService.adminDeleteOrg(id);
    } catch (err: any) {
      if (err?.code === 'P2025') {
        throw new NotFoundException('Organization not found');
      }
      throw err;
    }
    return;
  }

  @Patch('/orgs/:id')
  async updateOrg(
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      description?: string;
    }
  ) {
    const updates: { name?: string; description?: string } = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;

    if (Object.keys(updates).length === 0) {
      throw new BadRequestException('at least one field required');
    }

    try {
      const org = await this._orgService.adminUpdateOrg(id, updates);
      return org;
    } catch (err: any) {
      if (err?.code === 'P2025') {
        throw new NotFoundException('Organization not found');
      }
      throw err;
    }
  }

  @Post('/orgs/:id/users')
  async addUserToOrg(
    @Param('id') orgId: string,
    @Body()
    body: {
      email?: string;
      role?: 'USER' | 'ADMIN';
      password?: string;
    }
  ) {
    const email = (body.email || '').trim().toLowerCase();
    const role = body.role || 'USER';
    if (!email) {
      throw new BadRequestException('email is required');
    }
    if (role !== 'USER' && role !== 'ADMIN') {
      throw new BadRequestException('role must be USER or ADMIN');
    }

    // Verify the org exists — cleaner 404 than letting the FK error
    // surface from deep in Prisma.
    const existing = await this._orgService.getOrgById(orgId);
    if (!existing) throw new NotFoundException('Organization not found');

    const result = await this._orgService.adminAddUserToOrg(
      orgId,
      email,
      role,
      body.password
    );
    return result;
  }

  @Post('/orgs/:id/api-tokens')
  async mintApiToken(
    @Param('id') orgId: string,
    @Body()
    body: {
      name?: string;
      permissions?: string[];
      integrationIds?: string[] | null;
    }
  ) {
    const existing = await this._orgService.getOrgById(orgId);
    if (!existing) throw new NotFoundException('Organization not found');

    const name = (body.name || '').trim();
    if (!name) {
      throw new BadRequestException('name is required');
    }

    const result = await this._apiTokenService.createToken(
      orgId,
      name,
      body.permissions || ['read', 'write'],
      body.integrationIds ?? null
    );
    return result;
  }
}
