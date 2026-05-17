export enum CompensationStrategy {
  RETRY = 'RETRY',
  ROLLBACK = 'ROLLBACK',
  MANUAL_INTERVENTION = 'MANUAL_INTERVENTION',
  IGNORE = 'IGNORE'
}

export interface CompensationAction {
  strategy: CompensationStrategy;
  reason: string;
  payload: any;
}
