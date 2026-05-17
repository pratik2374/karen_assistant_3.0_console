import { z } from 'zod';

export enum TaskState {
  CREATED = 'CREATED',
  SCHEDULED = 'SCHEDULED',
  ACTIVE = 'ACTIVE',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  IN_PROGRESS = 'IN_PROGRESS',
  MISSED = 'MISSED',
  RESCHEDULED = 'RESCHEDULED',
  COMPLETED = 'COMPLETED',
  ARCHIVED = 'ARCHIVED'
}

export enum ReminderState {
  PENDING = 'PENDING',
  SENT = 'SENT',
  FOLLOWUP_1 = 'FOLLOWUP_1',
  FOLLOWUP_2 = 'FOLLOWUP_2',
  ESCALATED = 'ESCALATED',
  STOPPED = 'STOPPED'
}

// Validation schemas
export const TaskStateSchema = z.nativeEnum(TaskState);
export const ReminderStateSchema = z.nativeEnum(ReminderState);

// Valid transition maps to enforce determinism
export const ValidTaskTransitions: Record<TaskState, TaskState[]> = {
  [TaskState.CREATED]: [TaskState.SCHEDULED, TaskState.ACTIVE, TaskState.ARCHIVED],
  [TaskState.SCHEDULED]: [TaskState.ACTIVE, TaskState.RESCHEDULED, TaskState.MISSED, TaskState.ARCHIVED],
  [TaskState.ACTIVE]: [TaskState.ACKNOWLEDGED, TaskState.IN_PROGRESS, TaskState.COMPLETED, TaskState.MISSED],
  [TaskState.ACKNOWLEDGED]: [TaskState.IN_PROGRESS, TaskState.COMPLETED, TaskState.RESCHEDULED],
  [TaskState.IN_PROGRESS]: [TaskState.COMPLETED, TaskState.RESCHEDULED],
  [TaskState.MISSED]: [TaskState.RESCHEDULED, TaskState.ARCHIVED],
  [TaskState.RESCHEDULED]: [TaskState.SCHEDULED, TaskState.ACTIVE],
  [TaskState.COMPLETED]: [TaskState.ARCHIVED],
  [TaskState.ARCHIVED]: []
};

export const ValidReminderTransitions: Record<ReminderState, ReminderState[]> = {
  [ReminderState.PENDING]: [ReminderState.SENT, ReminderState.STOPPED],
  [ReminderState.SENT]: [ReminderState.FOLLOWUP_1, ReminderState.STOPPED],
  [ReminderState.FOLLOWUP_1]: [ReminderState.FOLLOWUP_2, ReminderState.STOPPED],
  [ReminderState.FOLLOWUP_2]: [ReminderState.ESCALATED, ReminderState.STOPPED],
  [ReminderState.ESCALATED]: [ReminderState.STOPPED],
  [ReminderState.STOPPED]: []
};
