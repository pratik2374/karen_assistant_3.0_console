import { Db } from 'mongodb';
import { MongoRepository } from './MongoRepository';
import { ReminderAggregate } from '../../../../domain/reminder/ReminderAggregate';
import { ReminderDocumentMapper, ReminderMongoDocument } from '../mappers/ReminderDocumentMapper';

export class ReminderMongoRepository extends MongoRepository<ReminderAggregate, ReminderMongoDocument> {
  constructor(db: Db) {
    super(db, 'aggregates_reminders', new ReminderDocumentMapper());
  }
}
