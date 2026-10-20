/**
 * UAE grid-signal fixture for the READ_GRID_SIGNALS agent tool.
 *
 * Serves the three signals the demo story needs — DEWA's summer peak window,
 * a temperature forecast, and a carbon-intensity curve — replayed from a
 * versioned fixture so a Championship jury run is byte-identical every time.
 *
 * Nothing here is a measurement: every value is a declared fixture input,
 * labelled SIMULATED at the boundary, and the provenance travels with the
 * data into plans and reports.
 */

export const GRID_SIGNALS_FIXTURE_VERSION = 'gridflex-grid-signals-uae-1.0.0';

/**
 * DEWA's declared summer peak window (Product & Build Doc, Gulf News source).
 * Expressed in facility-local wall-clock time; facilities resolve it against
 * their own IANA timezone.
 */
export const PEAK_WINDOW = {
  startHourLocal: 12,
  endHourLocal: 17,
  label: 'DEWA summer peak',
} as const;

/** Fixture horizon: 24 hourly steps, the window the planner looks across. */
const HORIZON_HOURS = 24;

export type GridSignalSource = 'FIXTURE';

export interface PeakWindowSignal {
  readonly isPeakNow: boolean;
  /** Minutes until the window opens; null when the window is not today. */
  readonly minutesToPeak: number | null;
  readonly minutesRemaining: number | null;
  readonly startHourLocal: number;
  readonly endHourLocal: number;
  readonly label: string;
  readonly timezone: string;
}

export interface TemperatureForecastPoint {
  /** ISO 8601 timestamp in UTC. */
  readonly at: string;
  readonly temperatureC: number;
  readonly humidityPercent: number;
}

export interface CarbonIntensityPoint {
  readonly at: string;
  /** Grid emission factor, kgCO2e per kWh, declared per hour. */
  readonly kgCo2ePerKwh: number;
  readonly source: string;
}

export interface GridSignalsSnapshot {
  readonly fixtureVersion: string;
  readonly generatedAt: string;
  readonly timezone: string;
  readonly peak: PeakWindowSignal;
  readonly temperatureForecast: readonly TemperatureForecastPoint[];
  readonly carbonIntensity: readonly CarbonIntensityPoint[];
  readonly source: GridSignalSource;
  readonly simulated: true;
  readonly label: 'SIMULATED';
}

/**
 * Hourly Dubai August temperature curve, °C.
 *
 * A 46 °C mid-afternoon maximum (the demo story) with an overnight low of 33,
 * shaped by a smooth diurnal profile peaking at 14:00 local.
 */
function dubaiAugustTemperature(hourLocal: number): number {
  const diurnal = Math.cos(((hourLocal - 14) / 24) * 2 * Math.PI);
  return Math.round((39.5 + 6.5 * diurnal) * 10) / 10;
}

/**
 * Hourly carbon-intensity curve for the DEWA network, kgCO2e/kWh.
 *
 * The UAE grid factor is a DECLARED, versioned input (Product & Build Doc:
 * MOCCAE has not published the national MRV factor), not a measurement. The
 * curve rises into the evening as solar rolls off and gas peakers set the
 * margin, so shifting load out of the peak window also shifts it into cleaner
 * hours.
 */
const CARBON_BASE_KG_PER_KWH = 0.405;
const CARBON_SOURCE =
  'Declared fixture factor for the DEWA network; national MRV factor pending (MOCCAE)';

function dubaiCarbonIntensity(hourLocal: number): number {
  const eveningRamp = Math.max(0, Math.cos(((hourLocal - 21) / 24) * 2 * Math.PI));
  const middaySolar = Math.max(0, Math.cos(((hourLocal - 13) / 24) * 2 * Math.PI));
  const value = CARBON_BASE_KG_PER_KWH + 0.05 * eveningRamp - 0.035 * middaySolar;
  return Math.round(value * 1000) / 1000;
}

function humidityFor(hourLocal: number): number {
  // Coastal Dubai: humidity runs inverse to temperature, higher overnight.
  const diurnal = Math.cos(((hourLocal - 4.5) / 24) * 2 * Math.PI);
  return Math.round(52 + 14 * diurnal);
}

/**
 * Builds the snapshot for a moment in facility-local time.
 *
 * `nowLocal` is the caller's clock already resolved in the facility timezone;
 * the fixture itself stays deterministic — the same wall clock always yields
 * the same peak-window arithmetic and the same curves.
 */
export function readGridSignals(now: {
  /** ISO 8601 instant in UTC. */
  readonly at: string;
  readonly timezone: string;
  /** Hour of day in the facility-local wall clock, 0-23. */
  readonly hourLocal: number;
  readonly dateLocal: string;
}): GridSignalsSnapshot {
  const hour = now.hourLocal;
  const inWindow = hour >= PEAK_WINDOW.startHourLocal && hour < PEAK_WINDOW.endHourLocal;

  let minutesToPeak: number | null = null;
  let minutesRemaining: number | null = null;
  if (inWindow) {
    minutesRemaining = (PEAK_WINDOW.endHourLocal - hour) * 60;
  } else if (hour < PEAK_WINDOW.startHourLocal) {
    minutesToPeak = (PEAK_WINDOW.startHourLocal - hour) * 60;
  }

  const temperatureForecast: TemperatureForecastPoint[] = [];
  const carbonIntensity: CarbonIntensityPoint[] = [];
  for (let offset = 0; offset < HORIZON_HOURS; offset += 1) {
    const hourLocal = (hour + offset) % 24;
    const at = new Date(
      new Date(now.at).getTime() + offset * 3_600_000,
    ).toISOString();

    temperatureForecast.push({
      at,
      temperatureC: dubaiAugustTemperature(hourLocal),
      humidityPercent: humidityFor(hourLocal),
    });

    carbonIntensity.push({
      at,
      kgCo2ePerKwh: dubaiCarbonIntensity(hourLocal),
      source: CARBON_SOURCE,
    });
  }

  return {
    fixtureVersion: GRID_SIGNALS_FIXTURE_VERSION,
    generatedAt: now.at,
    timezone: now.timezone,
    peak: {
      isPeakNow: inWindow,
      minutesToPeak,
      minutesRemaining,
      startHourLocal: PEAK_WINDOW.startHourLocal,
      endHourLocal: PEAK_WINDOW.endHourLocal,
      label: PEAK_WINDOW.label,
      timezone: now.timezone,
    },
    temperatureForecast,
    carbonIntensity,
    source: 'FIXTURE',
    simulated: true,
    label: 'SIMULATED',
  };
}
