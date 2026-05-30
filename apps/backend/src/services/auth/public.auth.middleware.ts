import { HttpStatus, Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { OAuthService } from '@gitroom/nestjs-libraries/database/prisma/oauth/oauth.service';
import { HttpForbiddenException } from '@gitroom/nestjs-libraries/services/exception.filter';
import { ApiTokenService } from '@gitroom/nestjs-libraries/database/prisma/api-tokens/api-token.service';
import { enrichHttpExceptionBody } from '@gitroom/nestjs-libraries/integrations/postiz-auth-contract';

@Injectable()
export class PublicAuthMiddleware implements NestMiddleware {
  constructor(
    private _organizationService: OrganizationService,
    private _oauthService: OAuthService,
    private _apiTokenService: ApiTokenService
  ) {}
  async use(req: Request, res: Response, next: NextFunction) {
    const auth = (req.headers.authorization ||
      req.headers.Authorization) as string;
    if (!auth) {
      res
        .status(HttpStatus.UNAUTHORIZED)
        .json(
          enrichHttpExceptionBody(
            { msg: 'No API Key found' },
            HttpStatus.UNAUTHORIZED
          )
        );
      return;
    }
    try {
      if (auth.startsWith('pos_')) {
        const authorization = await this._oauthService.getOrgByOAuthToken(auth);
        if (!authorization) {
          res
            .status(HttpStatus.UNAUTHORIZED)
            .json(
              enrichHttpExceptionBody(
                { msg: 'Invalid OAuth token' },
                HttpStatus.UNAUTHORIZED
              )
            );
          return;
        }

        const org = authorization.organization;
        if (!!process.env.STRIPE_SECRET_KEY && !org.subscription) {
          res
            .status(HttpStatus.UNAUTHORIZED)
            .json({ msg: 'No subscription found' });
          return;
        }

        // @ts-ignore
        req.org = {
          ...org,
          users: [{ role: 'SUPERADMIN', users: { role: 'SUPERADMIN' } }],
        };
        // @ts-ignore
        req.tokenScopes = null;
      } else {
        const validatedToken = await this._apiTokenService.validateToken(auth);
        const org = validatedToken
          ? await this._organizationService.getOrgById(validatedToken.orgId)
          : await this._organizationService.getOrgByApiKey(auth);
        if (!org) {
          res
            .status(HttpStatus.UNAUTHORIZED)
            .json(
              enrichHttpExceptionBody(
                { msg: 'Invalid API key' },
                HttpStatus.UNAUTHORIZED
              )
            );
          return;
        }

        if (!!process.env.STRIPE_SECRET_KEY && !org.subscription) {
          res
            .status(HttpStatus.UNAUTHORIZED)
            .json({ msg: 'No subscription found' });
          return;
        }

        // @ts-ignore
        req.org = {
          ...org,
          users: [{ role: 'SUPERADMIN', users: { role: 'SUPERADMIN' } }],
        };
        // @ts-ignore
        req.tokenScopes = validatedToken
          ? {
              permissions: validatedToken.permissions,
              integrationIds: validatedToken.integrationIds,
            }
          : null;
      }
    } catch (err) {
      throw new HttpForbiddenException();
    }
    next();
  }
}
