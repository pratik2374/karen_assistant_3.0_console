import { ISubAgent, IAgentGoal, IAgentResult } from './AgentContracts.js';
import { IOpenAIAdapter } from '../../ports/IOpenAIAdapter.js';
import { ReminderAggregate } from '../../../domain/reminder/ReminderAggregate.js';
import { randomUUID } from 'crypto';
import { RuntimeEventBus } from '../../../console/RuntimeEventBus.js';

export class ReminderSubAgent implements ISubAgent {
  public name = 'ReminderSubAgent';
  public model = 'gpt-5.4-mini';

  constructor(private openai: IOpenAIAdapter) {}

  public async establishGoal(query: string, activeReminders: any[]): Promise<IAgentGoal> {
    const formattedReminders = activeReminders.map(r => 
      `- Title: "${r.payloadData?.taskTitle || 'Reminder'}" | State: ${r.currentState} | ID: ${r.payloadData?.taskId}`
    ).join('\n');

    const systemPrompt = `
You are the specialized Reminder Sub-Agent for Karen.
Your core configuration is:
- Model: gpt-5.4-mini
- Directives: Formulate a clear Goal to fulfill the user's request using the active reminders listed in the context.

You must return a structured JSON output representing the target goal:
- intent: must be "cancel_reminder" if the user wants to cancel/delete/complete a reminder, otherwise "unknown".
- targetCount: number of reminders that match the user request.
- description: a natural explanation of what tasks you are targeting (e.g. "Cancel 3 reminders for today").
- riskLevel: must be "HIGH" if targetCount > 1 or if cancelling ALL active reminders. Must be "LOW" if targetCount <= 1.
- targetTaskIds: an array containing the exact UUIDs of the matching tasks to cancel.

Active Reminders Context:
${formattedReminders || 'None active.'}
`.trim();

    const schemaConfig = {
      name: "establish_reminder_goal",
      strict: true,
      schema: {
        type: "object",
        properties: {
          intent: { type: "string", enum: ["cancel_reminder", "unknown"] },
          targetCount: { type: "number" },
          description: { type: "string" },
          riskLevel: { type: "string", enum: ["LOW", "HIGH"] },
          targetTaskIds: {
            type: "array",
            items: { type: "string" }
          }
        },
        required: ["intent", "targetCount", "description", "riskLevel", "targetTaskIds"],
        additionalProperties: false
      }
    };

    try {
      const result = await this.openai.generateStructuredOutput({
        systemPrompt: {
          versionId: '1.0.0',
          executionMode: 'REMINER_GOAL',
          createdAt: new Date(),
          systemPrompt
        },
        contextString: `Active Reminders Count: ${activeReminders.length}`,
        userQuery: query,
        schemaConfig,
        model: this.model,
        temperature: 0.0
      });

      return result as IAgentGoal;
    } catch (err: any) {
      console.error('[ReminderSubAgent] Failed to establish goal via LLM:', err);
      // Fallback deterministic parsing if LLM fails
      const isAll = query.toLowerCase().includes('all') || query.toLowerCase().includes('every');
      const targetIds = isAll 
        ? activeReminders.map(r => r.payloadData.taskId)
        : activeReminders.length > 0 ? [activeReminders[0].payloadData.taskId] : [];

      return {
        intent: 'cancel_reminder',
        targetCount: targetIds.length,
        description: `Cancel ${targetIds.length} reminders (Fallback Match)`,
        riskLevel: targetIds.length > 1 ? 'HIGH' : 'LOW',
        targetTaskIds: targetIds
      };
    }
  }

  public async execute(
    goal: IAgentGoal,
    persistence: any,
    traceId: string,
    correlationId: string
  ): Promise<IAgentResult> {
    if (goal.intent !== 'cancel_reminder' || goal.targetTaskIds.length === 0) {
      return {
        status: 'FAILED',
        summaryReport: 'No reminders were targeted for cancellation.',
        mutationsCount: 0
      };
    }

    let mutationsCount = 0;
    const cancelledTitles: string[] = [];

    // Execute all cancellations inside a robust Unit of Work transaction!
    const uow = persistence.buildUnitOfWork();
    await uow.start();

    try {
      for (const taskId of goal.targetTaskIds) {
        const reminderId = `reminder-${taskId}`;
        let reminder = await persistence.reminderRepository.findById(reminderId);
        let expectedVersion = 0;

        if (!reminder) {
          reminder = ReminderAggregate.initialize(reminderId, taskId, traceId, correlationId);
        } else {
          expectedVersion = reminder.version;
        }

        reminder.acknowledge(traceId, correlationId);
        await persistence.reminderRepository.saveWithVersion(reminder, expectedVersion);

        // Fetch task details for our report summary
        const saga = await persistence.db.collection('saga_states').findOne({ 'payloadData.taskId': taskId });
        const title = saga?.payloadData?.taskTitle || 'Reminder';
        cancelledTitles.push(title);

        // Outbox event routing
        const now = new Date();
        const outboxMessages = reminder.uncommittedEvents.map((event: any) => ({
          messageId: randomUUID(),
          eventType: event.eventType,
          payload: event,
          createdAt: now,
          processedAt: null,
          idempotencyKey: `${correlationId}:${event.eventType}:${reminder.version}`,
          deduplicationKey: `${reminderId}:${event.eventType}:${reminder.version}`,
          replaySafe: false,
          sideEffectFree: false,
          traceId,
          correlationId,
          causationId: correlationId
        }));

        await persistence.outboxStore.saveBulk(outboxMessages);
        mutationsCount++;
      }

      await uow.commit();

      const summaryList = cancelledTitles.map(t => `"${t}"`).join(', ');
      return {
        status: 'SUCCESS',
        summaryReport: `Successfully cancelled ${mutationsCount} active reminders: ${summaryList}.`,
        mutationsCount
      };
    } catch (err: any) {
      await uow.rollback();
      RuntimeEventBus.log('AGENT_EXECUTION_FAILED', 'ERROR',
        `ReminderSubAgent execution failed: ${err.message}`,
        traceId
      );
      return {
        status: 'FAILED',
        summaryReport: `Failed to cancel reminders due to database error: ${err.message}`,
        mutationsCount: 0
      };
    }
  }
}
