import { ITokenEstimator } from '../../../application/ai/governance/ITokenEstimator.js';

export class MockEstimator implements ITokenEstimator {
  constructor(private fixedTokenPerChar: number = 0.25) {}

  estimateTokens(text: string): number {
    return Math.ceil(text.length * this.fixedTokenPerChar);
  }

  truncateToFit(text: string, maxTokens: number): string {
    const maxChars = Math.floor(maxTokens / this.fixedTokenPerChar);
    return text.length > maxChars ? text.substring(0, maxChars) : text;
  }
}
