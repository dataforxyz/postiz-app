import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Param,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { Organization } from '@prisma/client';
import { State } from '@prisma/client';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { CheckPolicies } from '@gitroom/backend/services/auth/permissions/permissions.ability';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { GetPostsDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts.dto';
import {
  AuthorizationActions,
  Sections,
} from '@gitroom/backend/services/auth/permissions/permission.exception.class';
import { VideoDto } from '@gitroom/nestjs-libraries/dtos/videos/video.dto';
import { VideoFunctionDto } from '@gitroom/nestjs-libraries/dtos/videos/video.function.dto';
import { UploadDto } from '@gitroom/nestjs-libraries/dtos/media/upload.dto';
import { NotificationService } from '@gitroom/nestjs-libraries/database/prisma/notifications/notification.service';
import { GetNotificationsDto } from '@gitroom/nestjs-libraries/dtos/notifications/get.notifications.dto';
import axios from 'axios';
import { Readable } from 'stream';
import { lookup, extension } from 'mime-types';
import * as Sentry from '@sentry/nestjs';
import { socialIntegrationList, IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { getValidationSchemas } from '@gitroom/nestjs-libraries/chat/validation.schemas.helper';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { RefreshToken } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { timer } from '@gitroom/helpers/utils/timer';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import {
  RequiresTokenPermission,
  ScopeGuard,
} from '@gitroom/backend/services/auth/permissions/scope.guard';
import { getAllowedIntegrationIds } from '@gitroom/backend/services/auth/token-scopes';
import { Request } from 'express';

@ApiTags('Public API')
@Controller('/public/v1')
@UseGuards(ScopeGuard)
export class PublicIntegrationsController {
  private storage = UploadFactory.createStorage();

  constructor(
    private _integrationService: IntegrationService,
    private _postsService: PostsService,
    private _mediaService: MediaService,
    private _notificationService: NotificationService,
    private _integrationManager: IntegrationManager,
    private _refreshIntegrationService: RefreshIntegrationService
  ) {}

  @Post('/upload')
  @RequiresTokenPermission('write')
  @UseInterceptors(FileInterceptor('file'))
  async uploadSimple(
    @GetOrgFromRequest() org: Organization,
    @UploadedFile('file') file: Express.Multer.File
  ) {
    Sentry.metrics.count('public_api-request', 1);
    if (!file) {
      throw new HttpException({ msg: 'No file provided' }, 400);
    }

    const getFile = await this.storage.uploadFile(file);
    return this._mediaService.saveFile(
      org.id,
      getFile.originalname,
      getFile.path
    );
  }

  @Post('/upload-from-url')
  @RequiresTokenPermission('write')
  async uploadsFromUrl(
    @GetOrgFromRequest() org: Organization,
    @Body() body: UploadDto
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const response = await axios.get(body.url, {
      responseType: 'arraybuffer',
    });

    const buffer = Buffer.from(response.data);
    const responseMime = response.headers?.['content-type']?.split(';')[0]?.trim();
    const urlMime = lookup(body?.url?.split?.('?')?.[0]);
    const mimetype = (urlMime || responseMime || 'image/jpeg') as string;
    const ext = extension(mimetype) || 'jpg';

    const getFile = await this.storage.uploadFile({
      buffer,
      mimetype,
      size: buffer.length,
      path: '',
      fieldname: '',
      destination: '',
      stream: new Readable(),
      filename: '',
      originalname: `upload.${ext}`,
      encoding: '',
    });

    return this._mediaService.saveFile(
      org.id,
      getFile.originalname,
      getFile.path
    );
  }

  @Get('/find-slot/:id')
  @RequiresTokenPermission('read')
  async findSlotIntegration(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Req() req?: Request
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return {
      date: await this._postsService.findFreeDateTime(
        org.id,
        id,
        getAllowedIntegrationIds(req as any)
      ),
    };
  }

  @Get('/posts')
  @RequiresTokenPermission('read')
  async getPosts(
    @GetOrgFromRequest() org: Organization,
    @Query() query: GetPostsDto,
    @Req() req: Request
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const posts = await this._postsService.getPosts(
      org.id,
      query,
      getAllowedIntegrationIds(req as any)
    );
    return {
      posts,
      // comments,
    };
  }

  @Post('/posts')
  @RequiresTokenPermission('write')
  @CheckPolicies([AuthorizationActions.Create, Sections.POSTS_PER_MONTH])
  async createPost(
    @GetOrgFromRequest() org: Organization,
    @Body() rawBody: any,
    @Req() req: Request
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const body = await this._postsService.mapTypeToPost(
      rawBody,
      org.id,
      rawBody.type === 'draft',
      getAllowedIntegrationIds(req as any)
    );
    body.type = rawBody.type;

    console.log(JSON.stringify(body, null, 2));
    return this._postsService.createPost(
      org.id,
      body,
      getAllowedIntegrationIds(req as any)
    );
  }

  @Delete('/posts/:id')
  @RequiresTokenPermission('write')
  async deletePost(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Req() req: Request
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const allowedIds = getAllowedIntegrationIds(req as any);
    const getPostById = await this._postsService.getPost(
      org.id,
      id,
      false,
      allowedIds
    );
    return this._postsService.deletePost(org.id, getPostById.group, allowedIds);
  }

  @Delete('/posts/group/:group')
  @RequiresTokenPermission('write')
  deletePostByGroup(
    @GetOrgFromRequest() org: Organization,
    @Param('group') group: string,
    @Req() req: Request
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._postsService.deletePost(
      org.id,
      group,
      getAllowedIntegrationIds(req as any)
    );
  }

  @Get('/is-connected')
  @RequiresTokenPermission('read')
  async getActiveIntegrations(@GetOrgFromRequest() org: Organization) {
    Sentry.metrics.count('public_api-request', 1);
    return { connected: true };
  }

  @Get('/integrations')
  @RequiresTokenPermission('read')
  async listIntegration(
    @GetOrgFromRequest() org: Organization,
    @Req() req: Request
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return (
      await this._integrationService.getIntegrationsList(
        org.id,
        getAllowedIntegrationIds(req as any)
      )
    ).map((org) => ({
      id: org.id,
      name: org.name,
      identifier: org.providerIdentifier,
      picture: org.picture,
      disabled: org.disabled,
      profile: org.profile,
      customer: org.customer
          ? {
              id: org.customer.id,
              name: org.customer.name,
            }
      : undefined,
    }));
  }

  @Get('/internal/integrations')
  @RequiresTokenPermission('read')
  async listInternalIntegrations(
    @GetOrgFromRequest() org: Organization,
    @Req() req: Request
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const integrations = await this._integrationService.getInternalIntegrationsList(
      org.id,
      getAllowedIntegrationIds(req as any)
    );

    return {
      integrations: integrations.map((integration) => ({
        id: integration.id,
        name: integration.name,
        provider: integration.providerIdentifier,
        token: integration.token,
        refreshToken: integration.refreshToken,
        internalId: integration.internalId,
        profile: integration.profile,
        picture: integration.picture,
        disabled: integration.disabled,
        customer: integration.customer,
      })),
    };
  }

  @Get('/internal/posts/status')
  @RequiresTokenPermission('read')
  async getInternalPostsStatus(
    @GetOrgFromRequest() org: Organization,
    @Query('ids') ids: string,
    @Req() req: Request
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const postIds = (ids || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    return {
      posts: await this._postsService.getInternalPostsByIds(
        org.id,
        postIds,
        getAllowedIntegrationIds(req as any)
      ),
    };
  }

  @Get('/internal/posts/by-integration-window')
  @RequiresTokenPermission('read')
  async getInternalPostsByIntegrationWindow(
    @GetOrgFromRequest() org: Organization,
    @Query('integrationIds') integrationIds: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('states') states: string,
    @Query('limit') limit: string,
    @Req() req: Request
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const parsedIntegrationIds = (integrationIds || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    const parsedStates = (states || '')
      .split(',')
      .map((state) => state.trim())
      .filter(Boolean) as State[];
    const parsedLimit = limit ? +limit : undefined;

    return {
      posts: await this._postsService.getInternalPostsByIntegrationWindow(
        org.id,
        parsedIntegrationIds,
        {
          startDate,
          endDate,
          states: parsedStates,
          limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
        },
        getAllowedIntegrationIds(req as any)
      ),
    };
  }

  @Get('/internal/posts/history')
  @RequiresTokenPermission('read')
  async getInternalPostsHistory(
    @GetOrgFromRequest() org: Organization,
    @Query('integrationIds') integrationIds: string,
    @Query('since') since: string,
    @Query('until') until: string,
    @Query('limit') limit: string,
    @Req() req: Request
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const parsedIntegrationIds = (integrationIds || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    const parsedLimit = limit ? +limit : 1000;

    return {
      posts: await this._postsService.getInternalPostsByIntegrationWindow(
        org.id,
        parsedIntegrationIds,
        {
          startDate: since,
          endDate: until,
          states: ['PUBLISHED'],
          limit:
            Number.isFinite(parsedLimit) && parsedLimit > 0
              ? Math.min(parsedLimit, 5000)
              : 1000,
        },
        getAllowedIntegrationIds(req as any)
      ),
    };
  }

  @Get('/social/:integration')
  @RequiresTokenPermission('write')
  @CheckPolicies([AuthorizationActions.Create, Sections.CHANNEL])
  async getIntegrationUrl(
    @Param('integration') integration: string,
    @Query('refresh') refresh: string,
    @GetOrgFromRequest() org: Organization
  ) {
    Sentry.metrics.count('public_api-request', 1);
    if (
      !this._integrationManager
        .getAllowedSocialsIntegrations()
        .includes(integration)
    ) {
      throw new HttpException({ msg: 'Integration not allowed' }, 400);
    }

    const integrationProvider =
      this._integrationManager.getSocialIntegration(integration);

    if (integrationProvider.externalUrl) {
      throw new HttpException(
        { msg: 'This integration requires an external URL and is not supported via the public API' },
        400
      );
    }

    try {
      const { codeVerifier, state, url } =
        await integrationProvider.generateAuthUrl();

      if (refresh) {
        await ioRedis.set(`refresh:${state}`, refresh, 'EX', 3600);
      }

      await ioRedis.set(`organization:${state}`, org.id, 'EX', 3600);
      await ioRedis.set(`login:${state}`, codeVerifier, 'EX', 3600);

      return { url };
    } catch (err) {
      throw new HttpException({ msg: 'Failed to generate auth URL' }, 500);
    }
  }

  @Get('/notifications')
  @RequiresTokenPermission('read')
  async getNotifications(
    @GetOrgFromRequest() org: Organization,
    @Query() query: GetNotificationsDto
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._notificationService.getNotificationsPaginated(
      org.id,
      query.page ?? 0
    );
  }

  @Post('/generate-video')
  @RequiresTokenPermission('write')
  generateVideo(
    @GetOrgFromRequest() org: Organization,
    @Body() body: VideoDto
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._mediaService.generateVideo(org, body);
  }

  @Post('/video/function')
  @RequiresTokenPermission('read')
  videoFunction(@Body() body: VideoFunctionDto) {
    Sentry.metrics.count('public_api-request', 1);
    return this._mediaService.videoFunction(
      body.identifier,
      body.functionName,
      body.params
    );
  }

  @Delete('/integrations/:id')
  @RequiresTokenPermission('write')
  async deleteChannel(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Req() req: Request
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const allowedIds = getAllowedIntegrationIds(req as any);
    const isTherePosts = await this._integrationService.getPostsForChannel(
      org.id,
      id,
      allowedIds
    );
    if (isTherePosts.length) {
      for (const post of isTherePosts) {
        this._postsService.deletePost(org.id, post.group, allowedIds).catch(() => {});
      }
    }

    return this._integrationService.deleteChannel(org.id, id, allowedIds);
  }

  @Get('/integration-settings/:id')
  @RequiresTokenPermission('read')
  async getIntegrationSettings(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Req() req: Request
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const loadIntegration = await this._integrationService.getIntegrationById(
      org.id,
      id,
      getAllowedIntegrationIds(req as any)
    );

    const verified =
      JSON.parse(loadIntegration.additionalSettings || '[]')?.find(
        (p: any) => p?.title === 'Verified'
      )?.value || false;

    const integration = socialIntegrationList.find(
      (p) => p.identifier === loadIntegration.providerIdentifier
    )!;

    if (!integration) {
      return {
        output: { rules: '', maxLength: 0, settings: {}, tools: [] as any[] },
      };
    }

    const maxLength = integration.maxLength(verified);
    const schemas = !integration.dto
      ? false
      : getValidationSchemas()[integration.dto.name];
    const tools = this._integrationManager.getAllTools();
    const rules = this._integrationManager.getAllRulesDescription();

    return {
      output: {
        rules: rules[integration.identifier],
        maxLength,
        settings: !schemas ? 'No additional settings required' : schemas,
        tools: tools[integration.identifier],
      },
    };
  }

  @Get('/posts/:id/missing')
  @RequiresTokenPermission('read')
  async getMissingContent(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Req() req: Request
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._postsService.getMissingContent(
      org.id,
      id,
      false,
      getAllowedIntegrationIds(req as any)
    );
  }

  @Put('/posts/:id/release-id')
  @RequiresTokenPermission('write')
  async updateReleaseId(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body('releaseId') releaseId: string,
    @Req() req: Request
  ) {
    Sentry.metrics.count('public_api-request', 1);
    await this._postsService.getPost(
      org.id,
      id,
      false,
      getAllowedIntegrationIds(req as any)
    );
    return this._postsService.updateReleaseId(org.id, id, releaseId);
  }

  @Get('/analytics/:integration')
  @RequiresTokenPermission('read')
  async getAnalytics(
    @GetOrgFromRequest() org: Organization,
    @Param('integration') integration: string,
    @Query('date') date: string,
    @Req() req: Request
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._integrationService.checkAnalytics(
      org,
      integration,
      date,
      false,
      getAllowedIntegrationIds(req as any)
    );
  }

  @Get('/analytics/post/:postId')
  @RequiresTokenPermission('read')
  async getPostAnalytics(
    @GetOrgFromRequest() org: Organization,
    @Param('postId') postId: string,
    @Query('date') date: string,
    @Req() req: Request
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._postsService.checkPostAnalytics(
      org.id,
      postId,
      +date,
      false,
      getAllowedIntegrationIds(req as any)
    );
  }

  @Post('/integration-trigger/:id')
  @RequiresTokenPermission('read')
  async triggerIntegrationTool(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: { methodName: string; data: Record<string, string> },
    @Req() req: Request
  ) {
    Sentry.metrics.count('public_api-request', 1);
    const getIntegration = await this._integrationService.getIntegrationById(
      org.id,
      id,
      getAllowedIntegrationIds(req as any)
    );

    if (!getIntegration) {
      throw new HttpException({ msg: 'Integration not found' }, 404);
    }

    const integrationProvider = socialIntegrationList.find(
      (p) => p.identifier === getIntegration.providerIdentifier
    )!;

    if (!integrationProvider) {
      throw new HttpException({ msg: 'Integration provider not found' }, 404);
    }

    const tools = this._integrationManager.getAllTools();
    if (
      // @ts-ignore
      !tools[integrationProvider.identifier]?.some(
        (p: any) => p.methodName === body.methodName
      ) ||
      // @ts-ignore
      !integrationProvider[body.methodName]
    ) {
      throw new HttpException({ msg: 'Tool not found' }, 404);
    }

    while (true) {
      try {
        // @ts-ignore
        const result = await integrationProvider[body.methodName](
          getIntegration.token,
          body.data || {},
          getIntegration.internalId,
          getIntegration
        );

        return { output: result };
      } catch (err) {
        if (err instanceof RefreshToken) {
          const data = await this._refreshIntegrationService.refresh(
            getIntegration
          );

          if (!data) {
            await this._integrationService.disconnectChannel(
              org.id,
              getIntegration
            );
            throw new HttpException(
              { msg: 'Channel disconnected due to expired token' },
              401
            );
          }

          const { accessToken } = data;

          if (accessToken) {
            getIntegration.token = accessToken;

            if (integrationProvider.refreshWait) {
              await timer(10000);
            }

            continue;
          }
        }
        throw new HttpException({ msg: 'Unexpected error' }, 500);
      }
    }
  }
}
