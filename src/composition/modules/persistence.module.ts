import { MongoClient, Db } from 'mongodb';
import { RuntimeConfig } from '../config/RuntimeConfig';
import { MongoUnitOfWork } from '../../infrastructure/persistence/mongo/uow/MongoUnitOfWork';
import { MongoOutboxStore } from '../../infrastructure/persistence/mongo/outbox/MongoOutboxStore';
import { TaskMongoRepository } from '../../infrastructure/persistence/mongo/repositories/TaskMongoRepository';
import { ReminderMongoRepository } from '../../infrastructure/persistence/mongo/repositories/ReminderMongoRepository';

export interface PersistenceModule {
  client: MongoClient;
  db: Db;
  taskRepository: TaskMongoRepository;
  reminderRepository: ReminderMongoRepository;
  outboxStore: MongoOutboxStore;
  buildUnitOfWork: () => MongoUnitOfWork; // Scoped — new instance per operation
}

export async function buildPersistenceModule(config: RuntimeConfig): Promise<PersistenceModule> {
  const client = new MongoClient(config.MONGO_URI);
  await client.connect();

  const db = client.db(config.MONGO_DB_NAME);

  const taskRepository = new TaskMongoRepository(db);
  const reminderRepository = new ReminderMongoRepository(db);
  const outboxStore = new MongoOutboxStore(db);

  // UnitOfWork is scoped — not a singleton
  const buildUnitOfWork = () => new MongoUnitOfWork(client, db);

  console.log('[PERSISTENCE] MongoDB connected and repositories wired.');
  return { client, db, taskRepository, reminderRepository, outboxStore, buildUnitOfWork };
}
