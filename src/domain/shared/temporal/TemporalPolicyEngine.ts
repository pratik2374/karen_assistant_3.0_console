import { clock } from './SystemClock.js';

export interface TemporalPolicy {
  timezone: string;
  dndStartHour: number; // e.g. 22 (10 PM)
  dndEndHour: number;   // e.g. 8  (8 AM)
}

export class TemporalPolicyEngine {
  
  private static getTimezoneOffset(date: Date, timeZone: string): number {
    const tzParts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false
    }).formatToParts(date);

    const utcParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false
    }).formatToParts(date);

    const getPartVal = (parts: Intl.DateTimeFormatPart[], type: string) => 
      parseInt(parts.find(p => p.type === type)!.value, 10);

    const tzYear = getPartVal(tzParts, 'year');
    const tzMonth = getPartVal(tzParts, 'month');
    const tzDay = getPartVal(tzParts, 'day');
    const rawTzHour = getPartVal(tzParts, 'hour');
    const tzHour = rawTzHour === 24 ? 0 : rawTzHour;
    const tzMin = getPartVal(tzParts, 'minute');
    const tzSec = getPartVal(tzParts, 'second');

    const utcYear = getPartVal(utcParts, 'year');
    const utcMonth = getPartVal(utcParts, 'month');
    const utcDay = getPartVal(utcParts, 'day');
    const rawUtcHour = getPartVal(utcParts, 'hour');
    const utcHour = rawUtcHour === 24 ? 0 : rawUtcHour;
    const utcMin = getPartVal(utcParts, 'minute');
    const utcSec = getPartVal(utcParts, 'second');

    const tzTime = Date.UTC(tzYear, tzMonth - 1, tzDay, tzHour, tzMin, tzSec);
    const utcTime = Date.UTC(utcYear, utcMonth - 1, utcDay, utcHour, utcMin, utcSec);

    return tzTime - utcTime;
  }

  // Proactively calculates the next valid execution time
  // If the target time falls within DND, it defers to the END of the DND window.
  public static calculateSafeWakeTime(targetUtcTime: Date, policy: TemporalPolicy): Date {
    const date = new Date(targetUtcTime.getTime());
    
    // 1. Get local timezone components
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: policy.timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false
    }).formatToParts(date);

    const getPartVal = (p: Intl.DateTimeFormatPart[], type: string) => 
      parseInt(p.find(item => item.type === type)!.value, 10);

    const localYear = getPartVal(parts, 'year');
    const localMonth = getPartVal(parts, 'month');
    const localDay = getPartVal(parts, 'day');
    const rawLocalHour = getPartVal(parts, 'hour');
    const localHour = rawLocalHour === 24 ? 0 : rawLocalHour;

    // 2. Check if in DND
    let isDnd = false;
    if (policy.dndStartHour > policy.dndEndHour) {
      isDnd = localHour >= policy.dndStartHour || localHour < policy.dndEndHour;
    } else {
      isDnd = localHour >= policy.dndStartHour && localHour < policy.dndEndHour;
    }

    if (isDnd) {
      // Defer to DND End Hour
      let targetLocalDay = localDay;
      let targetLocalMonth = localMonth;
      let targetLocalYear = localYear;

      if (localHour >= policy.dndStartHour) {
        // Pushing to next local day
        const tempDate = new Date(Date.UTC(localYear, localMonth - 1, localDay + 1));
        targetLocalYear = tempDate.getUTCFullYear();
        targetLocalMonth = tempDate.getUTCMonth() + 1;
        targetLocalDay = tempDate.getUTCDate();
      }

      const approxLocalTime = Date.UTC(targetLocalYear, targetLocalMonth - 1, targetLocalDay, policy.dndEndHour, 0, 0, 0);
      const approxDate = new Date(approxLocalTime);
      const offset = this.getTimezoneOffset(approxDate, policy.timezone);
      return new Date(approxLocalTime - offset);
    }

    return date;
  }

  // Calculates a delay based on the current system clock
  public static calculateDelayMs(safeWakeTime: Date): number {
    const now = clock.now().getTime();
    const delay = safeWakeTime.getTime() - now;
    return delay > 0 ? delay : 0;
  }
}
