import { RuntimeConfig } from '../config/RuntimeConfig';
import { OpenAIAdapter } from '../../infrastructure/ai/openai/OpenAIAdapter';
import { DeterministicContextSanitizer } from '../../infrastructure/ai/security/ContextSanitizer';
import { AIResponseValidator } from '../../infrastructure/ai/validation/AIResponseValidator';
import { CircuitBreaker } from '../../infrastructure/resiliency/CircuitBreaker';
import { AITokenBudgetPolicy } from '../../application/policies/ApplicationPolicies';

export interface AIModule {
  openAIAdapter: OpenAIAdapter;
  circuitBreaker: CircuitBreaker;
}

// Simple in-process token budget tracker (replace with Redis-backed in production)
class InMemoryTokenBudgetPolicy implements AITokenBudgetPolicy {
  private consumed = 0;
  constructor(private daily: number) {}
  canExecuteCommand(estimated: number): boolean { return this.consumed + estimated <= this.daily; }
  consumeTokens(tokens: number): void { this.consumed += tokens; }
}

export function buildAIModule(config: RuntimeConfig): AIModule {
  const circuitBreaker = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30000 });
  const openAIAdapter = new OpenAIAdapter(config.OPENAI_API_KEY || 'dummy-key');

  console.log('[AI] OpenAI adapter and circuit breaker wired.');
  return { openAIAdapter, circuitBreaker };
}
