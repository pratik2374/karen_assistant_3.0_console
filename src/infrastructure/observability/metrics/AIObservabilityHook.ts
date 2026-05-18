export class AIObservabilityHook {
  
  recordProposalGenerated(type: string, model: string, tokenUsage: number, traceId: string): void {
    console.log(JSON.stringify({
      type: 'AI_PROPOSAL_GENERATED',
      proposalType: type,
      model,
      tokenUsage,
      traceId,
      timestamp: new Date().toISOString()
    }));
  }

  recordClarificationTriggered(reason: string, confidence: number, traceId: string): void {
    console.log(JSON.stringify({
      type: 'CLARIFICATION_TRIGGERED',
      reason,
      confidence,
      traceId,
      timestamp: new Date().toISOString()
    }));
  }

  recordFailure(errorType: string, message: string, traceId: string): void {
    console.error(JSON.stringify({
      type: 'AI_FAILURE',
      errorType,
      message,
      traceId,
      timestamp: new Date().toISOString()
    }));
  }

  recordHallucinationDetected(details: string, traceId: string): void {
    console.warn(JSON.stringify({
      type: 'HALLUCINATION_DETECTED',
      details,
      traceId,
      timestamp: new Date().toISOString()
    }));
  }
}
