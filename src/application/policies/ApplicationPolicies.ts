import { TimeContext } from '../../domain/shared/value-objects/TimeContext';

export interface SchedulingPolicy {
  evaluateNextReminder(
    timeContext: TimeContext,
    currentEscalationCount: number,
    priority: string
  ): Date | null;
}

export interface AITokenBudgetPolicy {
  canExecuteCommand(estimatedTokens: number): boolean;
  consumeTokens(tokens: number): void;
}

export interface BurnoutProtectionPolicy {
  shouldSuppressProactiveMessaging(timeContext: TimeContext): boolean;
}
