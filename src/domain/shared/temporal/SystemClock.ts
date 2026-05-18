export class SystemClock {
  private static instance: SystemClock;
  private isFixed: boolean = false;
  private fixedTime: Date | null = null;

  private constructor() {}

  public static getInstance(): SystemClock {
    if (!SystemClock.instance) {
      SystemClock.instance = new SystemClock();
    }
    return SystemClock.instance;
  }

  // Returns the current deterministic UTC time
  public now(): Date {
    if (this.isFixed && this.fixedTime) {
      return new Date(this.fixedTime.getTime());
    }
    return new Date();
  }

  // Used strictly for testing or simulation/replay
  public fixTime(time: Date): void {
    this.isFixed = true;
    this.fixedTime = time;
  }

  public resetTime(): void {
    this.isFixed = false;
    this.fixedTime = null;
  }
}

export const clock = SystemClock.getInstance();
