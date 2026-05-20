import { IAgent, AgentContext, AgentExecutionResult } from '../base/IAgent.js';
import { RuntimeEventBus } from '../../console/RuntimeEventBus.js';
import { OpenAI, OpenAIAgent } from '@llamaindex/openai';
import { FunctionTool } from 'llamaindex';
import { ICommandExecutor } from '../../application/executor/IExecutor.js';
import { PersistenceModule } from '../../composition/modules/persistence.module.js';
import { ReminderAggregate } from '../../domain/reminder/ReminderAggregate.js';
import { randomUUID } from 'crypto';
import * as dotenv from 'dotenv';
dotenv.config();

export class SystemOpsAgent implements IAgent {
  readonly name = 'SystemOpsAgent';
  readonly domain = 'system_operations';
  readonly capabilities = [
    'query_system_status',
    'query_reminders',
    'query_sagas',
    'query_timers',
    'query_calendar_sync',
    'create_reminder',
    'complete_task',
    'cancel_reminder',
    'remove_reminder',
    'complete_reminder'
  ];

  constructor(
    private persistence: PersistenceModule,
    private commandExecutor: ICommandExecutor<any, any>
  ) {}

  private createTools(context: AgentContext): any[] {
    const db = this.persistence.db;

    const queryReminders = FunctionTool.from(
      async ({ query }: { query: Record<string, any> }) => {
        try {
          const results = await db.collection('aggregates_reminders').find(query).limit(10).toArray();
          return JSON.stringify(results, null, 2);
        } catch (err: any) {
          return `Error querying reminders: ${err.message}`;
        }
      },
      {
        name: 'query_reminders',
        description: 'Query the MongoDB reminders collection. Pass a valid MongoDB query object.',
        parameters: { type: 'object', properties: { query: { type: 'object' } }, required: ['query'] }
      }
    );

    const querySagas = FunctionTool.from(
      async ({ query }: { query: Record<string, any> }) => {
        try {
          const results = await db.collection('sagas').find(query).limit(10).toArray();
          return JSON.stringify(results, null, 2);
        } catch (err: any) {
          return `Error querying sagas: ${err.message}`;
        }
      },
      {
        name: 'query_sagas',
        description: 'Query the MongoDB sagas (escalations/processes) collection.',
        parameters: { type: 'object', properties: { query: { type: 'object' } }, required: ['query'] }
      }
    );

    const queryCalendarSync = FunctionTool.from(
      async ({ query }: { query: Record<string, any> }) => {
        try {
          const results = await db.collection('calendar_projections').find(query).limit(10).toArray();
          return JSON.stringify(results, null, 2);
        } catch (err: any) {
          return `Error querying calendar projections: ${err.message}`;
        }
      },
      {
        name: 'query_calendar_sync',
        description: 'Query the MongoDB calendar projections collection.',
        parameters: { type: 'object', properties: { query: { type: 'object' } }, required: ['query'] }
      }
    );

    const queryTimers = FunctionTool.from(
      async ({ query }: { query: Record<string, any> }) => {
        try {
          const results = await db.collection('timers').find(query).limit(10).toArray();
          return JSON.stringify(results, null, 2);
        } catch (err: any) {
          return `Error querying timers: ${err.message}`;
        }
      },
      {
        name: 'query_timers',
        description: 'Query the MongoDB timers collection.',
        parameters: { type: 'object', properties: { query: { type: 'object' } }, required: ['query'] }
      }
    );

    const queryTasks = FunctionTool.from(
      async (_args: {}) => {
        try {
          // Fetch all CREATED tasks - no limit so old ones don't crowd out new ones
          const tasks = await db.collection('aggregates_tasks').find({ state: 'CREATED' }).toArray();
          const taskIds = tasks.map((t: any) => t._id);
          
          if (taskIds.length === 0) return "No pending tasks found.";

          // Enrich with title + expiresAt from outbox_events
          const events = await db.collection('outbox_events').find({
            eventType: 'Task.Created',
            'payload.aggregateId': { $in: taskIds }
          }).toArray();

          const now = new Date();

          const enrichedTasks = tasks.map((task: any) => {
            const creationEvent = events.find((e: any) => e.payload.aggregateId === task._id);
            return {
              taskId: task._id,
              state: task.state,
              title: creationEvent?.payload.payload.title,
              expiresAt: creationEvent?.payload.payload.expiresAt,
              lastUpdatedAt: task.lastUpdatedAt
            };
          });

          // Filter to ONLY non-expired, upcoming reminders
          const upcomingTasks = enrichedTasks
            .filter((t: any) => t.expiresAt && new Date(t.expiresAt) > now)
            .sort((a: any, b: any) => new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime());

          if (upcomingTasks.length === 0) {
            return "No upcoming (non-expired) pending tasks found.";
          }

          return JSON.stringify(upcomingTasks, null, 2);
        } catch (err: any) {
          return `Error querying tasks: ${err.message}`;
        }
      },
      {
        name: 'query_tasks',
        description: 'Returns all UPCOMING (non-expired) pending reminders/tasks. No arguments needed — just call it. Results are sorted by soonest due time.',
        parameters: { type: 'object', properties: {} }
      }
    );

    const createReminder = FunctionTool.from(
      async ({ title, dueAt, priority, timezone }: { title: string, dueAt: string, priority?: string, timezone?: string }) => {
        try {
          const commandId = randomUUID();
          const command = {
            commandId,
            commandDeduplicationKey: randomUUID(),
            title,
            priority: priority || 'high',
            dueAt: new Date(dueAt),
            timezone: timezone || 'Asia/Kolkata',
            userId: context.userId
          };
          const execContext = {
            traceId: context.traceId,
            correlationId: context.correlationId || randomUUID(),
            userId: context.userId,
            sessionId: randomUUID(),
            scopes: ['tasks:write'],
            executionMode: 'PRODUCTION' as any,
            tokenBudgetRemaining: 500000,
            isReplay: false,
            isSandbox: false
          };
          const result = await this.commandExecutor.execute(command, execContext);
          return `Successfully created reminder. Task ID: ${result.taskId}`;
        } catch (err: any) {
          return `Error creating reminder: ${err.message}`;
        }
      },
      {
        name: 'create_reminder',
        description: 'Create a new reminder/task in the system. dueAt must be an ISO 8601 string.',
        parameters: { 
          type: 'object', 
          properties: { 
            title: { type: 'string' }, 
            dueAt: { type: 'string' },
            priority: { type: 'string' },
            timezone: { type: 'string' }
          }, 
          required: ['title', 'dueAt'] 
        }
      }
    );

    const acknowledgeReminder = FunctionTool.from(
      async ({ taskId }: { taskId: string }) => {
        const uow = this.persistence.buildUnitOfWork();
        await uow.start();
        try {
          const reminderId = `reminder-${taskId}`;
          let reminder = await this.persistence.reminderRepository.findById(reminderId);
          
          let expectedVersion = 0;
          if (!reminder) {
            reminder = ReminderAggregate.initialize(reminderId, taskId, context.traceId, context.correlationId || randomUUID());
          } else {
            expectedVersion = reminder.version;
          }

          reminder.acknowledge(context.traceId, context.correlationId || randomUUID());
          await this.persistence.reminderRepository.saveWithVersion(reminder, expectedVersion);

          const now = new Date();
          const outboxMessages = reminder.uncommittedEvents.map((event: any) => ({
            messageId: randomUUID(),
            eventType: event.eventType,
            payload: event,
            createdAt: now,
            processedAt: null,
            idempotencyKey: `${context.correlationId}:${event.eventType}:${reminder!.version}`,
            deduplicationKey: `${reminderId}:${event.eventType}:${reminder!.version}`,
            replaySafe: false,
            sideEffectFree: false,
            traceId: context.traceId,
            correlationId: context.correlationId || randomUUID(),
            causationId: randomUUID()
          }));

          await this.persistence.outboxStore.saveBulk(outboxMessages);
          await uow.commit();

          return `Successfully acknowledged/completed reminder ${taskId}.`;
        } catch (err: any) {
          await uow.rollback();
          return `Error completing reminder: ${err.message}`;
        }
      },
      {
        name: 'acknowledge_reminder',
        description: 'Complete or cancel a reminder. Provide the ID of the task/reminder to acknowledge it.',
        parameters: { 
          type: 'object', 
          properties: { taskId: { type: 'string' } }, 
          required: ['taskId'] 
        }
      }
    );

    return [queryReminders, queryTasks, querySagas, queryCalendarSync, queryTimers, createReminder, acknowledgeReminder];
  }

  async execute(context: AgentContext): Promise<AgentExecutionResult> {
    const start = Date.now();

    RuntimeEventBus.log('AGENT_STARTED', 'AI',
      `SystemOpsAgent executing intent via LlamaIndex: ${context.intent}`,
      context.traceId
    );

    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY is missing from environment variables');
      }

      const llm = new OpenAI({
        apiKey,
        model: 'gpt-5.4-mini', 
        temperature: 0,
      });

      const tools = this.createTools(context);

      const agent = new OpenAIAgent({
        tools,
        llm,
        verbose: true,
      });

      const userQuery = context.payload.userQuery || context.payload.query || JSON.stringify(context.payload) || '';
      
      const query = `
You are a highly capable System Operations Meta-Agent for Karen.
Your task is to inspect the internal database state and manage reminders/tasks.

Intent: ${context.intent}
Parameters from Karen: ${JSON.stringify(context.payload)}
User said: "${userQuery}"
Current UTC Time: ${new Date().toISOString()}

RULES:
1. If intent is CREATE a reminder/task → use create_reminder tool.
2. If intent is CANCEL/COMPLETE a reminder → use acknowledge_reminder tool.
3. If intent is LIST/QUERY reminders:
   - Call query_tasks with { "state": "CREATED" } — this fetches ALL pending/upcoming tasks with their titles and due times.
   - Also call query_reminders with {} — this fetches actively escalating reminders.
   - IMPORTANT: Do NOT filter by date when calling query_tasks. Just use { "state": "CREATED" }.
   - Report the title and expiresAt for each task found. If expiresAt is in the past, note it has expired.
4. Do NOT make up data. If a tool returns [] or empty, say there are no items of that type.
      `;

      const response = await agent.chat({
        message: query,
      });

      const summaryReport = response.toString();

      RuntimeEventBus.log('AGENT_COMPLETED', 'AI',
        `SystemOpsAgent SUCCESS | ${Date.now() - start}ms | intent: ${context.intent}`,
        context.traceId
      );

      return {
        status: 'SUCCESS',
        data: {},
        summaryReport,
        mutationsCount: 1, // Assume potential mutation
        latencyMs: Date.now() - start,
      };

    } catch (err: any) {
      RuntimeEventBus.log('AGENT_FAILED', 'ERROR',
        `SystemOpsAgent failed: ${err.message}`,
        context.traceId
      );
      return {
        status: 'FAILED',
        data: {},
        summaryReport: `System operations query failed: ${err.message}`,
        mutationsCount: 0,
        latencyMs: Date.now() - start,
        errorCode: 'AGENT_EXECUTION_ERROR',
      };
    }
  }
}
