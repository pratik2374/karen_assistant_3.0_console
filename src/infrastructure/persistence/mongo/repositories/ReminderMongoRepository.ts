import { Db } from 'mongodb';
import { MongoRepository } from './MongoRepository.js';
import { ReminderAggregate } from '../../../../domain/reminder/ReminderAggregate.js';
import { ReminderDocumentMapper, ReminderMongoDocument } from '../mappers/ReminderDocumentMapper.js';

export class ReminderMongoRepository extends MongoRepository<ReminderAggregate, ReminderMongoDocument> {
  constructor(db: Db) {
    super(db, 'aggregates_reminders', new ReminderDocumentMapper());
  }
}
