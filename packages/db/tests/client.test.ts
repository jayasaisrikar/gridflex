import { describe, expect, it } from 'vitest';
import { createPool, statementTimeoutConnectionOption } from '../src/client.js';

describe('database pool startup options', () => {
  it('sets statement_timeout in the PostgreSQL startup handshake', async () => {
    const pool = createPool({
      connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused',
      statementTimeoutMs: 12_345,
    });

    expect((pool as unknown as { options: { options: string } }).options.options).toBe(
      '-c statement_timeout=12345',
    );
    await pool.end();
  });

  it('rejects values that could produce an invalid or injectable option', () => {
    expect(() => statementTimeoutConnectionOption(-1)).toThrow('non-negative safe integer');
    expect(() => statementTimeoutConnectionOption(1.5)).toThrow('non-negative safe integer');
    expect(() => statementTimeoutConnectionOption(Number.NaN)).toThrow(
      'non-negative safe integer',
    );
  });
});
