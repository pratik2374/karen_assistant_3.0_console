import { Request, Response, NextFunction } from 'express';
import { IRequestIdentity, ExecutionModeHeader } from '../dtos/TransportDTOs.js';
import { ExecutionMode } from '../../infrastructure/observability/logging/IStructuredLogger.js';
import { randomUUID } from 'crypto';

declare global {
  namespace Express {
    interface Request {
      identity: IRequestIdentity;
      traceId: string;
      correlationId: string;
    }
  }
}

// Resolves execution mode from request header — defaults to PRODUCTION
const resolveExecutionMode = (req: Request): ExecutionMode => {
  const mode = req.headers[ExecutionModeHeader] as string;
  const valid: ExecutionMode[] = ['PRODUCTION', 'SANDBOX', 'REPLAY', 'DRY_RUN'];
  return valid.includes(mode as ExecutionMode) ? (mode as ExecutionMode) : 'PRODUCTION';
};

// MVP: single-user identity resolution. Architect for multi-user expansion.
export const resolveIdentity = (req: Request, res: Response, next: NextFunction): void => {
  req.traceId = (req.headers['x-trace-id'] as string) ?? randomUUID();
  req.correlationId = (req.headers['x-correlation-id'] as string) ?? randomUUID();

  req.identity = {
    userId: (req.headers['x-user-id'] as string) ?? 'default-user',
    sessionId: (req.headers['x-session-id'] as string) ?? randomUUID(),
    scopes: ['tasks:write', 'reminders:write', 'memory:read'],
    executionMode: resolveExecutionMode(req)
  };

  next();
};
