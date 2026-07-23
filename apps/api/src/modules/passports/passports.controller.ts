import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { schema } from '@gridflex/db/client';
import type { Database } from '@gridflex/db/client';
import {
  DomainError,
  createPassportExportRequestSchema,
  issuePassportRequestSchema,
  passportDocumentSchema,
  uuidSchema,
  type CreatePassportExportRequest,
  type IssuePassportRequest,
  type PassportDocument,
  type Permission,
} from '@gridflex/contracts';
import {
  CANONICAL_SCHEMA_VERSION,
  canonicalStringify,
  sealDocument,
  verifyDocument,
  type CanonicalInput,
} from '@gridflex/engine';
import { DATABASE } from '../../common/database/database.module.js';
import { CurrentUserId } from '../../common/auth/auth.guard.js';
import { OrgScopeService } from '../../common/auth/org-scope.service.js';
import {
  ZodValidationPipe,
  zodBody,
} from '../../common/pipes/zod-validation.pipe.js';
import { toRfc3339 } from '../facilities/facilities.controller.js';
import { renderPassportPdf } from './passport-pdf.js';

const PASSPORT_MINIMUM_COMPLETENESS = 0.9;
const EXPORT_TTL_DAYS = 7;
const TELEMETRY_STALE_AFTER_MS = 3 * 60 * 1_000;

/** Passport issuance, verification, and deterministic JSON/CSV exports (spec 9.5). */
@Controller()
export class PassportsController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly scope: OrgScopeService,
  ) {}

  @Post('facilities/:facilityId/passports/issue')
  @HttpCode(201)
  async issue(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
    @Body(zodBody(issuePassportRequestSchema)) body: IssuePassportRequest,
  ) {
    const { organizationId } = await this.scope.requireFacility(
      userId,
      facilityId,
      'passport:issue',
    );

    return this.db.transaction(async (tx) => {
      await lockFacility(tx, facilityId);
      const [facility] = await tx
        .select()
        .from(schema.facilities)
        .where(eq(schema.facilities.id, facilityId))
        .limit(1);
      if (!facility) throw new DomainError('NOT_FOUND', 'Facility not found.', undefined, 404);

      const [envelope] = body.envelope_id
        ? await tx
            .select()
            .from(schema.envelopes)
            .where(
              and(
                eq(schema.envelopes.id, body.envelope_id),
                eq(schema.envelopes.facilityId, facilityId),
              ),
            )
            .limit(1)
        : await tx
            .select()
            .from(schema.envelopes)
            .where(
              and(
                eq(schema.envelopes.facilityId, facilityId),
                eq(schema.envelopes.status, 'CURRENT'),
              ),
            )
            .orderBy(desc(schema.envelopes.version))
            .limit(1);

      if (!envelope) {
        throw new DomainError(
          'PASSPORT_BLOCKED',
          'A current flexibility envelope is required before issuing a Passport.',
          { blocker: 'ENVELOPE_NOT_CURRENT' },
          409,
        );
      }
      if (
        envelope.status !== 'CURRENT' ||
        (envelope.validUntil !== null && Date.parse(envelope.validUntil) <= Date.now())
      ) {
        throw new DomainError(
          'PASSPORT_BLOCKED',
          'The selected envelope is not current.',
          { blocker: 'ENVELOPE_NOT_CURRENT', envelope_id: envelope.id },
          409,
        );
      }
      const [latestCurrent] = await tx
        .select({ id: schema.envelopes.id })
        .from(schema.envelopes)
        .where(
          and(
            eq(schema.envelopes.facilityId, facilityId),
            eq(schema.envelopes.status, 'CURRENT'),
          ),
        )
        .orderBy(desc(schema.envelopes.version))
        .limit(1);
      if (latestCurrent?.id !== envelope.id) {
        throw new DomainError(
          'PASSPORT_BLOCKED',
          'The selected envelope is not the latest current version.',
          { blocker: 'ENVELOPE_NOT_CURRENT', envelope_id: envelope.id },
          409,
        );
      }
      if (Number(envelope.telemetryCompleteness) < PASSPORT_MINIMUM_COMPLETENESS) {
        throw new DomainError(
          'PASSPORT_BLOCKED',
          'Telemetry completeness is below the pilot issuance threshold.',
          {
            blocker: 'TELEMETRY_INCOMPLETE',
            completeness: envelope.telemetryCompleteness,
            required: PASSPORT_MINIMUM_COMPLETENESS.toFixed(4),
          },
          409,
        );
      }

      const [constraints] = await tx
        .select()
        .from(schema.facilityConstraints)
        .where(
          and(
            eq(schema.facilityConstraints.facilityId, facilityId),
            eq(schema.facilityConstraints.version, envelope.constraintsVersion),
          ),
        )
        .limit(1);
      if (!constraints) {
        throw new DomainError(
          'PASSPORT_BLOCKED',
          'The envelope constraint version cannot be resolved.',
          { blocker: 'CONSTRAINTS_MISSING', constraints_version: envelope.constraintsVersion },
          409,
        );
      }
      const now = new Date().toISOString();
      const [activeConstraints] = await tx
        .select({ version: schema.facilityConstraints.version })
        .from(schema.facilityConstraints)
        .where(
          and(
            eq(schema.facilityConstraints.facilityId, facilityId),
            lte(schema.facilityConstraints.effectiveFrom, now),
            or(
              isNull(schema.facilityConstraints.effectiveTo),
              gt(schema.facilityConstraints.effectiveTo, now),
            ),
          ),
        )
        .orderBy(desc(schema.facilityConstraints.version))
        .limit(1);
      if (activeConstraints?.version !== envelope.constraintsVersion) {
        throw new DomainError(
          'PASSPORT_BLOCKED',
          'Safety constraints changed after this envelope was computed. Recompute the envelope first.',
          {
            blocker: 'ENVELOPE_NOT_CURRENT',
            envelope_constraints_version: envelope.constraintsVersion,
            active_constraints_version: activeConstraints?.version ?? null,
          },
          409,
        );
      }

      const mechanisms = await loadEnvelopeMechanisms(tx, envelope.id);
      const connectors = await tx
        .select()
        .from(schema.connectors)
        .where(eq(schema.connectors.facilityId, facilityId))
        .orderBy(asc(schema.connectors.name));

      const association = await resolveDrillAssociation(
        tx,
        facilityId,
        body.drill_id,
      );
      const history = await loadDrillHistory(tx, facilityId);
      const dataWindow = await loadDataWindow(tx, facilityId, envelope.asOf);
      if (
        dataWindow.completeness < PASSPORT_MINIMUM_COMPLETENESS ||
        Date.now() - Date.parse(dataWindow.windowEnd) > TELEMETRY_STALE_AFTER_MS
      ) {
        throw new DomainError(
          'PASSPORT_BLOCKED',
          'Current telemetry does not meet the Passport freshness and completeness gates.',
          {
            blocker:
              Date.now() - Date.parse(dataWindow.windowEnd) > TELEMETRY_STALE_AFTER_MS
                ? 'TELEMETRY_STALE'
                : 'TELEMETRY_INCOMPLETE',
            completeness: dataWindow.completeness.toFixed(4),
            last_reading_at: dataWindow.windowEnd,
          },
          409,
        );
      }
      const containsSimulatedData =
        connectors.some((connector) => connector.connectorType === 'SIMULATOR') ||
        history.some((item) => item.simulation_mode);

      const limitations = buildLimitations({
        containsSimulatedData,
        hasAssociatedDrill: association !== null,
        mechanisms,
        completeness: dataWindow.completeness,
      });
      const issuedAt = new Date().toISOString();
      const passportId = randomUUID();
      const [maxVersion] = await tx
        .select({ version: sql<number>`coalesce(max(version), 0)` })
        .from(schema.passports)
        .where(eq(schema.passports.facilityId, facilityId));
      const version = Number(maxVersion?.version ?? 0) + 1;

      const evidenceSource = {
        schema_version: CANONICAL_SCHEMA_VERSION,
        passport_id: passportId,
        passport_version: version,
        issued_at: issuedAt,
        facility: {
          id: facility.id,
          organization_id: organizationId,
          name: facility.name,
          timezone: facility.timezone,
        },
        envelope: canonicalEnvelopeSource(envelope, mechanisms),
        constraints: {
          id: constraints.id,
          version: constraints.version,
          minimum_safe_load_kw: constraints.minimumSafeLoadKw,
          maximum_curtailment_kw: constraints.maximumCurtailmentKw,
          maximum_ramp_kw_per_min: constraints.maximumRampKwPerMin,
          maximum_duration_min: constraints.maximumDurationMin,
          excluded_workloads: stringArray(constraints.excludedWorkloads),
        },
        data_quality: {
          completeness: dataWindow.completeness.toFixed(4),
          window_start: dataWindow.windowStart,
          window_end: dataWindow.windowEnd,
          observed_intervals: dataWindow.observedIntervals,
          contains_simulated_data: containsSimulatedData,
          connectors: connectors.map((connector) => ({
            id: connector.id,
            type: connector.connectorType,
            status: connector.status,
            last_success_at: connector.lastSuccessAt
              ? toRfc3339(connector.lastSuccessAt)
              : null,
          })),
        },
        associated_drill: association
          ? {
              drill_id: association.drill.id,
              status: association.drill.status,
              mrv_report_id: association.mrv.id,
              methodology_version: association.mrv.methodologyVersion,
              evidence_bundle_id: association.evidence.id,
              evidence_sha256: association.evidence.canonicalSha256,
            }
          : null,
        limitations,
      } satisfies CanonicalInput;

      const sealedEvidence = sealDocument(evidenceSource);
      const [evidence] = await tx
        .insert(schema.evidenceBundles)
        .values({
          organizationId,
          facilityId,
          drillId: association?.drill.id ?? null,
          mrvReportId: association?.mrv.id ?? null,
          schemaVersion: CANONICAL_SCHEMA_VERSION,
          canonicalJson: sealedEvidence.canonicalJson,
          canonicalSha256: sealedEvidence.sha256,
        })
        .returning();

      const document: PassportDocument = passportDocumentSchema.parse({
        id: passportId,
        facility_id: facilityId,
        version,
        evidence_bundle_id: evidence!.id,
        evidence_sha256: evidence!.canonicalSha256,
        issued_at: toRfc3339(issuedAt),
        facility: {
          name: facility.name,
          timezone: facility.timezone,
          region: facility.region,
          market: facility.market,
        },
        methodology_version: envelope.methodologyVersion,
        envelope: passportEnvelope(envelope, mechanisms),
        safety: {
          minimum_safe_load_kw: constraints.minimumSafeLoadKw,
          maximum_curtailment_kw: constraints.maximumCurtailmentKw,
          maximum_ramp_kw_per_min: constraints.maximumRampKwPerMin,
          maximum_duration_min: constraints.maximumDurationMin,
          excluded_workloads: stringArray(constraints.excludedWorkloads),
          constraints_version: constraints.version,
        },
        data_quality: {
          completeness: dataWindow.completeness.toFixed(4),
          window_start: dataWindow.windowStart,
          window_end: dataWindow.windowEnd,
          connector_provenance: connectors.map((connector) => ({
            connector_type: connector.connectorType,
            name: connector.name,
            last_success_at: connector.lastSuccessAt
              ? toRfc3339(connector.lastSuccessAt)
              : null,
          })),
          contains_simulated_data: containsSimulatedData,
        },
        drill_history: history,
        limitations,
        notes: body.notes ?? null,
      });
      const sealedPassport = sealDocument(document as CanonicalInput);

      const [passport] = await tx
        .insert(schema.passports)
        .values({
          id: passportId,
          organizationId,
          facilityId,
          envelopeId: envelope.id,
          evidenceBundleId: evidence!.id,
          version,
          status: 'ISSUED',
          passportJson: sealedPassport.canonicalJson,
          passportSha256: sealedPassport.sha256,
          issuedAt,
          issuedBy: userId,
        })
        .returning();

      // Insert the new version before pointing older versions at it so the
      // immediate superseded_by foreign key is valid. Only lifecycle metadata
      // changes; prior passport_json and passport_sha256 remain untouched.
      await tx
        .update(schema.passports)
        .set({ status: 'SUPERSEDED', supersededBy: passportId })
        .where(
          and(
            eq(schema.passports.facilityId, facilityId),
            eq(schema.passports.status, 'ISSUED'),
            ne(schema.passports.id, passportId),
          ),
        );

      const correlationId = randomUUID();
      if (association) {
        await tx.insert(schema.drillEvents).values({
          drillId: association.drill.id,
          eventType: 'PASSPORT_ISSUED',
          occurredAt: issuedAt,
          actorUserId: userId,
          reasonCode: 'EVIDENCE_VERIFIED',
          correlationId,
          payload: {
            passport_id: passportId,
            passport_version: version,
            passport_sha256: sealedPassport.sha256,
          },
        });
      }
      await tx.insert(schema.auditLogs).values({
        organizationId,
        facilityId,
        actorUserId: userId,
        action: 'PASSPORT_ISSUED',
        objectType: 'passports',
        objectId: passportId,
        afterState: {
          version,
          status: 'ISSUED',
          passport_sha256: sealedPassport.sha256,
          evidence_sha256: sealedEvidence.sha256,
          contains_simulated_data: containsSimulatedData,
        },
        requestId: correlationId,
      });

      return { passport: toPassportRecord(passport!, evidence!.canonicalSha256) };
    });
  }

  @Get('facilities/:facilityId/passports/current')
  async current(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
  ) {
    await this.scope.requireFacility(userId, facilityId, 'passport:read');
    const [record] = await this.db
      .select({
        passport: schema.passports,
        evidenceSha256: schema.evidenceBundles.canonicalSha256,
      })
      .from(schema.passports)
      .innerJoin(
        schema.evidenceBundles,
        eq(schema.evidenceBundles.id, schema.passports.evidenceBundleId),
      )
      .where(
        and(
          eq(schema.passports.facilityId, facilityId),
          eq(schema.passports.status, 'ISSUED'),
        ),
      )
      .orderBy(desc(schema.passports.version))
      .limit(1);

    return {
      passport: record
        ? toPassportRecord(record.passport, record.evidenceSha256)
        : null,
    };
  }

  @Get('facilities/:facilityId/passports')
  async list(
    @CurrentUserId() userId: string,
    @Param('facilityId', new ZodValidationPipe(uuidSchema)) facilityId: string,
  ) {
    await this.scope.requireFacility(userId, facilityId, 'passport:read');
    const rows = await this.db
      .select({
        passport: schema.passports,
        evidenceSha256: schema.evidenceBundles.canonicalSha256,
      })
      .from(schema.passports)
      .innerJoin(
        schema.evidenceBundles,
        eq(schema.evidenceBundles.id, schema.passports.evidenceBundleId),
      )
      .where(eq(schema.passports.facilityId, facilityId))
      .orderBy(desc(schema.passports.version));

    return {
      passports: rows.map(({ passport, evidenceSha256 }) => {
        const document = parsePassportDocument(passport.passportJson, passport.id);
        return {
          id: passport.id,
          facility_id: passport.facilityId,
          version: passport.version,
          status: passport.status,
          passport_sha256: passport.passportSha256,
          evidence_sha256: evidenceSha256,
          issued_at: passport.issuedAt ? toRfc3339(passport.issuedAt) : null,
          superseded_by: passport.supersededBy,
          contains_simulated_data: document.data_quality.contains_simulated_data,
        };
      }),
    };
  }

  @Get('passports/:passportId')
  async detail(
    @CurrentUserId() userId: string,
    @Param('passportId', new ZodValidationPipe(uuidSchema)) passportId: string,
  ) {
    const record = await this.requirePassport(userId, passportId);
    return { passport: toPassportRecord(record.passport, record.evidence.canonicalSha256) };
  }

  @Get('passports/:passportId/json')
  async json(
    @CurrentUserId() userId: string,
    @Param('passportId', new ZodValidationPipe(uuidSchema)) passportId: string,
  ) {
    const record = await this.requirePassport(userId, passportId);
    return {
      canonicalization_schema_version: record.evidence.schemaVersion,
      passport_sha256: record.passport.passportSha256,
      passport_json: parsePassportDocument(record.passport.passportJson, passportId),
    };
  }

  @Get('passports/:passportId/pdf')
  async pdf(
    @CurrentUserId() userId: string,
    @Param('passportId', new ZodValidationPipe(uuidSchema)) passportId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const record = await this.requirePassport(userId, passportId);
    const document = parsePassportDocument(record.passport.passportJson, passportId);
    const rendered = renderPassportExport(
      'PDF',
      record.passport.passportSha256,
      document,
    );
    reply.header('content-type', rendered.contentType);
    reply.header(
      'content-disposition',
      `attachment; filename="gridflex-passport-v${record.passport.version}-${passportId}.pdf"`,
    );
    reply.header('cache-control', 'private, no-store');
    return Buffer.from(rendered.content, 'base64');
  }

  @Get('passports/:passportId/verify')
  async verify(
    @CurrentUserId() userId: string,
    @Param('passportId', new ZodValidationPipe(uuidSchema)) passportId: string,
  ) {
    const record = await this.requirePassport(userId, passportId);
    const document = parsePassportDocument(record.passport.passportJson, passportId);
    const passportVerification = verifyDocument(
      document as CanonicalInput,
      record.passport.passportSha256,
    );
    const evidenceVerification = verifyDocument(
      record.evidence.canonicalJson as CanonicalInput,
      record.evidence.canonicalSha256,
    );

    return {
      passport_id: record.passport.id,
      version: record.passport.version,
      status: record.passport.status,
      stored_passport_sha256: record.passport.passportSha256,
      recomputed_passport_sha256: passportVerification.actualSha256,
      passport_hash_matches: passportVerification.valid,
      stored_evidence_sha256: record.evidence.canonicalSha256,
      recomputed_evidence_sha256: evidenceVerification.actualSha256,
      evidence_hash_matches: evidenceVerification.valid,
      verified_at: toRfc3339(new Date().toISOString()),
      canonicalization_schema_version: record.evidence.schemaVersion,
      instructions:
        'Canonicalize the returned passport_json with recursively sorted keys, UTF-8, no insignificant whitespace, UTC timestamps, and decimal strings; then compare SHA-256.',
    };
  }

  @Post('passports/:passportId/exports')
  @HttpCode(201)
  async createExport(
    @CurrentUserId() userId: string,
    @Param('passportId', new ZodValidationPipe(uuidSchema)) passportId: string,
    @Body(zodBody(createPassportExportRequestSchema)) body: CreatePassportExportRequest,
  ) {
    const record = await this.requirePassport(userId, passportId, 'export:create');
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + EXPORT_TTL_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const [created] = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(schema.exportPackages)
        .values({
          organizationId: record.passport.organizationId,
          facilityId: record.passport.facilityId,
          passportId,
          counterpartyName: body.counterparty_name,
          formatCode: body.format,
          status: 'READY',
          storageUri: `database://passports/${passportId}/${record.passport.passportSha256}.${body.format.toLowerCase()}`,
          expiresAt,
          requestedBy: userId,
          completedAt: now.toISOString(),
        })
        .returning();

      await tx.insert(schema.auditLogs).values({
        organizationId: record.passport.organizationId,
        facilityId: record.passport.facilityId,
        actorUserId: userId,
        action: 'PASSPORT_EXPORT_CREATED',
        objectType: 'export_packages',
        objectId: inserted[0]!.id,
        afterState: {
          passport_id: passportId,
          format: body.format,
          counterparty_name: body.counterparty_name ?? null,
        },
      });
      return inserted;
    });

    return {
      export: toExportMetadata(created!),
      download_url: `/api/v1/exports/${created!.id}`,
    };
  }

  @Get('exports/:exportId')
  async export(
    @CurrentUserId() userId: string,
    @Param('exportId', new ZodValidationPipe(uuidSchema)) exportId: string,
  ) {
    const [row] = await this.db
      .select({ package: schema.exportPackages, passport: schema.passports })
      .from(schema.exportPackages)
      .innerJoin(schema.passports, eq(schema.passports.id, schema.exportPackages.passportId))
      .where(eq(schema.exportPackages.id, exportId))
      .limit(1);
    if (!row) throw new DomainError('NOT_FOUND', 'Export not found.', undefined, 404);
    await this.scope.requireFacility(userId, row.package.facilityId, 'passport:read');
    if (
      row.package.status !== 'READY' ||
      (row.package.expiresAt !== null && Date.parse(row.package.expiresAt) <= Date.now())
    ) {
      throw new DomainError(
        'NOT_FOUND',
        'This export is no longer available. Create a new export from the Passport.',
        undefined,
        404,
      );
    }

    const document = parsePassportDocument(row.passport.passportJson, row.passport.id);
    const rendered = renderPassportExport(
      row.package.formatCode,
      row.passport.passportSha256,
      document,
    );
    return {
      export: toExportMetadata(row.package),
      content_type: rendered.contentType,
      content_encoding: rendered.contentEncoding,
      filename: `gridflex-passport-v${row.passport.version}-${row.passport.id}.${rendered.extension}`,
      content: rendered.content,
    };
  }

  private async requirePassport(
    userId: string,
    passportId: string,
    permission: Permission = 'passport:read',
  ) {
    const [record] = await this.db
      .select({ passport: schema.passports, evidence: schema.evidenceBundles })
      .from(schema.passports)
      .innerJoin(
        schema.evidenceBundles,
        eq(schema.evidenceBundles.id, schema.passports.evidenceBundleId),
      )
      .where(eq(schema.passports.id, passportId))
      .limit(1);
    if (!record) throw new DomainError('NOT_FOUND', 'Passport not found.', undefined, 404);
    await this.scope.requireFacility(userId, record.passport.facilityId, permission);
    return record;
  }
}

type EnvelopeRow = typeof schema.envelopes.$inferSelect;
type EnvelopeMechanismRow = Awaited<ReturnType<typeof loadEnvelopeMechanisms>>[number];

async function lockFacility(tx: Database, facilityId: string): Promise<void> {
  const result = await tx.execute(
    sql`select id from facilities where id = ${facilityId} for update`,
  );
  if (result.rowCount === 0) {
    throw new DomainError('NOT_FOUND', 'Facility not found.', undefined, 404);
  }
}

async function loadEnvelopeMechanisms(tx: Database, envelopeId: string) {
  return tx
    .select({
      mechanismId: schema.envelopeMechanisms.mechanismId,
      code: schema.flexibilityMechanisms.code,
      name: schema.flexibilityMechanisms.name,
      provenance: schema.envelopeMechanisms.provenance,
      reducibleKw: schema.envelopeMechanisms.reducibleKw,
      responseTimeSeconds: schema.envelopeMechanisms.responseTimeSeconds,
      rampKwPerMin: schema.envelopeMechanisms.rampKwPerMin,
      durationMin: schema.envelopeMechanisms.durationMin,
      reboundPeakKw: schema.envelopeMechanisms.reboundPeakKw,
      reboundDurationMin: schema.envelopeMechanisms.reboundDurationMin,
      confidenceScore: schema.envelopeMechanisms.confidenceScore,
      evidenceRefs: schema.envelopeMechanisms.evidenceRefs,
      notes: schema.envelopeMechanisms.notes,
    })
    .from(schema.envelopeMechanisms)
    .innerJoin(
      schema.flexibilityMechanisms,
      eq(schema.flexibilityMechanisms.id, schema.envelopeMechanisms.mechanismId),
    )
    .where(eq(schema.envelopeMechanisms.envelopeId, envelopeId))
    .orderBy(asc(schema.flexibilityMechanisms.code));
}

async function resolveDrillAssociation(
  tx: Database,
  facilityId: string,
  requestedDrillId?: string,
) {
  const [drill] = requestedDrillId
    ? await tx
        .select()
        .from(schema.drills)
        .where(
          and(
            eq(schema.drills.id, requestedDrillId),
            eq(schema.drills.facilityId, facilityId),
          ),
        )
        .limit(1)
    : await tx
        .select()
        .from(schema.drills)
        .where(
          and(
            eq(schema.drills.facilityId, facilityId),
            eq(schema.drills.status, 'COMPLETED'),
          ),
        )
        .orderBy(desc(schema.drills.endedAt), desc(schema.drills.createdAt))
        .limit(1);

  if (requestedDrillId && !drill) {
    throw new DomainError('NOT_FOUND', 'Drill not found for this facility.', undefined, 404);
  }
  if (!drill) return null;
  if (drill.status !== 'COMPLETED') {
    throw new DomainError(
      'PASSPORT_BLOCKED',
      'An associated drill must be evidence-verified and COMPLETED.',
      { blocker: 'DRILL_NOT_VERIFIED', drill_status: drill.status },
      409,
    );
  }

  const [mrv] = await tx
    .select()
    .from(schema.mrvReports)
    .where(eq(schema.mrvReports.drillId, drill.id))
    .limit(1);
  if (!mrv) {
    throw new DomainError(
      'MRV_NOT_GENERATED',
      'The associated drill has no MRV report.',
      undefined,
      409,
    );
  }
  if (Number(mrv.telemetryCompleteness) < 0.9 || mrv.maximumGapIntervals > 2) {
    throw new DomainError(
      'PASSPORT_BLOCKED',
      'The associated drill MRV does not meet the certification quality threshold.',
      {
        blocker: 'MRV_INSUFFICIENT_DATA',
        telemetry_completeness: mrv.telemetryCompleteness,
        maximum_gap_intervals: mrv.maximumGapIntervals,
      },
      409,
    );
  }
  const [evidence] = await tx
    .select()
    .from(schema.evidenceBundles)
    .where(
      and(
        eq(schema.evidenceBundles.drillId, drill.id),
        eq(schema.evidenceBundles.mrvReportId, mrv.id),
      ),
    )
    .orderBy(asc(schema.evidenceBundles.createdAt))
    .limit(1);
  if (!evidence) {
    throw new DomainError(
      'PASSPORT_BLOCKED',
      'The associated drill has no evidence bundle.',
      { blocker: 'EVIDENCE_MISSING' },
      409,
    );
  }
  if (!verifyDocument(evidence.canonicalJson as CanonicalInput, evidence.canonicalSha256).valid) {
    throw new DomainError(
      'EVIDENCE_HASH_MISMATCH',
      'The associated drill evidence hash does not match its canonical JSON.',
      { evidence_bundle_id: evidence.id },
      409,
    );
  }
  return { drill, mrv, evidence };
}

async function loadDrillHistory(tx: Database, facilityId: string) {
  const drills = await tx
    .select()
    .from(schema.drills)
    .where(eq(schema.drills.facilityId, facilityId))
    .orderBy(desc(schema.drills.createdAt))
    .limit(20);
  const ids = drills.map((drill) => drill.id);
  const reports = ids.length > 0
    ? await tx
        .select()
        .from(schema.mrvReports)
        .where(inArray(schema.mrvReports.drillId, ids))
    : [];
  const byDrill = new Map(reports.map((report) => [report.drillId, report]));

  return drills.map((drill) => {
    const report = byDrill.get(drill.id);
    return {
      drill_id: drill.id,
      name: drill.name,
      status: drill.status,
      started_at: drill.startedAt ? toRfc3339(drill.startedAt) : null,
      requested_reduction_kw: drill.requestedReductionKw,
      delivered_energy_wh: report ? String(report.deliveredEnergyWh) : null,
      performance_bps: report?.performanceBps ?? null,
      simulation_mode: drill.simulationMode,
    };
  });
}

export async function loadDataWindow(tx: Database, facilityId: string, fallback: string) {
  const windowEndCutoff = new Date();
  const windowStartCutoff = new Date(
    windowEndCutoff.getTime() - 24 * 60 * 60 * 1_000,
  ).toISOString();
  const [row] = await tx
    .select({
      windowStart: sql<string | null>`min(${schema.telemetryReadings.measuredAt})`,
      windowEnd: sql<string | null>`max(${schema.telemetryReadings.measuredAt})`,
      observedIntervals: sql<number>`count(distinct date_trunc('minute', ${schema.telemetryReadings.measuredAt}))::int`,
    })
    .from(schema.telemetryReadings)
    .where(
      and(
        eq(schema.telemetryReadings.facilityId, facilityId),
        eq(schema.telemetryReadings.metricKey, 'facility.active_power_kw'),
        inArray(schema.telemetryReadings.quality, ['GOOD', 'ESTIMATED']),
        sql`${schema.telemetryReadings.measuredAt} >= ${windowStartCutoff}`,
        lte(schema.telemetryReadings.measuredAt, windowEndCutoff.toISOString()),
      ),
    );
  const fallbackEnd = new Date(fallback);
  const fallbackStart = new Date(fallbackEnd.getTime() - 24 * 60 * 60 * 1000);
  return {
    windowStart: toRfc3339(row?.windowStart ?? fallbackStart.toISOString()),
    windowEnd: toRfc3339(row?.windowEnd ?? fallbackEnd.toISOString()),
    observedIntervals: row?.observedIntervals ?? 0,
    completeness: Math.min(1, (row?.observedIntervals ?? 0) / 1_440),
  };
}

function canonicalEnvelopeSource(envelope: EnvelopeRow, mechanisms: EnvelopeMechanismRow[]) {
  return {
    id: envelope.id,
    version: envelope.version,
    status: envelope.status,
    as_of: toRfc3339(envelope.asOf),
    valid_until: envelope.validUntil ? toRfc3339(envelope.validUntil) : null,
    total_reducible_kw: envelope.totalReducibleKw,
    response_time_seconds: envelope.responseTimeSeconds,
    sustainable_duration_min: envelope.sustainableDurationMin,
    aggregate_ramp_kw_per_min: envelope.aggregateRampKwPerMin,
    confidence_score: ratioString(envelope.confidenceScore),
    telemetry_completeness: ratioString(envelope.telemetryCompleteness),
    methodology_version: envelope.methodologyVersion,
    constraints_version: envelope.constraintsVersion,
    mechanisms: mechanisms.map((mechanism) => ({
      mechanism_id: mechanism.mechanismId,
      provenance: mechanism.provenance,
      reducible_kw: mechanism.reducibleKw,
      response_time_seconds: mechanism.responseTimeSeconds,
      ramp_kw_per_min: mechanism.rampKwPerMin,
      duration_min: mechanism.durationMin,
      confidence_score: ratioString(mechanism.confidenceScore),
      evidence_refs: stringArray(mechanism.evidenceRefs),
    })),
  };
}

function passportEnvelope(envelope: EnvelopeRow, mechanisms: EnvelopeMechanismRow[]) {
  return {
    id: envelope.id,
    facility_id: envelope.facilityId,
    version: envelope.version,
    status: 'CURRENT' as const,
    as_of: toRfc3339(envelope.asOf),
    valid_until: envelope.validUntil ? toRfc3339(envelope.validUntil) : null,
    total_reducible_kw: envelope.totalReducibleKw,
    response_time_seconds: envelope.responseTimeSeconds,
    sustainable_duration_min: envelope.sustainableDurationMin,
    aggregate_ramp_kw_per_min: envelope.aggregateRampKwPerMin,
    rebound_peak_kw: envelope.reboundPeakKw,
    rebound_duration_min: envelope.reboundDurationMin,
    confidence_score: ratioString(envelope.confidenceScore),
    telemetry_completeness: ratioString(envelope.telemetryCompleteness),
    methodology_version: envelope.methodologyVersion,
    constraints_version: envelope.constraintsVersion,
    blocked_reasons: blockedReasons(envelope.blockedReasons),
    mechanisms: mechanisms.map((mechanism) => ({
      mechanism_id: mechanism.mechanismId,
      mechanism_code: mechanism.code,
      mechanism_name: mechanism.name,
      provenance: mechanism.provenance,
      reducible_kw: mechanism.reducibleKw,
      response_time_seconds: mechanism.responseTimeSeconds,
      ramp_kw_per_min: mechanism.rampKwPerMin,
      duration_min: mechanism.durationMin,
      rebound_peak_kw: mechanism.reboundPeakKw,
      rebound_duration_min: mechanism.reboundDurationMin,
      confidence_score: ratioString(mechanism.confidenceScore),
      evidence_refs: stringArray(mechanism.evidenceRefs),
      notes: mechanism.notes,
    })),
    created_at: toRfc3339(envelope.createdAt),
  };
}

function buildLimitations(input: {
  containsSimulatedData: boolean;
  hasAssociatedDrill: boolean;
  mechanisms: EnvelopeMechanismRow[];
  completeness: number;
}): string[] {
  const limitations = [
    'Pilot evidence uses the available telemetry window; production certification targets at least 14 days of coverage.',
    'GridFlex does not autonomously dispatch facility equipment; every drill requires an operator.',
  ];
  if (input.containsSimulatedData) {
    limitations.push(
      'This Passport contains simulated data and is suitable for pilot evaluation, not a production dispatch claim.',
    );
  }
  if (!input.hasAssociatedDrill) {
    limitations.push(
      'No completed drill is associated with this version; capacity is modeled or declared rather than test-verified.',
    );
  }
  if (input.mechanisms.some((mechanism) => mechanism.provenance !== 'TESTED')) {
    limitations.push(
      'At least one mechanism remains declared or modeled and must not be described as tested.',
    );
  }
  if (input.completeness < 0.95) {
    limitations.push(
      'Telemetry completeness passes the pilot threshold but remains below the 95% production-quality target.',
    );
  }
  return limitations;
}

function toPassportRecord(
  row: typeof schema.passports.$inferSelect,
  evidenceSha256: string,
) {
  const document = parsePassportDocument(row.passportJson, row.id);
  if (document.evidence_sha256 !== evidenceSha256) {
    throw new DomainError(
      'EVIDENCE_HASH_MISMATCH',
      'Passport evidence reference does not match the stored evidence bundle.',
      { passport_id: row.id },
      409,
    );
  }
  return {
    status: row.status,
    passport_sha256: row.passportSha256,
    superseded_by: row.supersededBy,
    revocation_reason: row.revocationReason,
    document,
  };
}

function parsePassportDocument(value: unknown, passportId: string): PassportDocument {
  const parsed = passportDocumentSchema.safeParse(value);
  if (!parsed.success) {
    throw new DomainError(
      'CANONICALIZATION_FAILED',
      'Stored Passport JSON does not match the issuance schema.',
      { passport_id: passportId },
      409,
    );
  }
  return parsed.data;
}

function ratioString(value: string | number): string {
  return Number(value).toFixed(4);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function blockedReasons(value: unknown): { code: string; detail: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    return typeof record.code === 'string' && typeof record.detail === 'string'
      ? [{ code: record.code, detail: record.detail }]
      : [];
  });
}

function toExportMetadata(row: typeof schema.exportPackages.$inferSelect) {
  return {
    id: row.id,
    passport_id: row.passportId,
    facility_id: row.facilityId,
    format: row.formatCode,
    status: row.status,
    counterparty_name: row.counterpartyName,
    created_at: toRfc3339(row.createdAt),
    completed_at: row.completedAt ? toRfc3339(row.completedAt) : null,
    expires_at: row.expiresAt ? toRfc3339(row.expiresAt) : null,
  };
}

export function renderPassportExport(
  format: string,
  passportSha256: string,
  document: PassportDocument,
): {
  contentType: string;
  extension: string;
  content: string;
  contentEncoding: 'utf8' | 'base64';
} {
  const exportDocument = { passport_sha256: passportSha256, document };
  if (format === 'JSON') {
    return {
      contentType: 'application/json',
      extension: 'json',
      content: canonicalStringify(exportDocument as CanonicalInput),
      contentEncoding: 'utf8',
    };
  }
  if (format === 'CSV') {
    const rows = flattenForCsv(exportDocument);
    const content = [
      'field,value',
      ...rows.map(([field, value]) => `${csvCell(field)},${csvCell(value)}`),
    ].join('\r\n');
    return {
      contentType: 'text/csv; charset=utf-8',
      extension: 'csv',
      content,
      contentEncoding: 'utf8',
    };
  }
  if (format === 'PDF') {
    return {
      contentType: 'application/pdf',
      extension: 'pdf',
      content: renderPassportPdf(passportSha256, document).toString('base64'),
      contentEncoding: 'base64',
    };
  }
  throw new DomainError('VALIDATION_FAILED', 'Unsupported export format.', undefined, 400);
}

function flattenForCsv(value: unknown, path = ''): [string, string][] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flattenForCsv(item, `${path}[${index}]`));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .flatMap((key) =>
        flattenForCsv(
          (value as Record<string, unknown>)[key],
          path ? `${path}.${key}` : key,
        ),
      );
  }
  return [[path, value === null ? '' : String(value)]];
}

function csvCell(value: string): string {
  // Quoting alone does not stop spreadsheet formula execution. Prefix formula
  // leaders before quoting so an exported facility name cannot become a formula.
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
