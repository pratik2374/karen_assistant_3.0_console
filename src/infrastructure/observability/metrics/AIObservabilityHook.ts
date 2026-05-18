import { RuntimeEventBus } from '../../../console/RuntimeEventBus.js';
import { RuntimeStore } from '../../../console/RuntimeStore.js';

export class AIObservabilityHook {

  recordProposalGenerated(type: string, model: string, tokenUsage: number, traceId: string): void {
    RuntimeStore.recordAICall(0, tokenUsage);
    RuntimeEventBus.log('AI_PROPOSAL_GENERATED', 'AI',
      `${type} generated via ${model} (${tokenUsage} tokens)`, traceId, { type, model, tokenUsage });
  }

  recordClarificationTriggered(reason: string, confidence: number, traceId: string): void {
    RuntimeStore.ai.clarificationsTriggered++;
    RuntimeEventBus.log('CLARIFICATION_TRIGGERED', 'AI',
      `Clarification triggered (reason: ${reason}, confidence: ${confidence.toFixed(2)})`, traceId);
  }

  recordFailure(errorType: string, message: string, traceId: string): void {
    RuntimeEventBus.log('AI_FAILURE', 'ERROR',
      `${errorType}: ${message}`, traceId);
  }

  recordHallucinationDetected(details: string, traceId: string): void {
    RuntimeStore.ai.hallucinationsRejected++;
    RuntimeEventBus.log('HALLUCINATION_DETECTED', 'ERROR',
      `Hallucination rejected: ${details}`, traceId);
  }
}
