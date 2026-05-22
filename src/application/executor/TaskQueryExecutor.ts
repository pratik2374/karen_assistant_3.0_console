import { IQueryExecutor } from './IExecutor.js';
import { IExecutionContext } from '../../composition/context/ExecutionContext.js';
import { Db } from 'mongodb';

export interface GetTaskQuery {
  taskId: string;
}

export interface TaskReadModel {
  taskId: string;
  state: string;
  priority: string;
  title?: string;
  createdAt: string;
}

// -----------------------------------------------------------------------
// TaskQueryExecutor — Read-only execution pipeline.
// Directly queries projection collections (read models).
// NEVER touches aggregates or emits events.
// -----------------------------------------------------------------------
export class TaskQueryExecutor implements IQueryExecutor<GetTaskQuery, TaskReadModel | null> {
  constructor(private readonly db: Db) {}

  async query(query: GetTaskQuery, context: IExecutionContext): Promise<TaskReadModel | null> {
    console.log(JSON.stringify({
      type: 'QUERY_EXECUTED',
      query: 'GetTaskQuery',
      traceId: context.traceId,
      correlationId: context.correlationId,
      executionMode: context.executionMode
    }));

    // Direct read from projection collection, bypassing Aggregate entirely.
    // Assuming projections are kept up to date by event handlers.
    const doc = await this.db.collection('projection_tasks').findOne({ _id: query.taskId as any });
    
    if (!doc) return null;

    return {
      taskId: doc._id.toString(),
      state: doc.state,
      priority: doc.priority,
      title: doc.title,
      createdAt: doc.createdAt?.toISOString() ?? new Date().toISOString()
    };
  }
}
