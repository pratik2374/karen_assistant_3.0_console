import { Db } from 'mongodb';
import { MongoRepository } from './MongoRepository.js';
import { TaskAggregate } from '../../../../domain/task/TaskAggregate.js';
import { TaskDocumentMapper, TaskMongoDocument } from '../mappers/TaskDocumentMapper.js';

export class TaskMongoRepository extends MongoRepository<TaskAggregate, TaskMongoDocument> {
  constructor(db: Db) {
    super(db, 'aggregates_tasks', new TaskDocumentMapper());
  }
}
