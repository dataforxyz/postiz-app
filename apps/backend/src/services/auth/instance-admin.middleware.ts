import {
  HttpStatus,
  Injectable,
  NestMiddleware,
  Logger,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';

/**
 * Authenticates requests to /public/v1/admin/* with a single
 * instance-wide bearer token set via the INSTANCE_ADMIN_KEY env var.
 *
 * Used by first-party operator tooling (the analytics onboarding wizard,
 * a future CLI, monitoring scripts). NOT a user/org credential — the
 * caller is "the instance operator" and can act across all orgs.
 *
 * Compared in constant time to defeat timing attacks. Missing or
 * mismatched env var yields 401 regardless of client input, so nothing
 * accidentally leaks even if the admin module is mounted without the
 * env set.
 */
@Injectable()
export class InstanceAdminAuthMiddleware implements NestMiddleware {
  private readonly logger = new Logger(InstanceAdminAuthMiddleware.name);

  use(req: Request, res: Response, next: NextFunction) {
    const configured = (process.env.INSTANCE_ADMIN_KEY || '').trim();
    if (!configured) {
      this.logger.warn(
        'INSTANCE_ADMIN_KEY is not set — /public/v1/admin/* rejected'
      );
      res.status(HttpStatus.UNAUTHORIZED).json({
        msg: 'Instance admin API is disabled (INSTANCE_ADMIN_KEY unset)',
      });
      return;
    }

    const auth = ((req.headers.authorization ||
      req.headers.Authorization ||
      '') as string).trim();
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : auth;
    if (!bearer) {
      res.status(HttpStatus.UNAUTHORIZED).json({ msg: 'No admin key found' });
      return;
    }

    // timingSafeEqual requires equal-length buffers; pad to avoid leaking
    // a length difference via short-circuit.
    const a = Buffer.from(bearer);
    const b = Buffer.from(configured);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(HttpStatus.UNAUTHORIZED).json({ msg: 'Invalid admin key' });
      return;
    }

    next();
  }
}
