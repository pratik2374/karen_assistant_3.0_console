import { z } from 'zod';

export const MemoryRetrievalSignalSchema = z.object({
  semanticSimilarity: z.number().min(0).max(1),
  recencyWeight: z.number().min(0).max(1),
  importanceScore: z.number().min(0).max(10),
  goalRelevance: z.number().min(0).max(1),
  behavioralRelevance: z.number().min(0).max(1)
});

export type MemoryRetrievalSignal = z.infer<typeof MemoryRetrievalSignalSchema>;

export const RetrievalScoringWeights = {
  semantic: 0.4,
  recency: 0.2,
  importance: 0.2,
  goal: 0.1,
  behavioral: 0.1
};
