import { ITokenEstimator } from './ITokenEstimator.js';
import { IMemoryBlock, MemoryTier } from '../../../domain/memory/MemoryTiers.js';
import { ContextAssemblyMode, ModeConfigs } from '../ContextAssemblyModes.js';
import { ContextProvenance, AssembledContextBlock } from '../../../domain/memory/ContextProvenance.js';

export class TokenBudgetManager {
  constructor(private estimator: ITokenEstimator) {}

  public assembleAndBudget(
    memories: IMemoryBlock[],
    mode: ContextAssemblyMode
  ): { blocks: AssembledContextBlock[], totalTokens: number } {
    const config = ModeConfigs[mode];
    let remainingBudget = config.maxTokens;
    const blocks: AssembledContextBlock[] = [];

    // 1. Filter out memory tiers not allowed in this mode
    const allowedMemories = memories.filter(m => config.allowedTiers.includes(m.tier));

    // 2. Sort by Priority (Tier) ASCENDING (WorkingMemory=0 is highest priority), then by Relevance DESCENDING
    allowedMemories.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      return b.relevanceScore - a.relevanceScore;
    });

    for (const memory of allowedMemories) {
      if (remainingBudget <= 0) break;

      const baseTokenCount = this.estimator.estimateTokens(memory.content);

      if (baseTokenCount <= remainingBudget) {
        // Fits entirely
        blocks.push({
          tierName: MemoryTier[memory.tier],
          content: memory.content,
          tokenCount: baseTokenCount,
          provenance: {
            sourceMemoryIds: [memory.memoryId],
            retrievalReason: `Matches mode ${mode} priorities`,
            rankingScore: memory.relevanceScore,
            isSanitized: true, // Assuming sanitization happened before
            isTruncated: false
          }
        });
        remainingBudget -= baseTokenCount;
      } else {
        // Must truncate to fit remaining budget
        const truncatedContent = this.estimator.truncateToFit(memory.content, remainingBudget);
        const truncatedTokens = this.estimator.estimateTokens(truncatedContent);

        blocks.push({
          tierName: MemoryTier[memory.tier],
          content: truncatedContent,
          tokenCount: truncatedTokens,
          provenance: {
            sourceMemoryIds: [memory.memoryId],
            retrievalReason: `Matches mode ${mode} priorities`,
            rankingScore: memory.relevanceScore,
            isSanitized: true,
            isTruncated: true
          }
        });
        remainingBudget = 0; // Budget exhausted
      }
    }

    return { blocks, totalTokens: config.maxTokens - remainingBudget };
  }
}
