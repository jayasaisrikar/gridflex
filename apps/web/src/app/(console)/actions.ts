'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiPatch, apiPost, ApiError } from '@/lib/api';
import type { ActionResult } from '@/lib/action-result';

export async function recomputeEnvelopeAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const facilityId = requiredString(formData, 'facility_id');
    const response = await apiPost<{
      envelope: {
        status: string;
        blocked_reasons: { code: string; detail: string }[];
      };
    }>(`/facilities/${facilityId}/envelopes/recompute`);
    revalidatePath('/console');
    revalidatePath('/console/envelope');
    if (response.envelope.status === 'BLOCKED') {
      const reasons = response.envelope.blocked_reasons
        .map((reason) => reason.detail)
        .join(' ');
      return {
        status: 'error',
        message: `The envelope remains blocked. ${reasons || 'Review telemetry, safety limits, and mechanisms.'}`,
        details: { code: 'ENVELOPE_BLOCKED_DATA_QUALITY' },
      };
    }
    return success('Envelope recomputed from the latest constraints and telemetry.');
  } catch (error) {
    return failure(error, 'The envelope could not be recomputed.');
  }
}

export async function createDrillAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const facilityId = requiredString(formData, 'facility_id');
    const response = await apiPost<{ drill: { id: string } }>(
      `/facilities/${facilityId}/drills`,
      {
        name: requiredString(formData, 'name'),
        requested_reduction_kw: requiredString(formData, 'requested_reduction_kw'),
        planned_start_at: utcInput(formData, 'planned_start_at'),
        planned_end_at: utcInput(formData, 'planned_end_at'),
        envelope_id: optionalString(formData, 'envelope_id'),
        operator_notes: optionalString(formData, 'operator_notes'),
        planned_ramp_kw_per_min: optionalString(formData, 'planned_ramp_kw_per_min'),
        // V1 is deliberately simulation-only. Do not derive this safety
        // boundary from editable browser form data.
        simulation_mode: true,
      },
    );
    revalidatePath('/console');
    revalidatePath('/console/drills');
    return success('Drill plan created. Validate its safety gates before arming.', {
      drill_id: response.drill.id,
    });
  } catch (error) {
    return failure(error, 'The drill plan could not be created.');
  }
}

export async function validateDrillAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  return transitionDrill(formData, 'validate', 'Safety gates validated.');
}

export async function startDrillAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  return transitionDrill(formData, 'start', 'Drill execution started.');
}

export async function stopDrillAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  return transitionDrill(formData, 'stop', 'Drill stopped and evidence processing started.');
}

export async function verifyDrillAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  return transitionDrill(formData, 'verify', 'Drill evidence verified.');
}

export async function armIntentAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const drillId = requiredString(formData, 'drill_id');
    const response = await apiPost<{
      challenge_id: string;
      expires_at: string;
      confirmation_phrase: string;
      expected_effects: {
        target_load_kw: string;
        reduction_kw: string;
        duration_min: number;
        estimated_energy_kwh: string;
        ramp_duration_min: string;
      };
      warnings: { code: string; message: string }[];
    }>(`/drills/${drillId}/arm-intent`);
    return success('Review the exact effects, then type the confirmation phrase.', {
      drill_id: drillId,
      challenge_id: response.challenge_id,
      expires_at: response.expires_at,
      confirmation_phrase: response.confirmation_phrase,
      target_load_kw: response.expected_effects.target_load_kw,
      reduction_kw: response.expected_effects.reduction_kw,
      duration_min: String(response.expected_effects.duration_min),
      estimated_energy_kwh: response.expected_effects.estimated_energy_kwh,
      ramp_duration_min: String(response.expected_effects.ramp_duration_min),
      warnings: response.warnings.map((warning) => warning.message).join(' · '),
    });
  } catch (error) {
    return failure(error, 'The arming challenge could not be created.');
  }
}

export async function armConfirmAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const drillId = requiredString(formData, 'drill_id');
    await apiPost(`/drills/${drillId}/arm-confirm`, {
      challenge_id: requiredString(formData, 'challenge_id'),
      confirmation_phrase: requiredString(formData, 'confirmation_phrase'),
    });
    revalidateDrill(drillId);
    return success('Drill armed. Start it only when the operator is ready.');
  } catch (error) {
    return failure(error, 'The arming confirmation was not accepted.');
  }
}

export async function abortDrillAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const drillId = requiredString(formData, 'drill_id');
    await apiPost(`/drills/${drillId}/abort`, {
      reason_code: requiredString(formData, 'reason_code'),
      reason_detail: optionalString(formData, 'reason_detail'),
    });
    revalidateDrill(drillId);
    return success('Drill aborted. The reason is recorded in the immutable event chain.');
  } catch (error) {
    return failure(error, 'The drill could not be aborted.');
  }
}

export async function emergencyStopAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const drillId = requiredString(formData, 'drill_id');
    await apiPost(`/drills/${drillId}/emergency-stop`, {
      reason_code: requiredString(formData, 'reason_code'),
      reason_detail: optionalString(formData, 'reason_detail'),
    });
    revalidateDrill(drillId);
    return success('Emergency stop activated and recorded.');
  } catch (error) {
    return failure(error, 'The emergency stop request failed.');
  }
}

export async function issuePassportAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const facilityId = requiredString(formData, 'facility_id');
    const response = await apiPost<{ passport: { id?: string; document?: { id?: string } } }>(
      `/facilities/${facilityId}/passports/issue`,
      {
        envelope_id: optionalString(formData, 'envelope_id'),
        drill_id: optionalString(formData, 'drill_id'),
        notes: optionalString(formData, 'notes'),
      },
    );
    revalidatePath('/console');
    revalidatePath('/console/passport');
    return success('Passport issued from the current evidence chain.', {
      passport_id: response.passport.id ?? response.passport.document?.id ?? '',
    });
  } catch (error) {
    return failure(error, 'The Passport could not be issued.');
  }
}

export async function exportPassportAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const passportId = requiredString(formData, 'passport_id');
    const format = requiredString(formData, 'format');
    const response = await apiPost<{ export: { id: string } }>(
      `/passports/${passportId}/exports`, {
      format,
      counterparty_name: optionalString(formData, 'counterparty_name'),
      },
    );
    revalidatePath('/console/passport');
    return success(`${format} export prepared.`, {
      export_id: response.export.id,
      format: format.toLowerCase(),
    });
  } catch (error) {
    return failure(error, 'The Passport export could not be prepared.');
  }
}

export async function updateFacilityAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const facilityId = requiredString(formData, 'facility_id');
    await apiPatch(`/facilities/${facilityId}`, {
      name: requiredString(formData, 'name'),
      slug: requiredString(formData, 'slug'),
      timezone: requiredString(formData, 'timezone'),
      country_code: optionalString(formData, 'country_code'),
      region: optionalString(formData, 'region'),
      market: optionalString(formData, 'market'),
      normal_load_kw: optionalString(formData, 'normal_load_kw'),
      minimum_safe_load_kw: optionalString(formData, 'minimum_safe_load_kw'),
      maximum_curtailment_kw: optionalString(formData, 'maximum_curtailment_kw'),
      ramp_rate_kw_per_min: optionalString(formData, 'ramp_rate_kw_per_min'),
      cooling_reserve_kw: optionalString(formData, 'cooling_reserve_kw'),
    });
    revalidateFacility();
    return success('Facility configuration updated.');
  } catch (error) {
    return failure(error, 'The facility configuration could not be updated.');
  }
}

export async function createFirstFacilityAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const normalLoad = requiredPower(formData, 'normal_load_kw');
    const minimumSafeLoad = requiredPower(formData, 'minimum_safe_load_kw');
    const maximumCurtailment = requiredPower(formData, 'maximum_curtailment_kw');

    if (Number(minimumSafeLoad) > Number(normalLoad)) {
      throw new Error('Minimum safe load cannot exceed normal load');
    }
    if (Number(maximumCurtailment) > Number(normalLoad)) {
      throw new Error('Maximum curtailment cannot exceed normal load');
    }

    await apiPost('/facilities', {
      name: requiredString(formData, 'name'),
      slug: requiredString(formData, 'slug'),
      timezone: requiredString(formData, 'timezone'),
      country_code: optionalString(formData, 'country_code'),
      region: optionalString(formData, 'region'),
      market: optionalString(formData, 'market'),
      normal_load_kw: normalLoad,
      minimum_safe_load_kw: minimumSafeLoad,
      maximum_curtailment_kw: maximumCurtailment,
      ramp_rate_kw_per_min: requiredPower(formData, 'ramp_rate_kw_per_min'),
      cooling_reserve_kw: requiredPower(formData, 'cooling_reserve_kw'),
    });
  } catch (error) {
    return failure(error, 'The facility could not be created.');
  }

  revalidatePath('/console', 'layout');
  redirect('/console/facility');
}

export async function createConstraintsAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const facilityId = requiredString(formData, 'facility_id');
    await apiPost(`/facilities/${facilityId}/constraints`, {
      minimum_safe_load_kw: requiredString(formData, 'minimum_safe_load_kw'),
      maximum_curtailment_kw: requiredString(formData, 'maximum_curtailment_kw'),
      maximum_ramp_kw_per_min: requiredString(formData, 'maximum_ramp_kw_per_min'),
      maximum_duration_min: requiredInteger(formData, 'maximum_duration_min'),
      minimum_recovery_min: requiredInteger(formData, 'minimum_recovery_min'),
      maximum_rebound_kw: optionalString(formData, 'maximum_rebound_kw'),
      thermal_limit_c: optionalString(formData, 'thermal_limit_c'),
      excluded_workloads: splitLines(formData, 'excluded_workloads'),
      tenant_carve_outs: splitLines(formData, 'tenant_carve_outs'),
      source_note: optionalString(formData, 'source_note'),
    });
    revalidateFacility();
    return success('A new immutable safety-constraint version was created.');
  } catch (error) {
    return failure(error, 'The safety-constraint version could not be created.');
  }
}

export async function createMechanismAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const facilityId = requiredString(formData, 'facility_id');
    await apiPost(`/facilities/${facilityId}/mechanisms`, mechanismBody(formData, true));
    revalidateFacility();
    return success('Flexibility mechanism added. Recompute the envelope when setup is complete.');
  } catch (error) {
    return failure(error, 'The flexibility mechanism could not be added.');
  }
}

export async function updateMechanismAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const facilityId = requiredString(formData, 'facility_id');
    const mechanismId = requiredString(formData, 'mechanism_id');
    await apiPatch(
      `/facilities/${facilityId}/mechanisms/${mechanismId}`,
      mechanismBody(formData, false),
    );
    revalidateFacility();
    return success('Flexibility mechanism updated.');
  } catch (error) {
    return failure(error, 'The flexibility mechanism could not be updated.');
  }
}

export async function createConnectorAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const facilityId = requiredString(formData, 'facility_id');
    const configuration = optionalJson(formData, 'configuration_json');
    await apiPost(`/facilities/${facilityId}/connectors`, {
      name: requiredString(formData, 'name'),
      connector_type: requiredString(formData, 'connector_type'),
      ...(configuration === undefined ? {} : { configuration }),
      ...(optionalInteger(formData, 'poll_interval_seconds') === undefined
        ? {}
        : { poll_interval_seconds: optionalInteger(formData, 'poll_interval_seconds') }),
    });
    revalidateConnectors();
    return success('Connector created. Test it before the first sync or import.');
  } catch (error) {
    return failure(error, 'The connector could not be created.');
  }
}

export async function testConnectorAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const connectorId = requiredString(formData, 'connector_id');
    const response = await apiPost<{ ok: boolean; status: string; message: string }>(
      `/connectors/${connectorId}/test`,
    );
    revalidateConnectors();
    if (!response.ok) {
      return {
        status: 'error',
        message: response.message,
        details: { code: response.status },
      };
    }
    return success(response.message);
  } catch (error) {
    return failure(error, 'The connector test could not run.');
  }
}

export async function syncConnectorAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const connectorId = requiredString(formData, 'connector_id');
    await apiPost(`/connectors/${connectorId}/sync`);
    revalidateConnectors();
    return success('Simulator sync queued. The worker will ingest it once.');
  } catch (error) {
    return failure(error, 'The connector sync could not be queued.');
  }
}

export async function toggleConnectorAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const connectorId = requiredString(formData, 'connector_id');
    const enabled = requiredString(formData, 'enabled') === 'true';
    await apiPatch(`/connectors/${connectorId}`, { enabled });
    revalidateConnectors();
    return success(enabled ? 'Connector enabled. Test it before syncing.' : 'Connector disabled.');
  } catch (error) {
    return failure(error, 'The connector state could not be changed.');
  }
}

export async function previewCsvAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const facilityId = requiredString(formData, 'facility_id');
    const response = await apiPost<{
      total_rows: number;
      valid_rows: number;
      invalid_rows: { row_number: number; reason_code: string; detail: string }[];
      detected_interval_seconds: number | null;
      window_start: string | null;
      window_end: string | null;
      preview_token: string;
    }>(`/facilities/${facilityId}/telemetry/csv`, {
      source_key: requiredString(formData, 'source_key'),
      connector_id: optionalString(formData, 'connector_id'),
      csv: requiredString(formData, 'csv'),
      confirm: false,
    });
    return success('CSV preview ready. Confirm only after reviewing the rejected rows.', {
      preview_token: response.preview_token,
      total_rows: String(response.total_rows),
      valid_rows: String(response.valid_rows),
      invalid_rows: String(response.invalid_rows.length),
      invalid_summary: response.invalid_rows
        .slice(0, 5)
        .map((row) => `Row ${row.row_number}: ${row.reason_code} — ${row.detail}`)
        .join('\n'),
      detected_interval_seconds:
        response.detected_interval_seconds === null
          ? 'Not detected'
          : String(response.detected_interval_seconds),
      window_start: response.window_start ?? '—',
      window_end: response.window_end ?? '—',
    });
  } catch (error) {
    return failure(error, 'The CSV could not be previewed.');
  }
}

export async function commitCsvAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const facilityId = requiredString(formData, 'facility_id');
    const response = await apiPost<{
      inserted: number;
      duplicates: number;
      quarantined: number;
    }>(`/facilities/${facilityId}/telemetry/csv`, {
      source_key: requiredString(formData, 'source_key'),
      connector_id: optionalString(formData, 'connector_id'),
      csv: requiredString(formData, 'csv'),
      preview_token: requiredString(formData, 'preview_token'),
      confirm: true,
    });
    revalidateConnectors();
    return success('CSV import committed.', {
      inserted: String(response.inserted),
      duplicates: String(response.duplicates),
      quarantined: String(response.quarantined),
    });
  } catch (error) {
    return failure(error, 'The CSV import could not be committed.');
  }
}

async function transitionDrill(
  formData: FormData,
  transition: 'validate' | 'start' | 'stop' | 'verify',
  message: string,
): Promise<ActionResult> {
  try {
    const drillId = requiredString(formData, 'drill_id');
    await apiPost(`/drills/${drillId}/${transition}`);
    revalidateDrill(drillId);
    return success(message);
  } catch (error) {
    return failure(error, `The drill could not ${transition}.`);
  }
}

function revalidateDrill(drillId: string) {
  revalidatePath('/console');
  revalidatePath('/console/drills');
  revalidatePath(`/console/drills/${drillId}`);
  revalidatePath('/console/passport');
  revalidatePath('/console/audit');
}

function revalidateFacility() {
  revalidatePath('/console');
  revalidatePath('/console/facility');
  revalidatePath('/console/envelope');
  revalidatePath('/console/audit');
}

function revalidateConnectors() {
  revalidatePath('/console');
  revalidatePath('/console/connectors');
  revalidatePath('/console/telemetry');
  revalidatePath('/console/envelope');
  revalidatePath('/console/audit');
}

function mechanismBody(formData: FormData, includeCode: boolean) {
  const description = optionalString(formData, 'description');
  const declaredReducibleKw = optionalString(formData, 'declared_reducible_kw');
  const minimumLoadKw = optionalString(formData, 'minimum_load_kw');
  const rampRate = optionalString(formData, 'ramp_rate_kw_per_min');
  const maximumDuration = optionalInteger(formData, 'maximum_duration_min');
  const reboundWindow = optionalInteger(formData, 'rebound_window_min');
  const controlReference = optionalString(formData, 'control_reference');
  return {
    ...(includeCode ? { code: requiredString(formData, 'code') } : {}),
    name: requiredString(formData, 'name'),
    ...(includeCode
      ? description === undefined ? {} : { description }
      : { description: description ?? null }),
    mechanism_type: requiredString(formData, 'mechanism_type'),
    enabled: formData.get('enabled') === 'on',
    ...(includeCode
      ? declaredReducibleKw === undefined ? {} : { declared_reducible_kw: declaredReducibleKw }
      : { declared_reducible_kw: declaredReducibleKw ?? null }),
    ...(includeCode
      ? minimumLoadKw === undefined ? {} : { minimum_load_kw: minimumLoadKw }
      : { minimum_load_kw: minimumLoadKw ?? null }),
    ...(includeCode
      ? rampRate === undefined ? {} : { ramp_rate_kw_per_min: rampRate }
      : { ramp_rate_kw_per_min: rampRate ?? null }),
    ...(includeCode
      ? maximumDuration === undefined ? {} : { maximum_duration_min: maximumDuration }
      : { maximum_duration_min: maximumDuration ?? null }),
    ...(includeCode
      ? reboundWindow === undefined ? {} : { rebound_window_min: reboundWindow }
      : { rebound_window_min: reboundWindow ?? null }),
    ...(includeCode
      ? controlReference === undefined ? {} : { control_reference: controlReference }
      : { control_reference: controlReference ?? null }),
  };
}

function requiredString(formData: FormData, key: string): string {
  const value = formData.get(key);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function optionalString(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return value.trim();
}

function utcInput(formData: FormData, key: string): string {
  const value = requiredString(formData, key);
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}:00Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) throw new Error(`${key} must be a valid UTC time`);
  return date.toISOString();
}

function requiredInteger(formData: FormData, key: string): number {
  const value = Number(requiredString(formData, key));
  if (!Number.isInteger(value)) throw new Error(`${key} must be a whole number`);
  return value;
}

function optionalInteger(formData: FormData, key: string): number | undefined {
  const raw = optionalString(formData, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${key} must be a whole number`);
  return value;
}

function requiredPower(formData: FormData, key: string): string {
  const value = requiredString(formData, key);
  if (!/^\d+(?:\.\d{1,3})?$/.test(value)) {
    throw new Error(`${key} must be a non-negative number with at most three decimal places`);
  }
  return value;
}

function splitLines(formData: FormData, key: string): string[] {
  return (optionalString(formData, key) ?? '')
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function optionalJson(formData: FormData, key: string): Record<string, unknown> | undefined {
  const raw = optionalString(formData, key);
  if (raw === undefined) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${key} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function success(message: string, details: Record<string, string> = {}): ActionResult {
  return { status: 'success', message, details };
}

function failure(error: unknown, fallback: string): ActionResult {
  if (error instanceof ApiError) {
    const fieldErrors = stringRecord(error.details.fields);
    if (error.code === 'UNAUTHENTICATED') {
      return {
        status: 'error',
        message: 'Your session expired. Sign in again, then retry the action.',
        details: { code: error.code },
      };
    }
    return {
      status: 'error',
      message: fieldErrors
        ? `${error.message} Correct the identified fields and retry.`
        : `${error.message} Review the inputs and retry.`,
      details: { code: error.code },
      ...(fieldErrors ? { fieldErrors } : {}),
    };
  }
  if (error instanceof Error) {
    const field = error.message.match(/^([a-z][a-z0-9_]*)\s+(?:is|must)\b/i)?.[1];
    return {
      status: 'error',
      message: field
        ? 'Correct the identified field and retry.'
        : `${error.message}. Review the inputs and retry.`,
      details: {},
      ...(field ? { fieldErrors: { [field]: error.message } } : {}),
    };
  }
  return { status: 'error', message: fallback, details: {} };
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}
