import { HumanOverridePolicy } from '../../security/HumanOverridePolicy.js';
import { CircuitBreaker } from '../../resiliency/CircuitBreaker.js';

export interface ToolExecutionContext {
  operationName: string;
  isReplay: boolean;
  isSandbox: boolean;
  replaySafe: boolean;
  idempotencyKey: string;
  requiredScopes: string[];
}

export abstract class ToolExecutionGateway {
  constructor(private circuitBreaker: CircuitBreaker) {}

  public async execute<T>(
    context: ToolExecutionContext,
    operation: () => Promise<T>,
    mockOperation: () => Promise<T>
  ): Promise<T> {
    if (HumanOverridePolicy.isIntegrationDisabled()) {
      throw new Error(`Integration disabled by HumanOverridePolicy. Blocked: ${context.operationName}`);
    }

    if (context.isReplay && !context.replaySafe) {
      console.warn(`[REPLAY GUARD] Suppressed unsafe tool execution: ${context.operationName}`);
      return mockOperation();
    }

    if (context.isSandbox) {
      console.log(`[SANDBOX] Simulating tool execution: ${context.operationName}`);
      return mockOperation();
    }

    // Wrap execution in Circuit Breaker to prevent cascading failures
    return this.circuitBreaker.execute(operation);
  }
}
