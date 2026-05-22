import { AIProposal, AIProposalSchema } from '../../../application/commands/CommandStandard.js';

export class AIResponseValidator {
  public validate(rawJsonOutput: string): AIProposal {
    try {
      const parsed = JSON.parse(rawJsonOutput);
      
      // Strict schema validation
      const validatedProposal = AIProposalSchema.parse(parsed);

      // Deterministic confidence routing
      if (validatedProposal.confidence < 0.7) {
        throw new Error('AI Confidence below 0.7 threshold. Clarification required.');
      }

      return validatedProposal;
    } catch (error: any) {
      // Safe degradation on malformed output or hallucinated schema
      console.error(`AI Output Validation Failed: ${error.message}`);
      throw new Error('Malformed AI response rejected by validation boundary.');
    }
  }
}
