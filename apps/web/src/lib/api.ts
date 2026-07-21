import 'server-only';
import { getAccessToken } from './session';

/**
 * Server-side API client.
 *
 * Every call runs on the server with the httpOnly access token. Nothing here is
 * importable from a client component — `server-only` makes that a build error
 * rather than a runtime credential leak (spec §18).
 */
const BASE_URL =
  process.env.API_INTERNAL_BASE_URL ?? 'http://localhost:4000/api/v1';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Marks the caller as unauthenticated so the page can redirect to /login. */
export const UNAUTHENTICATED = 'UNAUTHENTICATED';

export async function apiGet<T>(path: string): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new ApiError(UNAUTHENTICATED, 'No session', 401);

  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    // Operator data must never be served from a stale cache — a cached
    // "telemetry fresh" badge would be actively dangerous.
    cache: 'no-store',
  });

  if (!response.ok) {
    let code = 'INTERNAL_ERROR';
    let message = `Request failed with ${response.status}`;
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    throw new ApiError(code, message, response.status);
  }

  return (await response.json()) as T;
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

/* ---------------- Response shapes (mirror the API DTOs) ---------------- */

export interface Facility {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  region: string | null;
  market: string | null;
  normal_load_kw: string | null;
  minimum_safe_load_kw: string | null;
  maximum_curtailment_kw: string | null;
  ramp_rate_kw_per_min: string | null;
  cooling_reserve_kw: string | null;
}

export interface Constraints {
  id: string;
  version: number;
  effective_from: string;
  effective_to: string | null;
  minimum_safe_load_kw: string | null;
  maximum_curtailment_kw: string | null;
  maximum_ramp_kw_per_min: string | null;
  maximum_duration_min: number | null;
  minimum_recovery_min: number | null;
  maximum_rebound_kw: string | null;
  thermal_limit_c: string | null;
  excluded_workloads: unknown;
  source_note: string | null;
}

export interface Mechanism {
  id: string;
  code: string;
  name: string;
  mechanism_type: string;
  enabled: boolean;
  declared_reducible_kw: string | null;
  ramp_rate_kw_per_min: string | null;
  maximum_duration_min: number | null;
  rebound_window_min: number | null;
  minimum_load_kw: string | null;
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
  window_start: string;
  window_end: string;
  interval_seconds: number;
  expected_intervals: number;
  observed_intervals: number;
  completeness: number;
  last_reading_at: string | null;
  is_stale: boolean;
  meets_drill_threshold: boolean;
}

export interface TelemetryPoint {
  measured_at: string;
  value: string;
  unit: string;
  quality: string;
}

export interface Drill {
  id: string;
  name: string;
  status: string;
  requested_reduction_kw: string;
  simulation_mode: boolean;
  replay_mode: boolean;
  baseline_method: string;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

export interface DrillEvent {
  id: string;
  event_type: string;
  occurred_at: string;
  actor_user_id: string | null;
  reason_code: string | null;
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

/* ---------------- Typed endpoint helpers ---------------- */

export const api = {
  facilities: () => apiGet<{ facilities: Facility[] }>('/facilities'),
  facility: (id: string) =>
    apiGet<{ facility: Facility; constraints: Constraints | null; mechanisms: Mechanism[] }>(
      `/facilities/${id}`,
    ),
  currentEnvelope: (id: string) =>
    apiGet<{ envelope: Envelope | null; mechanisms: EnvelopeMechanism[] }>(
      `/facilities/${id}/envelopes/current`,
    ),
  telemetryQuality: (id: string) =>
    apiGet<TelemetryQuality>(`/facilities/${id}/telemetry/quality`),
  telemetry: (id: string, metric = 'facility.active_power_kw') =>
    apiGet<{ metric_key: string; points: TelemetryPoint[]; truncated: boolean }>(
      `/facilities/${id}/telemetry?metric_key=${encodeURIComponent(metric)}`,
    ),
  drills: (id: string) => apiGet<{ drills: Drill[] }>(`/facilities/${id}/drills`),
  drill: (drillId: string) =>
    apiGet<{
      drill: Drill;
      events: DrillEvent[];
      mrv: MrvReport | null;
      evidence: { canonical_sha256: string; schema_version: string } | null;
    }>(`/drills/${drillId}`),
};
