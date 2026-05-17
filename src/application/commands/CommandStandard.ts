import { z } from 'zod';

export const AIProposalSchema = z.object({
  proposalId: z.string().uuid(),
  actionIntent: z.string(),
  reasoning: z.string(),
  rawPayload: z.any(),
  confidence: z.number().min(0).max(1),
  proposedAt: z.date(),
  traceId: z.string().uuid()
});

export type AIProposal = z.infer<typeof AIProposalSchema>;

export const ValidatedCommandSchema = z.object({
  commandId: z.string().uuid(),
  commandDeduplicationKey: z.string(),
  actionType: z.string(),
  payload: z.any(),
  validatedAt: z.date(),
  traceId: z.string().uuid(),
  correlationId: z.string().uuid(),
  causationId: z.string().uuid().optional(),
  // Execution context
  expiresAt: z.date(),
  isDryRun: z.boolean().default(false)
});

export type ValidatedCommand = z.infer<typeof ValidatedCommandSchema>;
