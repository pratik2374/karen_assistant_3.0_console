export interface IProjection<TModel> {
  readonly projectionId: string;
  readonly model: TModel;
  readonly lastUpdatedAt: Date;
  readonly lastEventVersion: number;
}

export interface IProjectionEngine {
  project(event: any): Promise<void>;
  rebuild(events: any[]): Promise<void>;
}

export interface TaskDashboardModel {
  totalActiveTasks: number;
  criticalTasksDue: number;
  recentlyCompleted: number;
}
