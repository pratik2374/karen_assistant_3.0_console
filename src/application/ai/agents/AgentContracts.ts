export interface IAgentGoal {
  intent: 'cancel_reminder' | 'unknown';
  targetCount: number;
  description: string;
  riskLevel: 'LOW' | 'HIGH';
  targetTaskIds: string[];
}

export interface IAgentResult {
  status: 'SUCCESS' | 'FAILED';
  summaryReport: string;
  mutationsCount: number;
}

export interface ISubAgent {
  name: string;
  model: string;
  establishGoal(query: string, activeReminders: any[]): Promise<IAgentGoal>;
  execute(goal: IAgentGoal, persistence: any, traceId: string, correlationId: string): Promise<IAgentResult>;
}
