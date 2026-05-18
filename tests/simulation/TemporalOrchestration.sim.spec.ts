import { TemporalPolicyEngine, TemporalPolicy } from '../../src/domain/shared/temporal/TemporalPolicyEngine';
import { clock } from '../../src/domain/shared/temporal/SystemClock';

describe('Temporal Orchestration Simulation', () => {

  afterEach(() => {
    clock.resetTime();
  });

  it('calculates safe wake time when target is inside DND window', () => {
    // Policy: DND is 10 PM (22) to 8 AM (8)
    const policy: TemporalPolicy = { timezone: 'UTC', dndStartHour: 22, dndEndHour: 8 };
    
    // Simulate current time is 11 PM (23:00) inside DND
    const targetTime = new Date();
    targetTime.setUTCHours(23, 0, 0, 0);

    const safeWakeTime = TemporalPolicyEngine.calculateSafeWakeTime(targetTime, policy);

    // Should push to next day at 8 AM
    expect(safeWakeTime.getUTCHours()).toBe(8);
    expect(safeWakeTime.getUTCDate()).toBe(targetTime.getUTCDate() + 1);
  });

  it('calculates safe wake time when target is inside morning DND window', () => {
    const policy: TemporalPolicy = { timezone: 'UTC', dndStartHour: 22, dndEndHour: 8 };
    
    // Simulate current time is 2 AM (02:00) inside DND
    const targetTime = new Date();
    targetTime.setUTCHours(2, 0, 0, 0);

    const safeWakeTime = TemporalPolicyEngine.calculateSafeWakeTime(targetTime, policy);

    // Should push to SAME day at 8 AM
    expect(safeWakeTime.getUTCHours()).toBe(8);
    expect(safeWakeTime.getUTCDate()).toBe(targetTime.getUTCDate());
  });

  it('returns original target time if outside DND window', () => {
    const policy: TemporalPolicy = { timezone: 'UTC', dndStartHour: 22, dndEndHour: 8 };
    
    // Simulate current time is 2 PM (14:00) OUTSIDE DND
    const targetTime = new Date();
    targetTime.setUTCHours(14, 0, 0, 0);

    const safeWakeTime = TemporalPolicyEngine.calculateSafeWakeTime(targetTime, policy);

    // Should remain exactly the same
    expect(safeWakeTime.getTime()).toBe(targetTime.getTime());
  });

  it('abstracts clock for deterministic simulation', () => {
    const fixed = new Date('2026-05-18T10:00:00Z');
    clock.fixTime(fixed);

    expect(clock.now().getTime()).toBe(fixed.getTime());
    
    // Fast forward 1 hour
    clock.fixTime(new Date(fixed.getTime() + 3600000));
    expect(clock.now().getUTCHours()).toBe(11);
  });
});
