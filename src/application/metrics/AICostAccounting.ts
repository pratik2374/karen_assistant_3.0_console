export interface TokenUsageRecord {
  recordId: string;
  modelUsed: string;
  tokensConsumed: number;
  operationType: string;
  retryCount: number;
  latencyMs: number;
  estimatedCostUsd: number;
  recordedAt: Date;
  traceId: string;
  correlationId: string;
}

export interface IAICostAccountingStore {
  recordUsage(record: TokenUsageRecord): Promise<void>;
  getDailyUsage(date: Date): Promise<number>;
}
