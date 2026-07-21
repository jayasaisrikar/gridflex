import { Injectable, type PipeTransform } from '@nestjs/common';
import { DomainError } from '@gridflex/contracts';
import { ZodError, type ZodType } from 'zod';

/**
 * Custom Zod validation pipe (spec §4).
 *
 * The web app and API import the SAME schema from @gridflex/contracts, so a
 * request shape that type-checks on the client is the shape the server enforces.
 *
 * Field errors are reported as a path→message map so a form can highlight the
 * offending input, but the raw submitted VALUES are never echoed back — a
 * rejected login body would otherwise put a password into a response and a log.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        const fields: Record<string, string> = {};
        for (const issue of error.issues) {
          const path = issue.path.join('.') || '(root)';
          fields[path] = issue.message;
        }
        throw new DomainError('VALIDATION_FAILED', 'Request validation failed.', { fields }, 400);
      }
      throw error;
    }
  }
}

/** Convenience factory so controllers read `@Body(zodBody(schema))`. */
export function zodBody<T>(schema: ZodType<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}
