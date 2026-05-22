import { IDocumentMapper, IMongoDocument } from './IDocumentMapper.js';
import { ReminderAggregate } from '../../../../domain/reminder/ReminderAggregate.js';
import { ReminderState } from '../../../../contracts/StateMachines.js';

export interface ReminderMongoDocument extends IMongoDocument {
  taskId: string;
  state: string;
  escalationCount: number;
}

export class ReminderDocumentMapper implements IDocumentMapper<ReminderAggregate, ReminderMongoDocument> {
  toDomain(document: ReminderMongoDocument): ReminderAggregate {
    const reminder = Object.create(ReminderAggregate.prototype);

    Object.assign(reminder, {
      _id: document._id,
      _version: document.__v,
      _lastUpdatedAt: document.lastUpdatedAt,
      taskId: document.taskId,
      state: document.state as ReminderState,
      escalationCount: document.escalationCount,
      _uncommittedEvents: []
    });

    return reminder as ReminderAggregate;
  }

  toDocument(aggregate: ReminderAggregate): ReminderMongoDocument {
    const agg = aggregate as any;

    return {
      _id: agg._id,
      __v: agg._version,
      lastUpdatedAt: agg._lastUpdatedAt || new Date(),
      schemaVersion: 1,
      taskId: agg.taskId,
      state: agg.state,
      escalationCount: agg.escalationCount
    };
  }
}
