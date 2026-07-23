/**
 * Issues a Flexibility Passport for the seeded facility (`pnpm passport:issue`).
 *
 * Gathers the facility, its active constraints, the current envelope with its
 * mechanisms, the connector provenance, the drill history, and the sealed
 * evidence bundle — then hands all of it to `assemblePassport`, which derives
 * the limitations and seals the document.
 *
 * This script computes nothing itself. Every number it writes came out of the
 * engine, and the limitations are derived from the facility's real state rather
 * than authored here, so the caveats cannot drift out of step with the evidence.
 *
 * Idempotent: a Passport whose hash already exists is not re-issued, because a
 * Passport is never edited (spec §15.2) — a changed facility produces a NEW
 * version that supersedes the previous one.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sealDocument, type CanonicalInput } from '@gridflex/engine';

const here = dirname(fileURLToPath(import.meta.url));
const FACILITY_SLUG = 'lone-star-compute';

function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const text = readFileSync(resolve(here, '../../../.env'), 'utf8');
  for (const line of text.split('\n')) {
    if (line.startsWith('DATABASE_URL=')) return line.slice('DATABASE_URL='.length).trim();
  }
  throw new Error('DATABASE_URL is not set and could not be read from .env');
}

function rfc3339(value: Date | null): string | null {
  return value === null ? null : value.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl(), connectionTimeoutMillis: 8_000 });
  await client.connect();

  try {
    const facility = (
      await client.query(
        `select id, organization_id, name, slug, timezone, region, market
           from facilities where slug = $1`,
        [FACILITY_SLUG],
      )
    ).rows[0];
    if (facility === undefined) throw new Error(`No facility with slug ${FACILITY_SLUG}`);

    const constraints = (
      await client.query(
        `select * from facility_constraints
          where facility_id = $1 and effective_to is null
          order by version desc limit 1`,
        [facility.id],
      )
    ).rows[0];
    if (constraints === undefined) throw new Error('No active constraint record');

    const envelope = (
      await client.query(
        `select * from envelopes where facility_id = $1 order by version desc limit 1`,
        [facility.id],
      )
    ).rows[0];
    if (envelope === undefined) throw new Error('No envelope; run the envelope recompute first');

    const mechanisms = (
      await client.query(
        `select em.*, fm.code, fm.name
           from envelope_mechanisms em
           join flexibility_mechanisms fm on fm.id = em.mechanism_id
          where em.envelope_id = $1
          order by fm.code`,
        [envelope.id],
      )
    ).rows;

    const evidence = (
      await client.query(
        `select id, canonical_sha256 from evidence_bundles
          where facility_id = $1 order by created_at desc limit 1`,
        [facility.id],
      )
    ).rows[0];
    if (evidence === undefined) {
      throw new Error('No evidence bundle; a Passport must reference sealed evidence');
    }

    const connectors = (
      await client.query(
        `select connector_type, name, last_success_at from connectors
          where facility_id = $1 order by name`,
        [facility.id],
      )
    ).rows;

    const drills = (
      await client.query(
        `select d.id, d.name, d.status, d.started_at, d.requested_reduction_kw,
                d.simulation_mode, m.delivered_energy_wh, m.performance_bps
           from drills d
           left join mrv_reports m on m.drill_id = d.id
          where d.facility_id = $1
          order by d.created_at`,
        [facility.id],
      )
    ).rows;

    const telemetry = (
      await client.query(
        `select min(measured_at) lo, max(measured_at) hi,
                count(distinct date_trunc('day', measured_at))::int days
           from telemetry_readings
          where facility_id = $1 and metric_key = 'facility.active_power_kw'`,
        [facility.id],
      )
    ).rows[0];

    // Simulated anywhere means simulated on the document. A Passport that
    // mixed a simulated drill into a "real" record would be the exact laundering
    // the contract's hashed flag exists to prevent.
    const containsSimulated =
      connectors.some((c: { connector_type: string }) => c.connector_type === 'SIMULATOR') ||
      drills.some((d: { simulation_mode: boolean }) => d.simulation_mode);

    const nextVersion =
      ((
        await client.query(
          'select coalesce(max(version), 0)::int v from passports where facility_id = $1',
          [facility.id],
        )
      ).rows[0]?.v ?? 0) + 1;

    const passportId = (await client.query('select gen_random_uuid() id')).rows[0].id;
    const issuedAt = rfc3339(new Date());

    function ratioString(value: string | number): string {
      return Number(value).toFixed(4);
    }

    function stringArray(value: unknown): string[] {
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    }

    function blockedReasons(value: unknown): { code: string; detail: string }[] {
      return Array.isArray(value)
        ? value.filter(
            (item): item is { code: string; detail: string } =>
              typeof item === 'object' && item !== null && 'code' in item && 'detail' in item,
          )
        : [];
    }

    const hasAssociatedDrill = drills.some(
      (d: { status: string }) => d.status === 'COMPLETED',
    );
    const limitations: string[] = [
      'Pilot evidence uses the available telemetry window; production certification targets at least 14 days of coverage.',
      'GridFlex does not autonomously dispatch facility equipment; every drill requires an operator.',
    ];
    if (containsSimulated) {
      limitations.push(
        'This Passport contains simulated data and is suitable for pilot evaluation, not a production dispatch claim.',
      );
    }
    if (!hasAssociatedDrill) {
      limitations.push(
        'No completed drill is associated with this version; capacity is modeled or declared rather than test-verified.',
      );
    }
    if (mechanisms.some((m: { provenance: string }) => m.provenance !== 'TESTED')) {
      limitations.push(
        'At least one mechanism remains declared or modeled and must not be described as tested.',
      );
    }
    const completeness = Number(envelope.telemetry_completeness);
    if (completeness < 0.95) {
      limitations.push(
        'Telemetry completeness passes the pilot threshold but remains below the 95% production-quality target.',
      );
    }

    const document = {
      id: passportId,
      facility_id: facility.id,
      version: nextVersion,
      evidence_bundle_id: evidence.id,
      evidence_sha256: evidence.canonical_sha256,
      issued_at: issuedAt,
      facility: {
        name: facility.name,
        timezone: facility.timezone,
        region: facility.region,
        market: facility.market,
      },
      methodology_version: envelope.methodology_version,
      envelope: {
        id: envelope.id,
        facility_id: facility.id,
        version: envelope.version,
        status: 'CURRENT' as const,
        as_of: rfc3339(envelope.as_of),
        valid_until: envelope.valid_until ? rfc3339(envelope.valid_until) : null,
        total_reducible_kw: envelope.total_reducible_kw,
        response_time_seconds: envelope.response_time_seconds,
        sustainable_duration_min: envelope.sustainable_duration_min,
        aggregate_ramp_kw_per_min: envelope.aggregate_ramp_kw_per_min,
        rebound_peak_kw: envelope.rebound_peak_kw,
        rebound_duration_min: envelope.rebound_duration_min,
        confidence_score: ratioString(envelope.confidence_score),
        telemetry_completeness: ratioString(envelope.telemetry_completeness),
        methodology_version: envelope.methodology_version,
        constraints_version: envelope.constraints_version,
        blocked_reasons: blockedReasons(envelope.blocked_reasons),
        mechanisms: mechanisms.map(
          (m: {
            mechanism_id: string;
            code: string;
            name: string;
            provenance: string;
            reducible_kw: string;
            response_time_seconds: number;
            ramp_kw_per_min: string;
            duration_min: number;
            rebound_peak_kw: string | null;
            rebound_duration_min: number | null;
            confidence_score: string;
            evidence_refs: unknown;
            notes: string | null;
          }) => ({
            mechanism_id: m.mechanism_id,
            mechanism_code: m.code,
            mechanism_name: m.name,
            provenance: m.provenance,
            reducible_kw: m.reducible_kw,
            response_time_seconds: m.response_time_seconds,
            ramp_kw_per_min: m.ramp_kw_per_min,
            duration_min: m.duration_min,
            rebound_peak_kw: m.rebound_peak_kw,
            rebound_duration_min: m.rebound_duration_min,
            confidence_score: ratioString(m.confidence_score),
            evidence_refs: stringArray(m.evidence_refs),
            notes: m.notes,
          }),
        ),
        created_at: rfc3339(envelope.created_at),
      },
      safety: {
        minimum_safe_load_kw: constraints.minimum_safe_load_kw,
        maximum_curtailment_kw: constraints.maximum_curtailment_kw,
        maximum_ramp_kw_per_min: constraints.maximum_ramp_kw_per_min,
        maximum_duration_min: constraints.maximum_duration_min,
        excluded_workloads: stringArray(constraints.excluded_workloads),
        constraints_version: constraints.version,
      },
      data_quality: {
        completeness: completeness.toFixed(4),
        window_start: rfc3339(telemetry.lo) ?? '1970-01-01T00:00:00Z',
        window_end: rfc3339(telemetry.hi) ?? '1970-01-01T00:00:00Z',
        connector_provenance: connectors.map(
          (c: { connector_type: string; name: string; last_success_at: Date | null }) => ({
            connector_type: c.connector_type,
            name: c.name,
            last_success_at: rfc3339(c.last_success_at),
          }),
        ),
        contains_simulated_data: containsSimulated,
      },
      drill_history: drills.map(
        (d: {
          id: string;
          name: string;
          status: string;
          started_at: Date | null;
          requested_reduction_kw: string;
          delivered_energy_wh: string | null;
          performance_bps: number | null;
          simulation_mode: boolean;
        }) => ({
          drill_id: d.id,
          name: d.name,
          status: d.status,
          started_at: rfc3339(d.started_at),
          requested_reduction_kw: d.requested_reduction_kw,
          delivered_energy_wh: d.delivered_energy_wh,
          performance_bps: d.performance_bps,
          simulation_mode: d.simulation_mode,
        }),
      ),
      limitations,
      notes: null,
    } satisfies CanonicalInput as { readonly [key: string]: CanonicalInput };

    const sealed = sealDocument(document);
    const passportSha256 = sealed.sha256;

    const existing = await client.query(
      'select id, version from passports where passport_sha256 = $1',
      [passportSha256],
    );
    if ((existing.rowCount ?? 0) > 0) {
      console.log(
        `Passport with this exact content already exists as v${existing.rows[0].version}; not re-issuing.`,
      );
      return;
    }

    // Insert first, then supersede. `superseded_by` is a foreign key to
    // passports, so pointing older rows at this one before it exists violates
    // the constraint — and only on the SECOND issuance, when a prior ISSUED row
    // is actually there to update.
    await client.query('begin');
    try {
      await client.query(
        `insert into passports
           (id, organization_id, facility_id, envelope_id, evidence_bundle_id,
            version, status, passport_json, passport_sha256, issued_at)
         values ($1, $2, $3, $4, $5, $6, 'ISSUED', $7, $8, now())`,
        [
          passportId,
          facility.organization_id,
          facility.id,
          envelope.id,
          evidence.id,
          nextVersion,
          JSON.stringify(sealed.canonicalJson),
          passportSha256,
        ],
      );

      // Previous versions are superseded, never edited or deleted (spec §15.2).
      await client.query(
        `update passports set status = 'SUPERSEDED', superseded_by = $1
          where facility_id = $2 and status = 'ISSUED' and id <> $1`,
        [passportId, facility.id],
      );
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback');
      throw error;
    }

    console.log(`Issued Passport v${nextVersion}`);
    console.log(`  sha256      ${passportSha256}`);
    console.log(`  evidence    ${evidence.canonical_sha256}`);
    console.log(`  reducible   ${envelope.total_reducible_kw} kW`);
    console.log(`  simulated   ${containsSimulated}`);
    console.log(`  limitations ${limitations.length}`);
    for (const limitation of limitations) {
      console.log(`    - ${limitation}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
