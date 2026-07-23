import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DatabaseModule } from './common/database/database.module.js';
import { AuthGuard } from './common/auth/auth.guard.js';
import { OrgScopeService } from './common/auth/org-scope.service.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { HealthController } from './modules/health/health.controller.js';
import { FacilitiesController } from './modules/facilities/facilities.controller.js';
import { TelemetryController } from './modules/telemetry/telemetry.controller.js';
import { EnvelopesController } from './modules/envelopes/envelopes.controller.js';
import { PassportsController } from './modules/passports/passports.controller.js';
import { DrillsController } from './modules/drills/drills.controller.js';
import { ConnectorsController } from './modules/connectors/connectors.controller.js';
import { AuditController } from './modules/audit/audit.controller.js';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [
    HealthController,
    FacilitiesController,
    TelemetryController,
    EnvelopesController,
    PassportsController,
    DrillsController,
    ConnectorsController,
    AuditController,
  ],
  providers: [
    OrgScopeService,
    // Global by default: every route requires authentication unless it opts out
    // with @Public(). Forgetting to protect a route is the likelier mistake.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
