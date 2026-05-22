const { MongoClient } = require('mongodb');
const { randomUUID } = require('crypto');
const Redis = require('ioredis');

async function run() {
  const redis = new Redis('redis://localhost:6379/0');
  const c = new MongoClient('mongodb://localhost:27017/karen');
  await c.connect();
  const db = c.db('karen');
  
  const sagaId = 'saga-reminder-dummy-test-123';
  const traceId = randomUUID();
  const timerId = randomUUID();
  
  // Create dummy saga
  await db.collection('saga_states').updateOne(
    { sagaId },
    {
      $set: {
        _id: sagaId,
        version: 1,
        aggregateId: 'dummy-test-123',
        correlationId: traceId,
        currentState: 'PRE_ALERT',
        sagaType: 'ReminderEscalation',
        startedAt: new Date(),
        traceId,
        updatedAt: new Date(),
        payloadData: {
          taskId: 'dummy-test-123',
          escalationStage: 0,
          userTimezone: 'Asia/Kolkata',
          userId: '917439707352',
          taskTitle: 'MANUAL TEST REMINDER'
        }
      }
    },
    { upsert: true }
  );
  
  // Create dummy timer in MongoDB
  await db.collection('timers').insertOne({
    timerId,
    sagaId,
    sagaType: 'ReminderEscalation',
    actionIntent: 'WAKEUP',
    payload: { stage: 0 },
    targetWakeTime: new Date(Date.now() + 5000).toISOString(),
    status: 'PENDING',
    traceId,
    correlationId: traceId,
    createdAt: new Date(),
    updatedAt: new Date()
  });

  // Schedule timer job
  const { Queue } = require('bullmq');
  const timerQueue = new Queue('timer_wakeup', { connection: redis });
  
  await timerQueue.add('timer-wakeup', {
    timerId,
    sagaId,
    sagaType: 'ReminderEscalation',
    actionIntent: 'WAKEUP',
    payload: { stage: 0 },
    targetWakeTime: new Date(Date.now() + 5000).toISOString(),
    status: 'PENDING',
    traceId,
    correlationId: traceId
  }, { delay: 5000 });
  
  console.log('Dummy Saga scheduled! Waiting 10 seconds for completion...');
  
  setTimeout(async () => {
    await c.close();
    redis.disconnect();
    console.log('Test completed.');
  }, 10000);
}
run().catch(console.error);
