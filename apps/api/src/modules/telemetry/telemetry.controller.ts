import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { schema } from '@gridflex/db/client';
import type { Database } from '@gridflex/db/client';
import { DATABASE } from '../../common/database/database.module.js';
import { CurrentUserId } from '../../common/auth/auth.guard.js';
import { OrgScopeService } from '../../common/auth/org-scope.service.js';
import { toRfc3339 } from '../facilities/facilities.controller.js';

/** Hard cap so a wide time range cannot pull an unbounded result set. */
const MAX_POINTS = 5_000;

/**
 * Telemetry read + data quality (spec §9.2, §10.2).
 *
 * Quality is computed from EXPECTED vs OBSERVED intervals, not from a count of
 * rows. A connector that stops reporting produces no rows at all, so counting
 * rows would report 100% completeness for a dead feed — the exact failure the
 * staleness gate exists to catch.
 */
@Controller('facilities/:facilityId/telemetry')
export class TelemetryController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly scope: OrgScopeService,
  ) {}

  @Get()
  async series(
    @CurrentUserId() userId: string,
    @Param('facilityId') facilityId: string,
    @Query('metric_key') metricKey = 'facility.active_power_kw',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    await this.scope.requireFacility(userId, facilityId, 'telemetry:read');

    const toDate = to ? new Date(to) : new Date();
    const fromDate = from
      ? new Date(from)
      : new Date(toDate.getTime() - 24 * 60 * 60 * 1000);

    const rows = await this.db
      .select({
        measuredAt: schema.telemetryReadings.measuredAt,
        value: schema.telemetryReadings.valueDouble,
        unit: schema.telemetryReadings.unit,
        quality: schema.telemetryReadings.quality,
        sourceKey: schema.telemetryReadings.sourceKey,
      })
      .from(schema.telemetryReadings)
      .where(
        and(
          eq(schema.telemetryReadings.facilityId, facilityId),
          eq(schema.telemetryReadings.metricKey, metricKey),
          gte(schema.telemetryReadings.measuredAt, fromDate.toISOString()),
          lte(schema.telemetryReadings.measuredAt, toDate.toISOString()),
        ),
      )
      .orderBy(asc(schema.telemetryReadings.measuredAt))
      .limit(MAX_POINTS);

    return {
      metric_key: metricKey,
      window_start: toRfc3339(fromDate),
      window_end: toRfc3339(toDate),
      truncated: rows.length === MAX_POINTS,
      points: rows.map((row) => ({
        measured_at: toRfc3339(row.measuredAt),
        // Value stays a string end-to-end (spec §4.1).
        value: String(row.value),
        unit: row.unit,
        quality: row.quality,
      })),
    };
  }

  @Get('quality')
  async quality(
    @CurrentUserId() userId: string,
    @Param('facilityId') facilityId: string,
    @Query('hours') hours = '24',
    @Query('interval_seconds') intervalSeconds = '60',
  ) {
    await this.scope.requireFacility(userId, facilityId, 'telemetry:read');

    const windowHours = Math.min(Math.max(Number(hours) || 24, 1), 24 * 30);
    const interval = Math.max(Number(intervalSeconds) || 60, 1);
    const end = new Date();
    const start = new Date(end.getTime() - windowHours * 60 * 60 * 1000);

    const [observed] = await this.db
      .select({ count: sql<string>`count(*)::text` })
      .from(schema.telemetryReadings)
      .where(
        and(
          eq(schema.telemetryReadings.facilityId, facilityId),
          eq(schema.telemetryReadings.metricKey, 'facility.active_power_kw'),
          gte(schema.telemetryReadings.measuredAt, start.toISOString()),
        ),
      );

    const [latest] = await this.db
      .select({ measuredAt: schema.telemetryReadings.measuredAt })
      .from(schema.telemetryReadings)
      .where(eq(schema.telemetryReadings.facilityId, facilityId))
      .orderBy(desc(schema.telemetryReadings.measuredAt))
      .limit(1);

    const expectedIntervals = Math.floor((windowHours * 3600) / interval);
    const observedIntervals = Number(observed?.count ?? '0');
    const completeness =
      expectedIntervals === 0
        ? 0
        : Math.min(1, observedIntervals / expectedIntervals);

    // Stale threshold: two expected intervals plus 60 seconds (spec §10.2).
    const staleThresholdMs = (interval * 2 + 60) * 1000;
    const lastReadingAt = latest ? new Date(latest.measuredAt) : null;
    const isStale =
      lastReadingAt === null || Date.now() - lastReadingAt.getTime() > staleThresholdMs;

    return {
      facility_id: facilityId,
      window_start: toRfc3339(start),
      window_end: toRfc3339(end),
      interval_seconds: interval,
      expected_intervals: expectedIntervals,
      observed_intervals: observedIntervals,
      completeness: Number(completeness.toFixed(4)),
      last_reading_at: lastReadingAt ? toRfc3339(lastReadingAt) : null,
      is_stale: isStale,
      stale_threshold_seconds: staleThresholdMs / 1000,
      meets_drill_threshold: completeness >= 0.9 && !isStale,
    };
  }

  @Get('latest')
  async latest(
    @CurrentUserId() userId: string,
    @Param('facilityId') facilityId: string,
  ) {
    await this.scope.requireFacility(userId, facilityId, 'telemetry:read');

    const rows = await this.db
      .selectDistinctOn([schema.telemetryReadings.metricKey], {
        metricKey: schema.telemetryReadings.metricKey,
        measuredAt: schema.telemetryReadings.measuredAt,
        value: schema.telemetryReadings.valueDouble,
        unit: schema.telemetryReadings.unit,
        quality: schema.telemetryReadings.quality,
      })
      .from(schema.telemetryReadings)
      .where(eq(schema.telemetryReadings.facilityId, facilityId))
      .orderBy(
        asc(schema.telemetryReadings.metricKey),
        desc(schema.telemetryReadings.measuredAt),
      );

    return {
      metrics: rows.map((row) => ({
        metric_key: row.metricKey,
        measured_at: toRfc3339(row.measuredAt),
        value: String(row.value),
        unit: row.unit,
        quality: row.quality,
      })),
    };
  }
}
