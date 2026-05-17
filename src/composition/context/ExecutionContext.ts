import { RuntimeConfig } from '../config/RuntimeConfig';

export type ExecutionMode = 'PRODUCTION' | 'SANDBOX' | 'REPLAY' | 'DRY_RUN' | 'TEST';

// Request-scoped execution context — propagates through the async call chain.
// NEVER stored as global mutable state. A new instance per request/command.
export interface IExecutionContext {
  readonly traceId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly scopes: string[];
  readonly executionMode: ExecutionMode;
  readonly tokenBudgetRemaining: number;
  readonly isReplay: boolean;
  readonly isSandbox: boolean;
}

export class ExecutionContext implements IExecutionContext {
  constructor(
    public readonly traceId: string,
    public readonly correlationId: string,
    public readonly userId: string,
    public readonly sessionId: string,
    public readonly scopes: string[],
    public readonly executionMode: ExecutionMode,
    public readonly tokenBudgetRemaining: number,
    public readonly causationId?: string
  ) {}

  get isReplay(): boolean {
    return this.executionMode === 'REPLAY';
  }

  get isSandbox(): boolean {
    return this.executionMode === 'SANDBOX' || this.executionMode === 'TEST';
  }
}
