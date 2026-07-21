import { pino, type Level, type Logger, type LoggerOptions } from 'pino';

/**
 * Shared logger. Redaction is deliberately aggressive: spec 18 forbids logging
 * passwords, tokens, connection URLs, connector secrets, or raw telemetry batches.
 */
const REDACTED_PATHS = [
  'password',
  'passwordHash',
  'password_hash',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'DATABASE_URL',
  'databaseUrl',
  'connectionString',
  'AUTH_SECRET',
  'CONNECTOR_ENCRYPTION_KEY',
  'configuration_encrypted',
  'configurationEncrypted',
  // Telemetry batches are high-volume and may be commercially sensitive.
  'readings',
  'baseline_series',
  'actual_series',
];

export function createLogger(options: {
  name: string;
  level: Level;
  pretty?: boolean;
}): Logger {
  const base: LoggerOptions = {
    name: options.name,
    level: options.level,
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    // UTC everywhere, per spec 4.1.
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
  };

  return options.pretty
    ? pino({ ...base, transport: { target: 'pino-pretty', options: { colorize: true } } })
    : pino(base);
}

export type { Logger };
