import 'server-only';
import { redirect } from 'next/navigation';
import { api, ApiError, UNAUTHENTICATED, type Facility } from './api';

/**
 * Resolves the facility this session operates on.
 *
 * Single-customer deployment (spec §2.1), so the first visible facility is the
 * one. Kept as a helper rather than a constant so multi-facility support is a
 * change in one place.
 */
export async function requireFacility(): Promise<Facility> {
  try {
    const { facilities } = await api.facilities();
    const facility = facilities[0];
    if (!facility) redirect('/no-facility');
    return facility;
  } catch (error) {
    if (error instanceof ApiError && error.code === UNAUTHENTICATED) redirect('/login');
    throw error;
  }
}

/** Formats a decimal string for display without losing its precision. */
export function formatKw(value: string | null | undefined, digits = 0): string {
  if (value === null || value === undefined) return '—';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '—';
  return parsed.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Wh (as a decimal string) → kWh, keeping 3 decimals. */
export function whToKwh(value: string): string {
  return (Number(value) / 1000).toFixed(3);
}

/** Relative age, for freshness readouts. */
export function ageFrom(iso: string | null): string {
  if (!iso) return 'never';
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}
