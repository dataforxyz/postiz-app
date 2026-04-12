import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AdminController } from '@gitroom/backend/public-api/routes/v1/admin/admin.controller';
import { InstanceAdminAuthMiddleware } from '@gitroom/backend/services/auth/instance-admin.middleware';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';

/**
 * Mounts /public/v1/admin/* behind an INSTANCE_ADMIN_KEY bearer check.
 *
 * Keep this module dependency-light — the goal is that operator tooling
 * can call these routes from the outside world with a single shared
 * secret, not via user sessions or cookies. No PoliciesGuard /
 * PermissionsService / StripeService etc. since those are per-org
 * concerns.
 */
@Module({
  imports: [],
  controllers: [AdminController],
  providers: [IntegrationManager],
})
export class AdminApiModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(InstanceAdminAuthMiddleware).forRoutes(AdminController);
  }
}
