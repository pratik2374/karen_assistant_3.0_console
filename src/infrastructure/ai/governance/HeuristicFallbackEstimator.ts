import { ITokenEstimator } from '../../../application/ai/governance/ITokenEstimator.js';

export class HeuristicFallbackEstimator implements ITokenEstimator {
  // A safe heuristic is 1 token ~ 4 characters in English
  
  estimateTokens(text: string): number {
    if (!text) return 0;
    // Add 10% safety margin for complex characters
    return Math.ceil((text.length / 4) * 1.1);
  }

  truncateToFit(text: string, maxTokens: number): string {
    const estimatedTokens = this.estimateTokens(text);
    if (estimatedTokens <= maxTokens) return text;

    // We must aggressively truncate
    // We reverse calculate: maxTokens / 1.1 * 4
    const safeChars = Math.floor((maxTokens / 1.1) * 4);
    
    // Truncate cleanly at a word boundary if possible, but for deterministic safety, hard truncate
    return text.substring(0, safeChars);
  }
}
