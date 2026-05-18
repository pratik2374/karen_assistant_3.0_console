import { clock } from './SystemClock';

export interface TemporalPolicy {
  timezone: string;
  dndStartHour: number; // e.g. 22 (10 PM)
  dndEndHour: number;   // e.g. 8  (8 AM)
}

export class TemporalPolicyEngine {
  
  // Proactively calculates the next valid execution time
  // If the target time falls within DND, it defers to the END of the DND window.
  public static calculateSafeWakeTime(targetUtcTime: Date, policy: TemporalPolicy): Date {
    // For MVP, we will use a naive approach assuming simple UTC bounds.
    // In production, you would use a library like luxon or date-fns-tz to convert targetUtcTime 
    // to the local timezone, check the local hour against DND bounds, and then convert back to UTC.
    
    // Simplistic simulation of DND logic for architecture validation:
    // If target UTC hour + offset falls in DND, push forward.
    const target = new Date(targetUtcTime.getTime());
    
    // We assume timezone offset is 0 for this naive implementation, 
    // but the engine explicitly encapsulates this complex temporal logic.
    const localHour = target.getUTCHours(); 
    
    const isDnd = localHour >= policy.dndStartHour || localHour < policy.dndEndHour;
    
    if (isDnd) {
      // Defer to DND End Hour
      if (localHour >= policy.dndStartHour) {
        // Next day at end hour
        target.setUTCDate(target.getUTCDate() + 1);
      }
      target.setUTCHours(policy.dndEndHour, 0, 0, 0);
      return target;
    }

    return target;
  }

  // Calculates a delay based on the current system clock
  public static calculateDelayMs(safeWakeTime: Date): number {
    const now = clock.now().getTime();
    const delay = safeWakeTime.getTime() - now;
    return delay > 0 ? delay : 0;
  }
}
