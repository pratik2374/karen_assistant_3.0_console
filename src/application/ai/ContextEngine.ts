import { IMemoryBlock } from '../../domain/memory/MemoryTiers.js';
import { AssembledContext } from '../../domain/memory/ContextProvenance.js';
import { ContextAssemblyMode } from './ContextAssemblyModes.js';
import { TokenBudgetManager } from './governance/TokenBudgetManager.js';
import { DeterministicContextSanitizer, PromptSanitizationPolicy } from '../../infrastructure/ai/security/ContextSanitizer.js';
import { ContextObservabilityHook } from '../../infrastructure/observability/metrics/ContextObservabilityHook.js';

export interface RetrievalIntent {
  query: string;
  tags: string[];
  mode: ContextAssemblyMode;
  traceId: string;
}

export class ContextEngine {
  constructor(
    private budgetManager: TokenBudgetManager,
    private sanitizer: DeterministicContextSanitizer,
    private hook: ContextObservabilityHook
  ) {}

  public async assembleContext(
    intent: RetrievalIntent,
    availableMemories: IMemoryBlock[] // Injected from DB/Repository
  ): Promise<AssembledContext> {
    
    // 1. Semantic/Tag Retrieval (Stubbed for MVP: Filter by tags & score)
    const retrievedMemories = this.deterministicRetrieval(intent, availableMemories);

    // 2. Sanitization Pipeline
    const sanitizedMemories: IMemoryBlock[] = [];
    const policy: PromptSanitizationPolicy = {
      maxLength: 100000,
      shouldRedactEmails: true,
      shouldRedactUrls: true,
      shouldEnforceXmlBoundaries: true,
      shouldRedactSecrets: true
    };

    for (const mem of retrievedMemories) {
      const sanitized = await this.sanitizer.inspectInput(mem.content, policy);
      sanitizedMemories.push({
        ...mem,
        content: sanitized.cleanPayload
      });

      if (sanitized.redactedKeys.length > 0) {
        this.hook.recordSanitization(mem.memoryId, sanitized.redactedKeys, intent.traceId);
      }
    }

    // 3. Token Budgeting & Truncation
    const assembled = this.budgetManager.assembleAndBudget(sanitizedMemories, intent.mode);

    // 4. Observability
    for (const block of assembled.blocks) {
      if (block.provenance.isTruncated) {
        this.hook.recordTruncation(block.provenance.sourceMemoryIds[0], intent.traceId);
      }
    }

    this.hook.recordContextAssembled(intent.mode, assembled.totalTokens, assembled.blocks.length, intent.traceId);

    return {
      blocks: assembled.blocks,
      totalTokens: assembled.totalTokens,
      budgetUtilized: assembled.totalTokens, // In MVP, utilized = total
      assemblyMode: intent.mode
    };
  }

  private deterministicRetrieval(intent: RetrievalIntent, pool: IMemoryBlock[]): IMemoryBlock[] {
    // A simple MVP deterministic scorer
    return pool.map(mem => {
      let score = 0;
      // Recency bias
      const ageDays = (Date.now() - mem.createdAt.getTime()) / (1000 * 60 * 60 * 24);
      score += Math.max(0, 10 - ageDays);

      // Tag overlap
      const matchingTags = mem.tags.filter(t => intent.tags.includes(t));
      score += matchingTags.length * 5;

      return { ...mem, relevanceScore: score };
    }).filter(mem => mem.relevanceScore > 0); // Must have some relevance
  }
}
