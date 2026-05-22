import { IDocumentMapper, IMongoDocument } from './IDocumentMapper.js';
import { TaskAggregate } from '../../../../domain/task/TaskAggregate.js';
import { TaskState } from '../../../../contracts/StateMachines.js';

export interface TaskMongoDocument extends IMongoDocument {
  state: string;
  priority: string;
}

export class TaskDocumentMapper implements IDocumentMapper<TaskAggregate, TaskMongoDocument> {
  toDomain(document: TaskMongoDocument): TaskAggregate {
    const task = Object.create(TaskAggregate.prototype);
    
    // Natively set protected fields bypass for reconstruction
    Object.assign(task, {
      _id: document._id,
      _version: document.__v,
      _lastUpdatedAt: document.lastUpdatedAt,
      state: document.state as TaskState,
      priority: document.priority,
      _uncommittedEvents: []
    });

    return task as TaskAggregate;
  }

  toDocument(aggregate: TaskAggregate): TaskMongoDocument {
    // We use casting to access private fields for serialization natively
    const agg = aggregate as any;

    return {
      _id: agg._id,
      __v: agg._version,
      lastUpdatedAt: agg._lastUpdatedAt,
      schemaVersion: 1,
      state: agg.state,
      priority: agg.priority
    };
  }
}
