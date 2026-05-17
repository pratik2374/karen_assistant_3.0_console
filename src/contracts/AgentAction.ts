import { z } from 'zod';

export enum ActionType {
  CREATE_TASK = 'CREATE_TASK',
  UPDATE_TASK = 'UPDATE_TASK',
  SEND_REMINDER = 'SEND_REMINDER',
  QUERY_MEMORY = 'QUERY_MEMORY',
  SAVE_RESOURCE = 'SAVE_RESOURCE',
  CREATE_CALENDAR_EVENT = 'CREATE_CALENDAR_EVENT'
}

export const AgentActionSchema = z.object({
  actionType: z.nativeEnum(ActionType),
  payload: z.any(),
  confidence: z.number().min(0).max(1),
  requiresConfirmation: z.boolean(),
  reasoning: z.string(),
  // Execution tracking
  traceId: z.string().uuid(),
  correlationId: z.string().uuid(),
  causationId: z.string().uuid().optional(),
  // AI Expiration rule (if executed after this time, abort)
  expiresAt: z.date(),
  // Simulate execution without side effects
  simulate: z.boolean().default(false)
});

export type AgentAction = z.infer<typeof AgentActionSchema>;
