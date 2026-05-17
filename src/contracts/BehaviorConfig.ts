import { z } from 'zod';

export const BehaviorConfigSchema = z.object({
  strictness: z.number().min(0).max(1),
  sarcasm: z.number().min(0).max(1),
  verbosity: z.number().min(0).max(1),
  empathy: z.number().min(0).max(1),
  reminderAggression: z.number().min(0).max(1)
});

export type BehaviorConfig = z.infer<typeof BehaviorConfigSchema>;

export const DefaultBehavior: BehaviorConfig = {
  strictness: 0.6,
  sarcasm: 0.3,
  verbosity: 0.2,
  empathy: 0.5,
  reminderAggression: 0.4
};
