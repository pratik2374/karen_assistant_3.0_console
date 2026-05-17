export class TimeContext {
  constructor(
    public readonly timezone: string,
    public readonly utcOffsetMinutes: number,
    public readonly currentUtcTime: Date,
    public readonly localTime: Date,
    public readonly isDndWindow: boolean
  ) {}

  static create(
    timezone: string,
    utcOffsetMinutes: number,
    currentUtcTime: Date,
    localTime: Date,
    isDndWindow: boolean
  ): TimeContext {
    return new TimeContext(timezone, utcOffsetMinutes, currentUtcTime, localTime, isDndWindow);
  }
}
