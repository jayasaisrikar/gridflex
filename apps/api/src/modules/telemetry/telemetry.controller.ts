import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, lte, or } from 'drizzle-orm';
import { schema } from '@gridflex/db/client';
import type { Database } from '@gridflex/db/client';
import {
  DomainError,
  MAX_BATCH_READINGS,
  MAX_CSV_BYTES,
  csvTelemetryRequestSchema,
  telemetryBatchRequestSchema,
  telemetryReadingInputSchema,
  uuidSchema,
  type CsvTelemetryRequest,
  type TelemetryBatchRequest,
} from '@gridflex/contracts';
import { DATABASE } from '../../common/database/database.module.js';
import { CurrentUserId } from '../../common/auth/auth.guard.js';
import { OrgScopeService } from '../../common/auth/org-scope.service.js';
import { ZodValidationPipe, zodBody } from '../../common/pipes/zod-validation.pipe.js';
import { toRfc3339 } from '../facilities/facilities.controller.js';

/** Hard cap so a wide time range cannot pull an unbounded result set. */
const MAX_POINTS = 5_000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const CSV_PREVIEW_TTL_MS = 15 * 60 * 1000;

type Reading = TelemetryBatchRequest['readings'][number];
type QuarantineCandidate = {
  readonly rawPayload: Record<string, unknown>;
  readonly reasonCode: string;
  readonly reasonDetail: string;
};

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
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
    @Query('metric_key') metricKey = 'facility.active_power_kw',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    await this.scope.requireFacility(userId, facilityId, 'telemetry:read');

    const toDate = to ? parseUtcQuery(to, 'to') : new Date();
    const fromDate = from
      ? parseUtcQuery(from, 'from')
      : new Date(toDate.getTime() - 24 * 60 * 60 * 1000);
    if (fromDate >= toDate) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'from must be earlier than to.',
        { fields: { from: 'Must be earlier than to' } },
        400,
      );
    }

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
      // Select newest-first so the safety cap never discards the current
      // reading when a dense source produces more than MAX_POINTS samples.
      .orderBy(desc(schema.telemetryReadings.measuredAt))
      .limit(MAX_POINTS + 1);
    const truncated = rows.length > MAX_POINTS;
    // Charts and API consumers expect chronological output. Reverse only the
    // retained newest slice; reversing before slicing would reintroduce the
    // stale-current-load bug this cap is intended to prevent.
    const visibleRows = rows.slice(0, MAX_POINTS).reverse();

    return {
      metric_key: metricKey,
      window_start: toRfc3339(fromDate),
      window_end: toRfc3339(toDate),
      truncated,
      points: visibleRows.map((row) => ({
        measured_at: toRfc3339(row.measuredAt),
        // Value stays a string end-to-end (spec §4.1).
        value: String(row.value),
        unit: row.unit,
        quality: row.quality,
      })),
    };
  }

  @Post('batch')
  async batch(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
    @Body(zodBody(telemetryBatchRequestSchema)) body: TelemetryBatchRequest,
  ) {
    return this.ingest(userId, facilityId, body, []);
  }

  @Post('csv')
  @HttpCode(200)
  async csv(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
    @Body(zodBody(csvTelemetryRequestSchema)) body: CsvTelemetryRequest,
  ) {
    await this.scope.requireFacility(userId, facilityId, 'telemetry:write');
    if (Buffer.byteLength(body.csv, 'utf8') > MAX_CSV_BYTES) {
      throw new DomainError('CSV_TOO_LARGE', 'CSV exceeds the 5 MiB pilot limit.', undefined, 413);
    }

    const parsed = parseCsv(body.csv);
    const previewToken = createPreviewToken(facilityId, body);
    if (!body.confirm) {
      return {
        total_rows: parsed.readings.length + parsed.invalid.length,
        valid_rows: parsed.readings.length,
        invalid_rows: parsed.invalid.map((row) => ({
          row_number: row.rowNumber,
          reason_code: row.reasonCode,
          detail: row.reasonDetail,
        })),
        detected_interval_seconds: detectedIntervalSeconds(parsed.readings),
        window_start: parsed.windowStart ? toRfc3339(parsed.windowStart) : null,
        window_end: parsed.windowEnd ? toRfc3339(parsed.windowEnd) : null,
        preview_token: previewToken,
      };
    }

    if (!body.preview_token || !verifyPreviewToken(body.preview_token, facilityId, body)) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'The CSV preview expired or does not match these rows. Preview the file again.',
        { fields: { preview_token: 'Preview is expired or does not match this CSV' } },
        400,
      );
    }

    return this.ingest(
      userId,
      facilityId,
      {
        source_key: body.source_key,
        ...(body.connector_id ? { connector_id: body.connector_id } : {}),
        readings: parsed.readings,
      },
      parsed.invalid.map((row) => ({
        rawPayload: row.rawPayload,
        reasonCode: row.reasonCode,
        reasonDetail: `CSV row ${row.rowNumber}: ${row.reasonDetail}`,
      })),
    );
  }

  @Get('quality')
  async quality(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
    @Query('hours') hours = '24',
    @Query('interval_seconds') intervalSeconds = '60',
  ) {
    await this.scope.requireFacility(userId, facilityId, 'telemetry:read');

    const windowHours = Math.min(
      Math.max(Math.floor(Number(hours)) || 24, 1),
      24 * 30,
    );
    const interval = Math.min(
      Math.max(Math.floor(Number(intervalSeconds)) || 60, 1),
      86_400,
    );
    const end = new Date();
    const start = new Date(end.getTime() - windowHours * 60 * 60 * 1000);

    const samples = await this.db
      .select({
        measuredAt: schema.telemetryReadings.measuredAt,
        quality: schema.telemetryReadings.quality,
        sourceKey: schema.telemetryReadings.sourceKey,
        connectorType: schema.connectors.connectorType,
      })
      .from(schema.telemetryReadings)
      .leftJoin(
        schema.connectors,
        eq(schema.connectors.id, schema.telemetryReadings.connectorId),
      )
      .where(
        and(
          eq(schema.telemetryReadings.facilityId, facilityId),
          eq(schema.telemetryReadings.metricKey, 'facility.active_power_kw'),
          inArray(schema.telemetryReadings.quality, ['GOOD', 'ESTIMATED']),
          gte(schema.telemetryReadings.measuredAt, start.toISOString()),
          lte(schema.telemetryReadings.measuredAt, end.toISOString()),
        ),
      )
      .orderBy(asc(schema.telemetryReadings.measuredAt));

    const expectedIntervals = Math.floor((windowHours * 3600) / interval);
    // Keep the accepted-quality check here as a defensive invariant in addition
    // to the SQL predicate. Multiple sources can report a few seconds apart in
    // the same interval, so completeness counts interval buckets rather than
    // exact timestamps.
    const acceptedSamples = samples.filter(
      (sample) => sample.quality === 'GOOD' || sample.quality === 'ESTIMATED',
    );
    const sampleInstants = [
      ...new Set(acceptedSamples.map((sample) => new Date(sample.measuredAt).getTime())),
    ].sort((left, right) => left - right);
    const intervalMs = interval * 1_000;
    const observedIntervals = new Set(
      sampleInstants.map((instant) => Math.floor(instant / intervalMs)),
    ).size;
    const completeness =
      expectedIntervals === 0
        ? 0
        : Math.min(1, observedIntervals / expectedIntervals);

    // Stale threshold: two expected intervals plus 60 seconds (spec §10.2).
    const staleThresholdMs = (interval * 2 + 60) * 1000;
    const latestInstant = sampleInstants.at(-1);
    const lastReadingAt = latestInstant === undefined ? null : new Date(latestInstant);
    const isStale =
      lastReadingAt === null || Date.now() - lastReadingAt.getTime() > staleThresholdMs;
    const maximumGapIntervals = computeMaximumGapIntervals(
      sampleInstants,
      start.getTime(),
      end.getTime(),
      interval,
    );
    const containsSimulatedData = acceptedSamples.some(
      (sample) =>
        sample.connectorType === 'SIMULATOR' || /(^|[-_])sim(ulator)?($|[-_])/i.test(sample.sourceKey),
    );

    return {
      facility_id: facilityId,
      window_start: toRfc3339(start),
      window_end: toRfc3339(end),
      interval_seconds: interval,
      expected_intervals: expectedIntervals,
      observed_intervals: observedIntervals,
      completeness: Number(completeness.toFixed(4)),
      maximum_gap_intervals: maximumGapIntervals,
      last_reading_at: lastReadingAt ? toRfc3339(lastReadingAt) : null,
      is_stale: isStale,
      stale_threshold_seconds: staleThresholdMs / 1000,
      contains_simulated_data: containsSimulatedData,
      meets_drill_threshold:
        completeness >= 0.9 && maximumGapIntervals <= 2 && !isStale,
    };
  }

  @Get('quarantine')
  async quarantine(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
    @Query('limit') requestedLimit = '100',
  ) {
    await this.scope.requireFacility(userId, facilityId, 'telemetry:read');
    const limit = Math.min(Math.max(Math.floor(Number(requestedLimit)) || 100, 1), 200);
    const rows = await this.db
      .select()
      .from(schema.telemetryQuarantine)
      .where(eq(schema.telemetryQuarantine.facilityId, facilityId))
      .orderBy(desc(schema.telemetryQuarantine.receivedAt))
      .limit(limit);
    return {
      quarantine: rows.map((row) => ({
        id: String(row.id),
        facility_id: row.facilityId,
        connector_id: row.connectorId,
        sync_run_id: row.ingestRunId,
        received_at: toRfc3339(row.receivedAt),
        raw_payload: row.rawPayload,
        reason_code: row.reasonCode,
        reason_detail: row.reasonDetail,
        resolved_at: row.resolvedAt ? toRfc3339(row.resolvedAt) : null,
      })),
    };
  }

  @Get('latest')
  async latest(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
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

  private async ingest(
    userId: string,
    facilityId: string,
    body: TelemetryBatchRequest,
    initialQuarantine: readonly QuarantineCandidate[],
  ) {
    const { organizationId } = await this.scope.requireFacility(
      userId,
      facilityId,
      'telemetry:write',
    );
    const connector = body.connector_id
      ? await this.requireConnectorForFacility(facilityId, body.connector_id)
      : null;

    const candidates = new Map<string, Reading>();
    const localExactDuplicates = new Map<string, number>();
    const quarantine: QuarantineCandidate[] = [...initialQuarantine];
    let duplicates = 0;
    for (const reading of body.readings) {
      const rawPayload = reading as unknown as Record<string, unknown>;
      if (reading.quality === 'QUARANTINED') {
        quarantine.push({
          rawPayload,
          reasonCode: 'SOURCE_QUARANTINED',
          reasonDetail: 'Source marked the reading as quarantined.',
        });
        continue;
      }
      if (new Date(reading.measured_at).getTime() > Date.now() + MAX_FUTURE_SKEW_MS) {
        quarantine.push({
          rawPayload,
          reasonCode: 'TELEMETRY_INVALID_TIMESTAMP',
          reasonDetail: 'Timestamp is more than five minutes in the future.',
        });
        continue;
      }

      const key = readingKey(reading);
      const prior = candidates.get(key);
      if (!prior) {
        candidates.set(key, reading);
      } else if (readingsMatch(prior, reading)) {
        localExactDuplicates.set(key, (localExactDuplicates.get(key) ?? 0) + 1);
      } else {
        quarantine.push({
          rawPayload,
          reasonCode: 'TELEMETRY_DUPLICATE_CONFLICT',
          reasonDetail: 'Two rows in this request use the same metric and timestamp with different data.',
        });
      }
    }

    return this.db.transaction(async (tx) => {
      const now = new Date().toISOString();
      const [syncRun] = connector
        ? await tx
            .insert(schema.connectorSyncRuns)
            .values({ connectorId: connector.id, status: 'RUNNING', startedAt: now })
            .returning({ id: schema.connectorSyncRuns.id })
        : [undefined];
      const ingestRunId = syncRun?.id ?? null;
      const candidateRows = [...candidates.values()];
      const insertedKeys = new Set<string>();

      // Stay well below PostgreSQL's parameter cap while retaining one atomic
      // import transaction. ON CONFLICT is the concurrency-safe idempotency gate.
      for (const chunk of chunks(candidateRows, 1_000)) {
        if (chunk.length === 0) continue;
        const inserted = await tx
          .insert(schema.telemetryReadings)
          .values(
            chunk.map((reading) => ({
              organizationId,
              facilityId,
              connectorId: connector?.id ?? null,
              sourceKey: body.source_key,
              metricKey: reading.metric_key,
              measuredAt: reading.measured_at,
              valueDouble: Number(reading.value),
              unit: reading.unit,
              quality: reading.quality,
              sourceSequence: reading.source_sequence ?? null,
              ingestRunId,
            })),
          )
          .onConflictDoNothing({
            target: [
              schema.telemetryReadings.facilityId,
              schema.telemetryReadings.sourceKey,
              schema.telemetryReadings.metricKey,
              schema.telemetryReadings.measuredAt,
            ],
          })
          .returning({
            metricKey: schema.telemetryReadings.metricKey,
            measuredAt: schema.telemetryReadings.measuredAt,
          });
        for (const row of inserted) {
          insertedKeys.add(`${row.metricKey}\u0000${toRfc3339(row.measuredAt)}`);
        }
      }

      const conflicted = candidateRows.filter(
        (reading) => !insertedKeys.has(readingKey(reading)),
      );
      for (const insertedKey of insertedKeys) {
        duplicates += localExactDuplicates.get(insertedKey) ?? 0;
      }
      for (const chunk of chunks(conflicted, 300)) {
        if (chunk.length === 0) continue;
        const existing = await tx
          .select({
            metricKey: schema.telemetryReadings.metricKey,
            measuredAt: schema.telemetryReadings.measuredAt,
            valueDouble: schema.telemetryReadings.valueDouble,
            unit: schema.telemetryReadings.unit,
            quality: schema.telemetryReadings.quality,
            sourceSequence: schema.telemetryReadings.sourceSequence,
          })
          .from(schema.telemetryReadings)
          .where(
            and(
              eq(schema.telemetryReadings.facilityId, facilityId),
              eq(schema.telemetryReadings.sourceKey, body.source_key),
              or(
                ...chunk.map((reading) =>
                  and(
                    eq(schema.telemetryReadings.metricKey, reading.metric_key),
                    eq(schema.telemetryReadings.measuredAt, reading.measured_at),
                  ),
                ),
              ),
            ),
          );
        const existingByKey = new Map(
          existing.map((row) => [
            `${row.metricKey}\u0000${toRfc3339(row.measuredAt)}`,
            row,
          ]),
        );
        for (const reading of chunk) {
          const key = readingKey(reading);
          const stored = existingByKey.get(key);
          const occurrences = 1 + (localExactDuplicates.get(key) ?? 0);
          if (
            stored &&
            stored.valueDouble === Number(reading.value) &&
            stored.unit === reading.unit &&
            stored.quality === reading.quality &&
            stored.sourceSequence === (reading.source_sequence ?? null)
          ) {
            duplicates += occurrences;
          } else {
            for (let occurrence = 0; occurrence < occurrences; occurrence += 1) {
              quarantine.push({
                rawPayload: reading as unknown as Record<string, unknown>,
                reasonCode: 'TELEMETRY_DUPLICATE_CONFLICT',
                reasonDetail:
                  'A stored reading already uses this source, metric, and timestamp with different data.',
              });
            }
          }
        }
      }

      if (quarantine.length > 0) {
        await tx.insert(schema.telemetryQuarantine).values(
          quarantine.map((item) => ({
            facilityId,
            connectorId: connector?.id ?? null,
            ingestRunId,
            rawPayload: item.rawPayload,
            reasonCode: item.reasonCode,
            reasonDetail: item.reasonDetail,
          })),
        );
      }

      const inserted = insertedKeys.size;
      if (syncRun && connector) {
        const status = quarantine.length > 0 ? 'PARTIAL' : 'SUCCEEDED';
        await tx
          .update(schema.connectorSyncRuns)
          .set({
            status,
            finishedAt: now,
            rowsSeen: body.readings.length + initialQuarantine.length,
            rowsInserted: inserted,
            rowsQuarantined: quarantine.length,
          })
          .where(eq(schema.connectorSyncRuns.id, syncRun.id));
        await tx
          .update(schema.connectors)
          .set({
            status: quarantine.length > 0 ? 'DEGRADED' : 'ACTIVE',
            lastSyncAt: now,
            ...(inserted > 0 ? { lastSuccessAt: now } : {}),
            lastError:
              quarantine.length > 0
                ? `${quarantine.length} row${quarantine.length === 1 ? '' : 's'} quarantined`
                : null,
            updatedAt: now,
          })
          .where(eq(schema.connectors.id, connector.id));
      }

      return {
        inserted,
        duplicates,
        quarantined: quarantine.length,
        sync_run_id: ingestRunId,
      };
    });
  }

  private async requireConnectorForFacility(facilityId: string, connectorId: string) {
    const [connector] = await this.db
      .select()
      .from(schema.connectors)
      .where(
        and(
          eq(schema.connectors.id, connectorId),
          eq(schema.connectors.facilityId, facilityId),
        ),
      )
      .limit(1);
    if (!connector) throw new DomainError('NOT_FOUND', 'Connector not found', undefined, 404);
    if (connector.status === 'DISABLED') {
      throw new DomainError('CONFLICT', 'Disabled connectors cannot ingest telemetry.', undefined, 409);
    }
    return connector;
  }
}

function readingKey(reading: Pick<Reading, 'metric_key' | 'measured_at'>): string {
  return `${reading.metric_key}\u0000${toRfc3339(reading.measured_at)}`;
}

function readingsMatch(left: Reading, right: Reading): boolean {
  return (
    Number(left.value) === Number(right.value) &&
    left.unit === right.unit &&
    left.quality === right.quality &&
    (left.source_sequence ?? null) === (right.source_sequence ?? null)
  );
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function parseUtcQuery(value: string, field: string): Date {
  const parsed = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) || Number.isNaN(parsed.getTime())) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `${field} must be an RFC 3339 UTC timestamp.`,
      { fields: { [field]: 'Must be an RFC 3339 UTC timestamp ending in Z' } },
      400,
    );
  }
  return parsed;
}

type InvalidCsvRow = {
  readonly rowNumber: number;
  readonly reasonCode: string;
  readonly reasonDetail: string;
  readonly rawPayload: Record<string, unknown>;
};

type ParsedCsv = {
  readonly readings: Reading[];
  readonly invalid: InvalidCsvRow[];
  readonly windowStart: Date | null;
  readonly windowEnd: Date | null;
};

const REQUIRED_CSV_HEADERS = ['measured_at', 'metric_key', 'value', 'unit'] as const;
const ALLOWED_CSV_HEADERS = new Set([...REQUIRED_CSV_HEADERS, 'source_sequence', 'quality']);

function parseCsv(csv: string): ParsedCsv {
  const rows = tokenizeCsv(csv);
  if (rows.length < 2) {
    throw new DomainError(
      'CSV_MALFORMED',
      'CSV must include a header and at least one data row.',
      undefined,
      400,
    );
  }
  if (rows.length - 1 > MAX_BATCH_READINGS) {
    throw new DomainError(
      'CSV_TOO_LARGE',
      `CSV exceeds the ${MAX_BATCH_READINGS.toLocaleString('en-US')} row pilot limit.`,
      undefined,
      413,
    );
  }

  const headers = rows[0]!.map((value, index) =>
    (index === 0 ? value.replace(/^\uFEFF/, '') : value).trim().toLowerCase(),
  );
  const duplicateHeaders = headers.filter((header, index) => headers.indexOf(header) !== index);
  const missingHeaders = REQUIRED_CSV_HEADERS.filter((header) => !headers.includes(header));
  const unknownHeaders = headers.filter((header) => !ALLOWED_CSV_HEADERS.has(header));
  if (duplicateHeaders.length > 0 || missingHeaders.length > 0 || unknownHeaders.length > 0) {
    throw new DomainError(
      'CSV_MALFORMED',
      'CSV headers do not match the GridFlex telemetry format.',
      {
        ...(missingHeaders.length > 0 ? { missing_headers: missingHeaders } : {}),
        ...(duplicateHeaders.length > 0 ? { duplicate_headers: duplicateHeaders } : {}),
        ...(unknownHeaders.length > 0 ? { unknown_headers: unknownHeaders } : {}),
      },
      400,
    );
  }

  const readings: Reading[] = [];
  const invalid: InvalidCsvRow[] = [];
  const instants: number[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const cells = rows[index]!;
    const rowNumber = index + 1;
    const rawPayload = Object.fromEntries(
      headers.map((header, cellIndex) => [header || `column_${cellIndex + 1}`, cells[cellIndex] ?? '']),
    );
    if (cells.length !== headers.length) {
      invalid.push({
        rowNumber,
        reasonCode: 'CSV_COLUMN_COUNT',
        reasonDetail: `Expected ${headers.length} columns and received ${cells.length}.`,
        rawPayload,
      });
      continue;
    }

    const formulaColumn = headers.find((header, cellIndex) =>
      looksLikeSpreadsheetFormula(cells[cellIndex] ?? '', header),
    );
    if (formulaColumn) {
      invalid.push({
        rowNumber,
        reasonCode: 'CSV_FORMULA_REJECTED',
        reasonDetail: `Spreadsheet formula syntax is not allowed in ${formulaColumn}.`,
        rawPayload,
      });
      continue;
    }

    const field = (name: string): string => cells[headers.indexOf(name)]?.trim() ?? '';
    const sourceSequence = headers.includes('source_sequence')
      ? field('source_sequence')
      : '';
    const quality = headers.includes('quality') ? field('quality') : '';
    const result = telemetryReadingInputSchema.safeParse({
      measured_at: field('measured_at'),
      metric_key: field('metric_key'),
      value: field('value'),
      unit: field('unit'),
      ...(sourceSequence ? { source_sequence: sourceSequence } : {}),
      ...(quality ? { quality } : {}),
    });
    if (!result.success) {
      const issue = result.error.issues[0];
      const issuePath = String(issue?.path[0] ?? 'row');
      invalid.push({
        rowNumber,
        reasonCode:
          issuePath === 'measured_at'
            ? 'TELEMETRY_INVALID_TIMESTAMP'
            : issuePath === 'unit'
              ? 'TELEMETRY_UNIT_MISMATCH'
              : 'TELEMETRY_VALIDATION_FAILED',
        reasonDetail: result.error.issues.map((item) => `${item.path.join('.')}: ${item.message}`).join('; '),
        rawPayload,
      });
      continue;
    }
    if (new Date(result.data.measured_at).getTime() > Date.now() + MAX_FUTURE_SKEW_MS) {
      invalid.push({
        rowNumber,
        reasonCode: 'TELEMETRY_INVALID_TIMESTAMP',
        reasonDetail: 'measured_at: Timestamp is more than five minutes in the future.',
        rawPayload,
      });
      continue;
    }
    if (result.data.quality === 'QUARANTINED') {
      invalid.push({
        rowNumber,
        reasonCode: 'SOURCE_QUARANTINED',
        reasonDetail: 'quality: Source marked this row as quarantined.',
        rawPayload,
      });
      continue;
    }
    readings.push(result.data);
    instants.push(new Date(result.data.measured_at).getTime());
  }

  return {
    readings,
    invalid,
    windowStart: instants.length > 0 ? new Date(Math.min(...instants)) : null,
    windowEnd: instants.length > 0 ? new Date(Math.max(...instants)) : null,
  };
}

function tokenizeCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index]!;
    if (quoted) {
      if (character === '"') {
        if (csv[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"' && cell.length === 0) {
      quoted = true;
    } else if (character === ',') {
      row.push(cell);
      cell = '';
    } else if (character === '\n') {
      row.push(cell.endsWith('\r') ? cell.slice(0, -1) : cell);
      if (row.some((value) => value.trim().length > 0)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }
  if (quoted) {
    throw new DomainError('CSV_MALFORMED', 'CSV contains an unclosed quoted field.', undefined, 400);
  }
  row.push(cell.endsWith('\r') ? cell.slice(0, -1) : cell);
  if (row.some((value) => value.trim().length > 0)) rows.push(row);
  return rows;
}

function looksLikeSpreadsheetFormula(value: string, header: string): boolean {
  const trimmed = value.trimStart();
  if (/^[=+@]/.test(trimmed)) return true;
  return header !== 'value' && trimmed.startsWith('-');
}

function detectedIntervalSeconds(readings: readonly Reading[]): number | null {
  const instants = [
    ...new Set(readings.map((reading) => new Date(reading.measured_at).getTime())),
  ].sort((left, right) => left - right);
  if (instants.length < 2) return null;
  const frequencies = new Map<number, number>();
  for (let index = 1; index < instants.length; index += 1) {
    const seconds = Math.round((instants[index]! - instants[index - 1]!) / 1_000);
    if (seconds > 0) frequencies.set(seconds, (frequencies.get(seconds) ?? 0) + 1);
  }
  const ranked = [...frequencies.entries()].sort(
    ([leftSeconds, leftCount], [rightSeconds, rightCount]) =>
      rightCount - leftCount || leftSeconds - rightSeconds,
  );
  return ranked[0]?.[0] ?? null;
}

function computeMaximumGapIntervals(
  sortedInstants: readonly number[],
  windowStart: number,
  windowEnd: number,
  intervalSeconds: number,
): number {
  const intervalMs = intervalSeconds * 1_000;
  if (sortedInstants.length === 0) {
    return Math.floor((windowEnd - windowStart) / intervalMs);
  }
  let maximum = Math.max(0, Math.floor((sortedInstants[0]! - windowStart) / intervalMs));
  for (let index = 1; index < sortedInstants.length; index += 1) {
    const missing = Math.max(
      0,
      Math.floor((sortedInstants[index]! - sortedInstants[index - 1]!) / intervalMs) - 1,
    );
    maximum = Math.max(maximum, missing);
  }
  maximum = Math.max(
    maximum,
    Math.max(0, Math.floor((windowEnd - sortedInstants.at(-1)!) / intervalMs) - 1),
  );
  return maximum;
}

function previewSignature(
  facilityId: string,
  body: Pick<CsvTelemetryRequest, 'source_key' | 'connector_id' | 'csv'>,
  issuedAt: number,
): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error('AUTH_SECRET must contain at least 32 characters');
  return createHmac('sha256', secret)
    .update(facilityId)
    .update('\u0000')
    .update(body.source_key)
    .update('\u0000')
    .update(body.connector_id ?? '')
    .update('\u0000')
    .update(String(issuedAt))
    .update('\u0000')
    .update(body.csv)
    .digest();
}

function createPreviewToken(facilityId: string, body: CsvTelemetryRequest): string {
  const issuedAt = Date.now();
  return `${issuedAt.toString(36)}.${previewSignature(facilityId, body, issuedAt).toString('base64url')}`;
}

function verifyPreviewToken(
  token: string,
  facilityId: string,
  body: CsvTelemetryRequest,
): boolean {
  const [encodedIssuedAt, encodedSignature, ...rest] = token.split('.');
  if (!encodedIssuedAt || !encodedSignature || rest.length > 0) return false;
  const issuedAt = Number.parseInt(encodedIssuedAt, 36);
  if (!Number.isFinite(issuedAt) || issuedAt > Date.now() || Date.now() - issuedAt > CSV_PREVIEW_TTL_MS) {
    return false;
  }
  let supplied: Buffer;
  try {
    supplied = Buffer.from(encodedSignature, 'base64url');
  } catch {
    return false;
  }
  const expected = previewSignature(facilityId, body, issuedAt);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
