import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { Organization, Role } from '@prisma/client';
import { ApiTags } from '@nestjs/swagger';
import { WebhooksService } from '@gitroom/nestjs-libraries/database/prisma/webhooks/webhooks.service';
import { CheckPolicies } from '@gitroom/backend/services/auth/permissions/permissions.ability';
import {
  UpdateDto,
  WebhooksDto,
  WebhookTestDto,
} from '@gitroom/nestjs-libraries/dtos/webhooks/webhooks.dto';
import {
  AuthorizationActions,
  Sections,
} from '@gitroom/backend/services/auth/permissions/permission.exception.class';

type OrganizationWithRole = Organization & {
  users: Array<{ role: Role }>;
};

function getRole(org: OrganizationWithRole): Role {
  return org.users?.[0]?.role || Role.USER;
}

@ApiTags('Webhooks')
@Controller('/webhooks')
export class WebhookController {
  constructor(private _webhooksService: WebhooksService) {}

  @Get('/')
  @CheckPolicies([AuthorizationActions.Read, Sections.ADMIN])
  async getStatistics(@GetOrgFromRequest() org: OrganizationWithRole) {
    return this._webhooksService.getWebhooksForManagement(org.id, getRole(org));
  }

  @Post('/')
  @CheckPolicies(
    [AuthorizationActions.Create, Sections.WEBHOOKS],
    [AuthorizationActions.Create, Sections.ADMIN]
  )
  async createAWebhook(
    @GetOrgFromRequest() org: OrganizationWithRole,
    @Body() body: WebhooksDto
  ) {
    return this._webhooksService.createWebhook(org.id, getRole(org), body);
  }

  @Put('/')
  @CheckPolicies([AuthorizationActions.Update, Sections.ADMIN])
  async updateWebhook(
    @GetOrgFromRequest() org: OrganizationWithRole,
    @Body() body: UpdateDto
  ) {
    return this._webhooksService.updateWebhook(org.id, getRole(org), body);
  }

  @Delete('/:id')
  @CheckPolicies([AuthorizationActions.Delete, Sections.ADMIN])
  async deleteWebhook(
    @GetOrgFromRequest() org: OrganizationWithRole,
    @Param('id') id: string
  ) {
    return this._webhooksService.deleteWebhook(org.id, getRole(org), id);
  }

  @Post('/send')
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  async sendWebhook(
    @GetOrgFromRequest() org: OrganizationWithRole,
    @Body() body: WebhookTestDto
  ) {
    const result = await this._webhooksService.testWebhook(
      org.id,
      getRole(org),
      body.id
    );
    return {
      send: result.ok,
      destination: result.destination,
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
    };
  }
}
