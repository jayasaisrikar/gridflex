import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import { schema } from '@gridflex/db/client';
import type { Database } from '@gridflex/db/client';
import { DomainError, uuidSchema } from '@gridflex/contracts';
import { DATABASE } from '../../common/database/database.module.js';
import { CurrentUserId } from '../../common/auth/auth.guard.js';
import { OrgScopeService } from '../../common/auth/org-scope.service.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { toRfc3339 } from '../facilities/facilities.controller.js';

interface AuditQuery {
  readonly limit?: string;
  readonly before?: string;
}

/** Reviewer-facing immutable audit and proof activity feeds. */
@Controller()
export class AuditController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly scope: OrgScopeService,
  ) {}

  @Get('facilities/:facilityId/audit')
  async audit(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
    @Query() rawQuery: AuditQuery,
  ) {
    await this.scope.requireFacility(userId, facilityId, 'audit:read');
    const query = parseQuery(rawQuery);
    const rows = query.before
      ? await this.db
          .select()
          .from(schema.auditLogs)
          .where(
            and(
              eq(schema.auditLogs.facilityId, facilityId),
              lt(schema.auditLogs.createdAt, query.before),
            ),
          )
          .orderBy(desc(schema.auditLogs.createdAt), desc(schema.auditLogs.id))
          .limit(query.limit)
      : await this.db
          .select()
          .from(schema.auditLogs)
          .where(eq(schema.auditLogs.facilityId, facilityId))
          .orderBy(desc(schema.auditLogs.createdAt), desc(schema.auditLogs.id))
          .limit(query.limit);

    return {
      entries: rows.map(toAuditDto),
      next_before:
        rows.length === query.limit
          ? toRfc3339(rows[rows.length - 1]!.createdAt)
          : null,
    };
  }

  /**
   * A single chronological feed for the console. It combines governance audit
   * rows with immutable drill events, but retains `source` and IDs so no event
   * is mistaken for an audit record or vice versa.
   */
  @Get('facilities/:facilityId/activity')
  async activity(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
    @Query() rawQuery: AuditQuery,
  ) {
    await this.scope.requireFacility(userId, facilityId, 'audit:read');
    const query = parseQuery(rawQuery);

    const audits = query.before
      ? await this.db
          .select()
          .from(schema.auditLogs)
          .where(
            and(
              eq(schema.auditLogs.facilityId, facilityId),
              lt(schema.auditLogs.createdAt, query.before),
            ),
          )
          .orderBy(desc(schema.auditLogs.createdAt), desc(schema.auditLogs.id))
          .limit(query.limit)
      : await this.db
          .select()
          .from(schema.auditLogs)
          .where(eq(schema.auditLogs.facilityId, facilityId))
          .orderBy(desc(schema.auditLogs.createdAt), desc(schema.auditLogs.id))
          .limit(query.limit);

    const events = query.before
      ? await this.db
          .select({
            event: schema.drillEvents,
            drillId: schema.drills.id,
            drillName: schema.drills.name,
          })
          .from(schema.drillEvents)
          .innerJoin(schema.drills, eq(schema.drills.id, schema.drillEvents.drillId))
          .where(
            and(
              eq(schema.drills.facilityId, facilityId),
              lt(schema.drillEvents.occurredAt, query.before),
            ),
          )
          .orderBy(desc(schema.drillEvents.occurredAt), desc(schema.drillEvents.id))
          .limit(query.limit)
      : await this.db
          .select({
            event: schema.drillEvents,
            drillId: schema.drills.id,
            drillName: schema.drills.name,
          })
          .from(schema.drillEvents)
          .innerJoin(schema.drills, eq(schema.drills.id, schema.drillEvents.drillId))
          .where(eq(schema.drills.facilityId, facilityId))
          .orderBy(desc(schema.drillEvents.occurredAt), desc(schema.drillEvents.id))
          .limit(query.limit);

    const combined = [
      ...audits.map((entry) => ({
        source: 'AUDIT' as const,
        occurred_at: toRfc3339(entry.createdAt),
        id: String(entry.id),
        action: entry.action,
        object_type: entry.objectType,
        object_id: entry.objectId,
        actor_user_id: entry.actorUserId,
        actor_service: entry.actorService,
        reason_code: null,
        detail: { before: entry.beforeState, after: entry.afterState },
      })),
      ...events.map(({ event, drillId, drillName }) => ({
        source: 'DRILL_EVENT' as const,
        occurred_at: toRfc3339(event.occurredAt),
        id: String(event.id),
        action: event.eventType,
        object_type: 'drills',
        object_id: drillId,
        actor_user_id: event.actorUserId,
        actor_service: event.actorService,
        reason_code: event.reasonCode,
        detail: { drill_name: drillName, payload: event.payload },
      })),
    ]
      .sort((left, right) => {
        const byTime = Date.parse(right.occurred_at) - Date.parse(left.occurred_at);
        return byTime !== 0 ? byTime : right.id.localeCompare(left.id);
      })
      .slice(0, query.limit);

    return {
      entries: combined,
      next_before:
        combined.length === query.limit
          ? combined[combined.length - 1]!.occurred_at
          : null,
    };
  }
}

function parseQuery(raw: AuditQuery): { limit: number; before?: string } {
  const limit = raw.limit === undefined ? 50 : Number(raw.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'limit must be an integer between 1 and 200.',
      { fields: { limit: 'Must be an integer between 1 and 200' } },
      400,
    );
  }
  if (raw.before !== undefined) {
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(raw.before) ||
      Number.isNaN(Date.parse(raw.before))
    ) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'before must be an RFC 3339 UTC timestamp.',
        { fields: { before: 'Must be an RFC 3339 UTC timestamp ending in Z' } },
        400,
      );
    }
    return { limit, before: raw.before };
  }
  return { limit };
}

function toAuditDto(row: typeof schema.auditLogs.$inferSelect) {
  return {
    id: String(row.id),
    action: row.action,
    object_type: row.objectType,
    object_id: row.objectId,
    actor_user_id: row.actorUserId,
    actor_service: row.actorService,
    before_state: row.beforeState,
    after_state: row.afterState,
    request_id: row.requestId,
    created_at: toRfc3339(row.createdAt),
  };
}
