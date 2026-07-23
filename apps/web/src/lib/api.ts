import 'server-only';
import {
  getAccessToken,
  getRefreshToken,
  setSession,
} from './session';

/**
 * Server-side API client.
 *
 * Every call runs on the server with the httpOnly access token. Nothing here is
 * importable from a client component — `server-only` makes that a build error
 * rather than a runtime credential leak (spec §18).
 */
const BASE_URL =
  process.env.API_INTERNAL_BASE_URL ?? 'http://127.0.0.1:4000/api/v1';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Marks the caller as unauthenticated so the page can redirect to /login. */
export const UNAUTHENTICATED = 'UNAUTHENTICATED';

type ApiRequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
};

export async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const isMutation = method !== 'GET';
  const hasBody = options.body !== undefined;
  // Serialize once so an authenticated retry sends exactly the same payload.
  // The first request is rejected by the auth guard before a mutation handler
  // runs, making a single retry safe for POST/PATCH/DELETE requests.
  const serializedBody = hasBody ? JSON.stringify(options.body) : undefined;

  let token = await getAccessToken();
  if (!token) {
    if (!isMutation) throw new ApiError(UNAUTHENTICATED, 'No session', 401);
    token = await refreshMutationSession();
  }

  try {
    return await sendApiRequest<T>(path, method, token, serializedBody, options.headers);
  } catch (error) {
    if (!isMutation || !isRefreshableAuthError(error)) throw error;

    const refreshedToken = await refreshMutationSession();
    // Deliberately retry once, outside this catch block. If the new access
    // token is rejected, surface that failure instead of entering a loop.
    return sendApiRequest<T>(
      path,
      method,
      refreshedToken,
      serializedBody,
      options.headers,
    );
  }
}

async function sendApiRequest<T>(
  path: string,
  method: NonNullable<ApiRequestOptions['method']>,
  token: string,
  serializedBody: string | undefined,
  headers: Record<string, string> | undefined,
): Promise<T> {
  const hasBody = serializedBody !== undefined;

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(hasBody ? { body: serializedBody } : {}),
    // Operator data must never be served from a stale cache — a cached
    // "telemetry fresh" badge would be actively dangerous.
    cache: 'no-store',
  });

  if (!response.ok) {
    let code = 'INTERNAL_ERROR';
    let message = `Request failed with ${response.status}`;
    let details: Record<string, unknown> = {};
    try {
      const body = (await response.json()) as {
        error?: { code?: string; message?: string; details?: unknown };
      };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
      if (
        body.error?.details &&
        typeof body.error.details === 'object' &&
        !Array.isArray(body.error.details)
      ) {
        details = body.error.details as Record<string, unknown>;
      }
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    throw new ApiError(code, message, response.status, details);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function isRefreshableAuthError(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status === 401 &&
    (error.code === 'TOKEN_EXPIRED' || error.code === UNAUTHENTICATED)
  );
}

async function refreshMutationSession(): Promise<string> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) {
    throw new ApiError(UNAUTHENTICATED, 'Your session has expired.', 401);
  }

  const tokens = await apiRefresh(refreshToken);
  await setSession(tokens);
  return tokens.access_token;
}

export function apiGet<T>(path: string): Promise<T> {
  return apiRequest<T>(path);
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body }),
  });
}

export function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>(path, { method: 'PATCH', body });
}

/** Login is the one unauthenticated call the web app makes. */
export async function apiLogin(
  email: string,
  password: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const response = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
    cache: 'no-store',
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    };
    throw new ApiError(
      body.error?.code ?? 'INVALID_CREDENTIALS',
      body.error?.message ?? 'Sign-in failed.',
      response.status,
    );
  }

  return response.json();
}

export async function apiRefresh(
  refreshToken: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const response = await fetch(`${BASE_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
    cache: 'no-store',
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    };
    throw new ApiError(
      body.error?.code ?? 'UNAUTHENTICATED',
      body.error?.message ?? 'The session could not be refreshed.',
      response.status,
    );
  }
  return response.json();
}

export async function apiBootstrapStatus(): Promise<{ bootstrap_available: boolean }> {
  const response = await fetch(`${BASE_URL}/auth/bootstrap-status`, { cache: 'no-store' });
  if (!response.ok) {
    throw new ApiError('BOOTSTRAP_STATUS_FAILED', 'Could not check first-run status.', response.status);
  }
  return response.json();
}

export async function apiBootstrapOwner(input: {
  email: string;
  display_name: string;
  password: string;
  organization_name: string;
  organization_slug: string;
}): Promise<{ user_id: string; organization_id: string }> {
  const response = await fetch(`${BASE_URL}/auth/bootstrap-owner`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    cache: 'no-store',
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    };
    throw new ApiError(
      body.error?.code ?? 'BOOTSTRAP_FAILED',
      body.error?.message ?? 'The owner account could not be created.',
      response.status,
    );
  }
  return response.json();
}

/* ---------------- Response shapes (mirror the API DTOs) ---------------- */

export interface Facility {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  timezone: string;
  country_code: string | null;
  region: string | null;
  market: string | null;
  normal_load_kw: string | null;
  minimum_safe_load_kw: string | null;
  maximum_curtailment_kw: string | null;
  ramp_rate_kw_per_min: string | null;
  cooling_reserve_kw: string | null;
  status: string;
  created_at: string;
}

export interface FacilityConstraints {
  id: string;
  version: number;
  effective_from: string;
  effective_to: string | null;
  minimum_safe_load_kw: string;
  maximum_curtailment_kw: string;
  maximum_ramp_kw_per_min: string;
  maximum_duration_min: number;
  minimum_recovery_min: number;
  maximum_rebound_kw: string | null;
  thermal_limit_c: string | null;
  excluded_workloads: string[];
  source_note: string | null;
}

export interface Mechanism {
  id: string;
  code: string;
  name: string;
  description: string | null;
  mechanism_type: string;
  enabled: boolean;
  declared_reducible_kw: string | null;
  minimum_load_kw: string | null;
  ramp_rate_kw_per_min: string | null;
  maximum_duration_min: number | null;
  rebound_window_min: number | null;
  control_reference: string | null;
}

export interface Envelope {
  id: string;
  version: number;
  status: string;
  total_reducible_kw: string;
  aggregate_ramp_kw_per_min: string;
  sustainable_duration_min: number;
  response_time_seconds: number;
  confidence_score: number;
  telemetry_completeness: number;
  methodology_version: string;
  constraints_version: number;
  blocked_reasons: { code: string; detail: string }[];
  summary: { binding_constraint?: string; confidence_adjustments?: unknown[] };
  as_of: string;
}

export interface EnvelopeMechanism {
  mechanism_id: string;
  mechanism_code: string;
  mechanism_name: string;
  provenance: 'DECLARED' | 'MODELED' | 'TESTED';
  reducible_kw: string;
  ramp_kw_per_min: string;
  duration_min: number;
  confidence_score: number;
}

export interface TelemetryQuality {
  facility_id: string;
  window_start: string;
  window_end: string;
  interval_seconds: number;
  expected_intervals: number;
  observed_intervals: number;
  completeness: number;
  maximum_gap_intervals: number;
  last_reading_at: string | null;
  is_stale: boolean;
  stale_threshold_seconds: number;
  contains_simulated_data: boolean;
  meets_drill_threshold: boolean;
}

export interface Connector {
  id: string;
  facility_id: string;
  name: string;
  connector_type: string;
  status: 'DRAFT' | 'ACTIVE' | 'DEGRADED' | 'ERROR' | 'DISABLED';
  config_summary: Record<string, unknown>;
  poll_interval_seconds: number | null;
  last_sync_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  has_configuration: boolean;
  created_at: string;
  updated_at: string;
}

export interface QuarantineRow {
  id: string;
  facility_id: string | null;
  connector_id: string | null;
  sync_run_id: string | null;
  received_at: string;
  raw_payload: Record<string, unknown>;
  reason_code: string;
  reason_detail: string | null;
  resolved_at: string | null;
}

export interface TelemetryPoint {
  measured_at: string;
  value: string;
  unit: string;
  quality: string;
}

export interface Drill {
  id: string;
  facility_id: string;
  envelope_id: string | null;
  name: string;
  status: string;
  requested_reduction_kw: string;
  simulation_mode: boolean;
  replay_mode: boolean;
  baseline_method: string;
  planned_start_at: string;
  planned_end_at: string;
  planned_ramp_kw_per_min: string | null;
  started_at: string | null;
  ended_at: string | null;
  abort_reason_code: string | null;
  created_at: string;
}

export interface DrillEvent {
  id: string;
  event_type: string;
  occurred_at: string;
  actor_user_id: string | null;
  actor_service: string | null;
  reason_code: string | null;
  payload: Record<string, unknown>;
  correlation_id: string;
}

export interface MrvReport {
  methodology_version: string;
  interval_seconds: number;
  committed_energy_wh: string;
  delivered_energy_wh: string;
  average_delivered_kw: string;
  performance_bps: number;
  telemetry_completeness: number;
  maximum_gap_intervals: number;
  baseline_series: { measured_at: string; value: string }[];
  actual_series: { measured_at: string; value: string | null }[];
  quality_blocks: { code: string; interval_index: number; detail: string }[];
}

export interface PassportSummary {
  id: string;
  facility_id: string;
  version: number;
  status: 'DRAFT' | 'ISSUED' | 'SUPERSEDED' | 'REVOKED';
  passport_sha256: string;
  evidence_sha256: string;
  issued_at: string | null;
  superseded_by: string | null;
  contains_simulated_data: boolean;
}

export interface PassportRecord {
  status: PassportSummary['status'];
  passport_sha256: string;
  superseded_by: string | null;
  revocation_reason: string | null;
  document: {
    id: string;
    facility_id: string;
    version: number;
    evidence_bundle_id: string;
    evidence_sha256: string;
    issued_at: string;
    facility: {
      name: string;
      timezone: string;
      region: string | null;
      market: string | null;
    };
    methodology_version: string;
    envelope: {
      id: string;
      facility_id: string;
      version: number;
      status: 'CURRENT';
      as_of: string;
      valid_until: string | null;
      total_reducible_kw: string;
      response_time_seconds: number;
      sustainable_duration_min: number;
      aggregate_ramp_kw_per_min: string;
      rebound_peak_kw: string | null;
      rebound_duration_min: number | null;
      confidence_score: string;
      telemetry_completeness: string;
      methodology_version: string;
      constraints_version: number;
      blocked_reasons: { code: string; detail: string }[];
      mechanisms: {
        mechanism_id: string;
        mechanism_code: string;
        mechanism_name: string;
        provenance: 'DECLARED' | 'MODELED' | 'TESTED';
        reducible_kw: string;
        response_time_seconds: number;
        ramp_kw_per_min: string;
        duration_min: number;
        rebound_peak_kw: string | null;
        rebound_duration_min: number | null;
        confidence_score: string;
        evidence_refs: string[];
        notes: string | null;
      }[];
      created_at: string;
    };
    safety: {
      minimum_safe_load_kw: string;
      maximum_curtailment_kw: string;
      maximum_ramp_kw_per_min: string;
      maximum_duration_min: number;
      excluded_workloads: string[];
      constraints_version: number;
    };
    data_quality: {
      completeness: string;
      window_start: string;
      window_end: string;
      connector_provenance: {
        connector_type: string;
        name: string;
        last_success_at: string | null;
      }[];
      contains_simulated_data: boolean;
    };
    drill_history: {
      drill_id: string;
      name: string;
      status: string;
      started_at: string | null;
      requested_reduction_kw: string;
      delivered_energy_wh: string | null;
      performance_bps: number | null;
      simulation_mode: boolean;
    }[];
    limitations: string[];
    notes: string | null;
  };
}

export interface PassportVerification {
  passport_id: string;
  version: number;
  status: string;
  stored_passport_sha256: string;
  recomputed_passport_sha256: string;
  passport_hash_matches: boolean;
  stored_evidence_sha256: string;
  recomputed_evidence_sha256: string;
  evidence_hash_matches: boolean;
  verified_at: string;
  canonicalization_schema_version: string;
  instructions: string;
}

export interface ActivityEntry {
  source: 'AUDIT' | 'DRILL_EVENT';
  occurred_at: string;
  id: string;
  action: string;
  object_type: string;
  object_id: string | null;
  actor_user_id: string | null;
  actor_service: string | null;
  reason_code: string | null;
  detail: Record<string, unknown>;
}

/* ---------------- Typed endpoint helpers ---------------- */

export const api = {
  facilities: () => apiGet<{ facilities: Facility[] }>('/facilities'),
  facility: (id: string) =>
    apiGet<{
      facility: Facility;
      constraints: FacilityConstraints | null;
      mechanisms: Mechanism[];
    }>(
      `/facilities/${id}`,
    ),
  currentEnvelope: (id: string) =>
    apiGet<{ envelope: Envelope | null; mechanisms: EnvelopeMechanism[] }>(
      `/facilities/${id}/envelopes/current`,
    ),
  telemetryQuality: (id: string) =>
    apiGet<TelemetryQuality>(`/facilities/${id}/telemetry/quality`),
  currentPassport: (id: string) =>
    apiGet<{ passport: PassportRecord | null }>(`/facilities/${id}/passports/current`),
  passportVerify: (passportId: string) =>
    apiGet<PassportVerification>(`/passports/${passportId}/verify`),
  telemetry: (id: string, metric = 'facility.active_power_kw') =>
    apiGet<{ metric_key: string; points: TelemetryPoint[]; truncated: boolean }>(
      `/facilities/${id}/telemetry?metric_key=${encodeURIComponent(metric)}`,
    ),
  connectors: (id: string) =>
    apiGet<{ connectors: Connector[] }>(`/facilities/${id}/connectors`),
  quarantine: (id: string) =>
    apiGet<{ quarantine: QuarantineRow[] }>(
      `/facilities/${id}/telemetry/quarantine`,
    ),
  drills: (id: string) => apiGet<{ drills: Drill[] }>(`/facilities/${id}/drills`),
  drill: (drillId: string) =>
    apiGet<{
      drill: Drill;
      events: DrillEvent[];
      mrv: MrvReport | null;
      evidence: { canonical_sha256: string; schema_version: string } | null;
    }>(`/drills/${drillId}`),
  passports: (id: string) =>
    apiGet<{ passports: PassportSummary[] }>(`/facilities/${id}/passports`),
  passport: (passportId: string) =>
    apiGet<{ passport: PassportRecord }>(`/passports/${passportId}`),
  verifyPassport: (passportId: string) =>
    apiGet<PassportVerification>(`/passports/${passportId}/verify`),
  activity: (id: string) =>
    apiGet<{ entries: ActivityEntry[]; next_before: string | null }>(
      `/facilities/${id}/activity?limit=100`,
    ),
};
