import { ITokenEstimator } from '../../../application/ai/governance/ITokenEstimator.js';
import { encoding_for_model, TiktokenModel, Tiktoken } from 'tiktoken';

export class TiktokenEstimator implements ITokenEstimator {
  private encoding: Tiktoken | null = null;

  constructor(model: string = 'gpt-4o') {
    try {
      this.encoding = encoding_for_model(model as TiktokenModel);
    } catch (e) {
      console.warn('Tiktoken initialization failed, falling back to heuristic logic');
    }
  }

  estimateTokens(text: string): number {
    if (this.encoding) {
      return this.encoding.encode(text).length;
    }
    
    // Fallback if not initialized
    return Math.ceil(text.length / 4);
  }

  truncateToFit(text: string, maxTokens: number): string {
    if (this.encoding) {
      const tokens = this.encoding.encode(text);
      if (tokens.length <= maxTokens) return text;
      
      const truncatedTokens = tokens.slice(0, maxTokens);
      const decoded = new TextDecoder().decode(this.encoding.decode(truncatedTokens));
      return decoded;
    }

    // Fallback
    const maxChars = maxTokens * 4;
    return text.length > maxChars ? text.substring(0, maxChars) : text;
  }

  free() {
    if (this.encoding) this.encoding.free();
  }
}

