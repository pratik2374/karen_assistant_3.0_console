// =========================================================================
// RuntimeStore — lightweight in-memory runtime state for the HUD.
// Not persisted. Reset on restart. Observability only.
// =========================================================================

interface AIMetrics {
  model: string;
  promptVersion: string;
  tokensToday: number;
  lastLatencyMs: number;
  proposalsGenerated: number;
  clarificationsTriggered: number;
  hallucinationsRejected: number;
}

interface InfraStatus {
  redis: 'HEALTHY' | 'DEGRADED' | 'UNKNOWN';
  mongo: 'HEALTHY' | 'DEGRADED' | 'UNKNOWN';
  openai: 'HEALTHY' | 'DEGRADED' | 'UNKNOWN';
}

class RuntimeStoreClass {
  public startedAt: Date = new Date();
  public infra: InfraStatus = { redis: 'UNKNOWN', mongo: 'UNKNOWN', openai: 'UNKNOWN' };
  public queueDepth: Record<string, number> = { CRITICAL: 0, HIGH: 0, LOW: 0, LOWEST: 0 };
  public activeTimers: number = 0;
  public activeSessions: number = 0;
  public isReplayMode: boolean = false;
  public webhookCount: number = 0;
  public duplicateWebhooks: number = 0;
  public ai: AIMetrics = {
    model: 'gpt-4o',
    promptVersion: '1.0.0',
    tokensToday: 0,
    lastLatencyMs: 0,
    proposalsGenerated: 0,
    clarificationsTriggered: 0,
    hallucinationsRejected: 0
  };

  public recordWebhook(isDuplicate = false): void {
    this.webhookCount++;
    if (isDuplicate) this.duplicateWebhooks++;
  }

  public recordAICall(latencyMs: number, tokensUsed: number): void {
    this.ai.lastLatencyMs = latencyMs;
    this.ai.tokensToday += tokensUsed;
    this.ai.proposalsGenerated++;
  }

  public get uptimeSeconds(): number {
    return Math.floor((Date.now() - this.startedAt.getTime()) / 1000);
  }

  public get uptimeString(): string {
    const s = this.uptimeSeconds;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h}h ${m}m ${sec}s`;
  }
}

export const RuntimeStore = new RuntimeStoreClass();
