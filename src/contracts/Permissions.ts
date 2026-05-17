import { z } from 'zod';

export enum PermissionScope {
  READ_MEMORY = 'READ_MEMORY',
  WRITE_MEMORY = 'WRITE_MEMORY',
  SEND_EMAIL = 'SEND_EMAIL',
  ACCESS_RESOURCE = 'ACCESS_RESOURCE',
  MODIFY_CALENDAR = 'MODIFY_CALENDAR',
  SYSTEM_CONFIG = 'SYSTEM_CONFIG'
}

export enum PermissionLevel {
  AUTO_SAFE = 0,
  SOFT_CONFIRM = 1,
  HARD_CONFIRM = 2,
  RESTRICTED = 3
}

export const PermissionScopeSchema = z.nativeEnum(PermissionScope);
export const PermissionLevelSchema = z.nativeEnum(PermissionLevel);

// Enforce scopes required for given action types
// This mapping prevents GPT from accessing resources without the Orchestrator verifying scope
export const ActionScopeRequirements: Record<string, PermissionScope[]> = {
  CREATE_TASK: [],
  QUERY_MEMORY: [PermissionScope.READ_MEMORY],
  SAVE_RESOURCE: [PermissionScope.WRITE_MEMORY, PermissionScope.ACCESS_RESOURCE],
  CREATE_CALENDAR_EVENT: [PermissionScope.MODIFY_CALENDAR]
};
