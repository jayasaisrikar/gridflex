import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { schema } from '@gridflex/db/client';
import type { Database } from '@gridflex/db/client';
import {
  DomainError,
  createConnectorRequestSchema,
  updateConnectorRequestSchema,
  uuidSchema,
  type CreateConnectorRequest,
  type UpdateConnectorRequest,
} from '@gridflex/contracts';
import { CurrentUserId } from '../../common/auth/auth.guard.js';
import { DATABASE } from '../../common/database/database.module.js';
import { OrgScopeService } from '../../common/auth/org-scope.service.js';
import { ZodValidationPipe, zodBody } from '../../common/pipes/zod-validation.pipe.js';
import { toRfc3339 } from '../facilities/facilities.controller.js';
import {
  decryptConnectorConfiguration,
  encryptConnectorConfiguration,
  summarizeConnectorConfiguration,
} from './connector-crypto.js';

const MVP_CONNECTOR_TYPES = new Set(['CSV_UPLOAD', 'SIMULATOR']);

@Controller()
export class ConnectorsController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly scope: OrgScopeService,
  ) {}

  @Get('facilities/:facilityId/connectors')
  async list(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
  ) {
    await this.scope.requireFacility(userId, facilityId, 'connector:read');
    const rows = await this.db
      .select()
      .from(schema.connectors)
      .where(eq(schema.connectors.facilityId, facilityId))
      .orderBy(schema.connectors.name);
    return { connectors: rows.map(toConnectorDto) };
  }

  @Post('facilities/:facilityId/connectors')
  @HttpCode(201)
  async create(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
    @Body(zodBody(createConnectorRequestSchema)) body: CreateConnectorRequest,
  ) {
    const { organizationId } = await this.scope.requireFacility(
      userId,
      facilityId,
      'connector:write',
    );
    const encrypted = body.configuration
      ? encryptConnectorConfiguration(body.configuration)
      : null;

    const created = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.connectors)
        .values({
          facilityId,
          name: body.name,
          connectorType: body.connector_type,
          configurationEncrypted: encrypted,
          configSummary: summarizeConnectorConfiguration(body.configuration),
          ...(body.poll_interval_seconds
            ? { pollIntervalSeconds: body.poll_interval_seconds }
            : {}),
          createdBy: userId,
        })
        .returning();
      if (!row) throw new Error('Connector insert returned no row');
      await tx.insert(schema.auditLogs).values({
        organizationId,
        facilityId,
        actorUserId: userId,
        action: 'CONNECTOR_CREATED',
        objectType: 'connector',
        objectId: row.id,
        afterState: connectorAuditState(row),
      });
      return row;
    });
    return { connector: toConnectorDto(created) };
  }

  @Get('connectors/:connectorId')
  async detail(
    @CurrentUserId() userId: string,
    @Param('connectorId', new ZodValidationPipe(uuidSchema)) connectorId: string,
  ) {
    const connector = await this.requireConnector(userId, connectorId, 'connector:read');
    return { connector: toConnectorDto(connector) };
  }

  @Patch('connectors/:connectorId')
  async update(
    @CurrentUserId() userId: string,
    @Param('connectorId', new ZodValidationPipe(uuidSchema)) connectorId: string,
    @Body(zodBody(updateConnectorRequestSchema)) body: UpdateConnectorRequest,
  ) {
    const before = await this.requireConnector(userId, connectorId, 'connector:write');
    const { organizationId } = await this.scope.requireFacility(
      userId,
      before.facilityId,
      'connector:write',
    );
    const changes: Partial<typeof schema.connectors.$inferInsert> = {
      updatedAt: new Date().toISOString(),
    };
    if (body.name !== undefined) changes.name = body.name;
    if (body.poll_interval_seconds !== undefined) {
      changes.pollIntervalSeconds = body.poll_interval_seconds;
    }
    if (body.configuration !== undefined) {
      changes.configurationEncrypted = body.configuration
        ? encryptConnectorConfiguration(body.configuration)
        : null;
      changes.configSummary = summarizeConnectorConfiguration(body.configuration);
      changes.status = 'DRAFT';
      changes.lastError = null;
    }
    if (body.enabled === false) {
      changes.status = 'DISABLED';
    } else if (body.enabled === true && before.status === 'DISABLED') {
      // Re-enabling requires a fresh test before data can sync.
      changes.status = 'DRAFT';
      changes.lastError = null;
    }

    const after = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(schema.connectors)
        .set(changes)
        .where(eq(schema.connectors.id, connectorId))
        .returning();
      if (!row) throw new Error('Connector update returned no row');
      await tx.insert(schema.auditLogs).values({
        organizationId,
        facilityId: before.facilityId,
        actorUserId: userId,
        action: body.enabled === false ? 'CONNECTOR_DISABLED' : 'CONNECTOR_UPDATED',
        objectType: 'connector',
        objectId: connectorId,
        beforeState: connectorAuditState(before),
        afterState: connectorAuditState(row),
      });
      return row;
    });
    return { connector: toConnectorDto(after) };
  }

  @Post('connectors/:connectorId/test')
  async test(
    @CurrentUserId() userId: string,
    @Param('connectorId', new ZodValidationPipe(uuidSchema)) connectorId: string,
  ) {
    const connector = await this.requireConnector(userId, connectorId, 'connector:write');
    if (connector.status === 'DISABLED') {
      throw new DomainError('CONFLICT', 'Enable this connector before testing it.', undefined, 409);
    }

    let configurationValid = true;
    if (connector.configurationEncrypted) {
      try {
        decryptConnectorConfiguration(connector.configurationEncrypted);
      } catch {
        configurationValid = false;
      }
    }
    const supported = MVP_CONNECTOR_TYPES.has(connector.connectorType);
    const ok = configurationValid && supported;
    const message = !configurationValid
      ? 'Encrypted configuration could not be authenticated. Re-enter the connector settings.'
      : supported
        ? connector.connectorType === 'SIMULATOR'
          ? 'Simulator is ready to generate deterministic pilot telemetry.'
          : 'CSV connector is ready for previewed imports.'
        : `${connector.connectorType} is recorded for provenance but is not enabled in this pilot build.`;
    const checkedAt = new Date().toISOString();

    await this.db
      .update(schema.connectors)
      .set({
        status: ok ? 'ACTIVE' : 'ERROR',
        lastError: ok ? null : message,
        ...(ok ? { lastSuccessAt: checkedAt } : {}),
        updatedAt: checkedAt,
      })
      .where(eq(schema.connectors.id, connectorId));

    return {
      connector_id: connectorId,
      ok,
      status: ok ? ('ACTIVE' as const) : ('ERROR' as const),
      checked_at: toRfc3339(checkedAt),
      message,
    };
  }

  @Post('connectors/:connectorId/sync')
  @HttpCode(202)
  async sync(
    @CurrentUserId() userId: string,
    @Param('connectorId', new ZodValidationPipe(uuidSchema)) connectorId: string,
  ) {
    const connector = await this.requireConnector(userId, connectorId, 'telemetry:write');
    if (connector.status !== 'ACTIVE') {
      throw new DomainError(
        'CONFLICT',
        'Only an active, successfully tested connector can be synced.',
        { connector_status: connector.status },
        409,
      );
    }
    if (connector.connectorType !== 'SIMULATOR') {
      throw new DomainError(
        'CONFLICT',
        'This connector ingests on operator confirmation rather than background sync.',
        undefined,
        409,
      );
    }

    const now = new Date().toISOString();
    const [run] = await this.db
      .insert(schema.connectorSyncRuns)
      .values({ connectorId, status: 'QUEUED' })
      .returning({ id: schema.connectorSyncRuns.id });
    if (!run) throw new Error('Sync run insert returned no row');
    await this.db
      .update(schema.connectors)
      .set({ lastSyncAt: now, updatedAt: now })
      .where(eq(schema.connectors.id, connectorId));

    return { connector_id: connectorId, sync_run_id: run.id, status: 'QUEUED' as const };
  }

  @Get('connectors/:connectorId/sync-runs')
  async syncRuns(
    @CurrentUserId() userId: string,
    @Param('connectorId', new ZodValidationPipe(uuidSchema)) connectorId: string,
  ) {
    await this.requireConnector(userId, connectorId, 'connector:read');
    const rows = await this.db
      .select()
      .from(schema.connectorSyncRuns)
      .where(eq(schema.connectorSyncRuns.connectorId, connectorId))
      .orderBy(desc(schema.connectorSyncRuns.createdAt))
      .limit(100);
    return {
      sync_runs: rows.map((row) => ({
        id: row.id,
        connector_id: row.connectorId,
        status: row.status,
        started_at: row.startedAt ? toRfc3339(row.startedAt) : null,
        finished_at: row.finishedAt ? toRfc3339(row.finishedAt) : null,
        source_window_start: row.sourceWindowStart ? toRfc3339(row.sourceWindowStart) : null,
        source_window_end: row.sourceWindowEnd ? toRfc3339(row.sourceWindowEnd) : null,
        rows_seen: row.rowsSeen,
        rows_inserted: row.rowsInserted,
        rows_quarantined: row.rowsQuarantined,
        error_code: row.errorCode,
        error_message: row.errorMessage,
        created_at: toRfc3339(row.createdAt),
      })),
    };
  }

  private async requireConnector(
    userId: string,
    connectorId: string,
    permission: 'connector:read' | 'connector:write' | 'telemetry:write',
  ) {
    if (!uuidSchema.safeParse(connectorId).success) {
      throw new DomainError('NOT_FOUND', 'Connector not found', undefined, 404);
    }
    const [connector] = await this.db
      .select()
      .from(schema.connectors)
      .where(eq(schema.connectors.id, connectorId))
      .limit(1);
    if (!connector) throw new DomainError('NOT_FOUND', 'Connector not found', undefined, 404);
    await this.scope.requireFacility(userId, connector.facilityId, permission);
    return connector;
  }
}

function toConnectorDto(row: typeof schema.connectors.$inferSelect) {
  return {
    id: row.id,
    facility_id: row.facilityId,
    name: row.name,
    connector_type: row.connectorType,
    status: row.status,
    config_summary: row.configSummary,
    poll_interval_seconds: row.pollIntervalSeconds,
    last_sync_at: row.lastSyncAt ? toRfc3339(row.lastSyncAt) : null,
    last_success_at: row.lastSuccessAt ? toRfc3339(row.lastSuccessAt) : null,
    last_error: row.lastError,
    has_configuration: row.configurationEncrypted !== null,
    created_at: toRfc3339(row.createdAt),
    updated_at: toRfc3339(row.updatedAt),
  };
}

function connectorAuditState(row: typeof schema.connectors.$inferSelect): Record<string, unknown> {
  return {
    name: row.name,
    connector_type: row.connectorType,
    status: row.status,
    poll_interval_seconds: row.pollIntervalSeconds,
    config_summary: row.configSummary,
    has_configuration: row.configurationEncrypted !== null,
  };
}
