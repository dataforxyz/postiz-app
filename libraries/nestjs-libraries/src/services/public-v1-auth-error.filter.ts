import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import { Response } from 'express';
import { enrichHttpExceptionBody } from '@gitroom/nestjs-libraries/integrations/postiz-auth-contract';

@Catch(HttpException)
export class PublicV1AuthErrorFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request & { url?: string }>();
    const response = ctx.getResponse<Response>();
    const path = request?.url || '';

    if (!path.includes('/public/v1')) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      return response
        .status(status)
        .json(typeof body === 'string' ? { msg: body } : body);
    }

    const status = exception.getStatus();
    const raw = exception.getResponse();
    const integrationId =
      typeof request === 'object' &&
      request &&
      'params' in request &&
      (request as { params?: { id?: string } }).params?.id
        ? (request as { params?: { id?: string } }).params?.id
        : undefined;

    const enriched = enrichHttpExceptionBody(
      typeof raw === 'string' ? { msg: raw } : (raw as Record<string, unknown>),
      status,
      integrationId
    );

    return response.status(status).json(enriched);
  }
}
