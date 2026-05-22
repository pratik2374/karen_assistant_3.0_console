import { DomainError, DomainInvariantError } from '../../domain/shared/errors/DomainErrors.js';
import { Response } from 'express';

export interface HttpErrorResponse {
  error: string;
  code: string;
  correlationId?: string;
  // NEVER include: stack traces, internal schema details, event payloads
}

export class HttpErrorMapper {
  static toResponse(error: unknown, res: Response, correlationId?: string): void {
    // Domain invariant violations → 422
    if (error instanceof DomainInvariantError) {
      res.status(422).json({
        error: error.message,
        code: 'DOMAIN_INVARIANT_VIOLATION',
        correlationId
      } as HttpErrorResponse);
      return;
    }

    // All known domain errors → 400
    if (error instanceof DomainError) {
      res.status(400).json({
        error: error.message,
        code: 'DOMAIN_ERROR',
        correlationId
      } as HttpErrorResponse);
      return;
    }

    // Zod validation errors → 400
    if (error instanceof Error && error.name === 'ZodError') {
      res.status(400).json({
        error: 'Request payload failed schema validation',
        code: 'VALIDATION_ERROR',
        correlationId
      } as HttpErrorResponse);
      return;
    }

    // All unknown errors → generic 500, zero internal details leaked
    console.error('[INTERNAL] Unhandled error:', error);
    res.status(500).json({
      error: 'An internal error occurred',
      code: 'INTERNAL_ERROR',
      correlationId
    } as HttpErrorResponse);
  }
}
