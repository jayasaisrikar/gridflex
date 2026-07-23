export const LOCAL_PILOT = {
  email: 'playwright-pilot@test.local',
  password: 'gridflex-playwright-pilot-password',
  facilityId: '22222222-2222-4222-8222-222222222222',
} as const;

export const STALE_TELEMETRY_PILOT = {
  email: 'playwright-stale-telemetry@test.local',
  password: 'gridflex-playwright-stale-password',
  organizationId: '91111111-1111-4111-8111-111111111111',
  facilityId: '92222222-2222-4222-8222-222222222222',
  mechanismId: '93333333-3333-4333-8333-333333333331',
} as const;

export function usesDisposableLocalPilot() {
  return !process.env.GRIDFLEX_E2E_EMAIL && !process.env.GRIDFLEX_E2E_PASSWORD;
}
