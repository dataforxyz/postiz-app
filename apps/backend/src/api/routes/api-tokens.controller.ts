import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { Organization } from '@prisma/client';
import { ApiTokenService } from '@gitroom/nestjs-libraries/database/prisma/api-tokens/api-token.service';
import { CheckPolicies } from '@gitroom/backend/services/auth/permissions/permissions.ability';
import {
  AuthorizationActions,
  Sections,
} from '@gitroom/backend/services/auth/permissions/permission.exception.class';

@ApiTags('API Tokens')
@Controller('/api/tokens')
@CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
export class ApiTokensController {
  constructor(private _apiTokenService: ApiTokenService) {}

  @Get()
  async list(@GetOrgFromRequest() org: Organization) {
    return {
      tokens: await this._apiTokenService.listTokens(org.id),
    };
  }

  @Post()
  async create(
    @GetOrgFromRequest() org: Organization,
    @Body()
    body: {
      name: string;
      permissions: string[];
      integrationIds?: string[] | null;
      allIntegrations?: boolean;
    }
  ) {
    const token = await this._apiTokenService.createToken(
      org.id,
      body.name,
      body.permissions,
      body.allIntegrations ? null : body.integrationIds
    );

    return {
      ...token,
    };
  }

  @Delete('/:id')
  async revoke(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._apiTokenService.revokeToken(org.id, id);
  }
}
