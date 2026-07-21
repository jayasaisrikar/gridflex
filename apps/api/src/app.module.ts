import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DatabaseModule } from './common/database/database.module.js';
import { AuthGuard } from './common/auth/auth.guard.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { HealthController } from './modules/health/health.controller.js';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [HealthController],
  providers: [
    // Global by default: every route requires authentication unless it opts out
    // with @Public(). Forgetting to protect a route is the likelier mistake.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
