import {
  ArgumentsHost,
  Catch,
  HttpException,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common';
import { DomainError, type ErrorCode } from '@gridflex/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Single error envelope for every endpoint (spec §9).
 *
 * Two rules this enforces:
 *  - Responses NEVER expose stack traces, SQL, hostnames, or credentials
 *    (spec §6.2, §18). Unknown errors become a generic INTERNAL_ERROR while the
 *    real detail goes to the server log only.
 *  - Every response carries a stable `code` and a `request_id` so an operator
 *    can correlate what they saw with what the server recorded.
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const reply = context.getResponse<FastifyReply>();
    const request = context.getRequest<FastifyRequest>();
    const requestId = String(request.id ?? 'unknown');

    const { status, code, message, details } = this.classify(exception);

    if (status >= 500) {
      // Full detail server-side only.
      this.logger.error(
        { err: exception, request_id: requestId, path: request.url },
        'Unhandled error',
      );
    } else {
      this.logger.warn(
        { code, request_id: requestId, path: request.url },
        'Request rejected',
      );
    }

    void reply.status(status).send({
      error: {
        code,
        message,
        ...(details ? { details } : {}),
        request_id: requestId,
      },
    });
  }

  private classify(exception: unknown): {
    status: number;
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  } {
    if (exception instanceof DomainError) {
      return {
        status: exception.httpStatus,
        code: exception.code,
        message: exception.message,
        ...(exception.details ? { details: exception.details } : {}),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: string }).message ?? exception.message);

      return {
        status,
        code: this.codeForStatus(status),
        message,
      };
    }

    // Anything unrecognised is opaque to the client by design.
    return {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
    };
  }

  private codeForStatus(status: number): ErrorCode {
    switch (status) {
      case 401:
        return 'UNAUTHENTICATED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'NOT_FOUND';
      case 409:
        return 'CONFLICT';
      case 429:
        return 'RATE_LIMITED';
      case 400:
        return 'VALIDATION_FAILED';
      default:
        return 'INTERNAL_ERROR';
    }
  }
}
