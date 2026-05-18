import { z } from 'zod';

export enum ProposalType {
  COMMAND_PROPOSAL = 'COMMAND_PROPOSAL',
  CLARIFICATION_REQUEST = 'CLARIFICATION_REQUEST',
  MEMORY_REFERENCE = 'MEMORY_REFERENCE',
  INFORMATION_RESPONSE = 'INFORMATION_RESPONSE',
  SCHEDULING_SUGGESTION = 'SCHEDULING_SUGGESTION',
  TOOL_REQUEST = 'TOOL_REQUEST'
}

export const BaseProposalSchema = z.object({
  proposalId: z.string().uuid().optional(), // Can be assigned post-generation
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

export const CommandProposalSchema = BaseProposalSchema.extend({
  proposalType: z.literal(ProposalType.COMMAND_PROPOSAL),
  actionIntent: z.string(),
  rawPayload: z.record(z.string(), z.any())
});

export const ClarificationRequestSchema = BaseProposalSchema.extend({
  proposalType: z.literal(ProposalType.CLARIFICATION_REQUEST),
  missingInformation: z.array(z.string()),
  clarificationPrompt: z.string()
});

export const ToolRequestSchema = BaseProposalSchema.extend({
  proposalType: z.literal(ProposalType.TOOL_REQUEST),
  toolName: z.string(),
  toolArguments: z.record(z.string(), z.any())
});

export const InformationResponseSchema = BaseProposalSchema.extend({
  proposalType: z.literal(ProposalType.INFORMATION_RESPONSE),
  responseText: z.string()
});

// The master union
export const AIProposalSchema = z.discriminatedUnion('proposalType', [
  CommandProposalSchema,
  ClarificationRequestSchema,
  ToolRequestSchema,
  InformationResponseSchema
  // We can add SCHEDULING_SUGGESTION, MEMORY_REFERENCE later when fully implementing those
]);

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
