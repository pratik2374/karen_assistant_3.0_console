// @ts-nocheck
import { ISubAgent, IAgentGoal, IAgentResult } from './AgentContracts.js';
import { ReminderSubAgent } from './ReminderSubAgent.js';
import { IOpenAIAdapter } from '../../ports/IOpenAIAdapter.js';
import { ConversationSessionRepository } from '../../../domain/conversation/ConversationSession.js';
import { RuntimeEventBus } from '../../../console/RuntimeEventBus.js';

export class MainKarenOrchestrator {
  public name = 'MainKarenOrchestrator';
  public model = 'gpt-5';

  constructor(
    private openai: IOpenAIAdapter,
    private reminderAgent: ReminderSubAgent,
    private sessionRepo: ConversationSessionRepository,
    private persistence: any
  ) {}

  public async orchestrate(
    userId: string,
    messageText: string,
    messageId: string,
    traceId: string
  ): Promise<{ responseText: string; shouldExecuteDirectly: boolean }> {
    const session = await this.sessionRepo.getSession(userId);
    const cleanedInput = messageText.trim().toLowerCase();

    // 1. Check if the session is waiting for high-risk Goal Approval
    if (session.isWaitingForGoalApproval()) {
      const pendingApproval = session.pendingGoal!;
      const goal = pendingApproval.goal as IAgentGoal;

      const isAffirmative = [
        'yes', 'y', 'go ahead', 'approve', 'do it', 'sure', 'ok', 'okay', 'proceed', 'yeah', 'yep', 'yess'
      ].some(word => cleanedInput.includes(word));

      const isNegative = [
        'no', 'n', 'cancel', 'stop', 'never mind', 'dont', "don't", 'abort', 'reject'
      ].some(word => cleanedInput.includes(word));

      if (isAffirmative) {
        // Clear pending goal first
        session.clearPendingGoal();
        await this.sessionRepo.saveSession(session);

        RuntimeEventBus.log('ORCHESTRATION_DISPATCH', 'INFO',
          `User approved goal: "${goal.description}". Executing sub-agent...`,
          traceId
        );

        // Execute sub-agent action transactionally
        const result = await this.reminderAgent.execute(goal, this.persistence, traceId, messageId);

        if (result.status === 'SUCCESS') {
          return {
            responseText: `🎙️ *Karen* | _Action Executed_\n\n"I've got you! Initiating the cancellation sequence for those active items now."\n\n👉 *${result.summaryReport}*`,
            shouldExecuteDirectly: false
          };
        } else {
          return {
            responseText: `🎙️ *Karen* | _Execution Failure_\n\n"Oops! I ran into a bit of trouble trying to process the request: ${result.summaryReport}"`,
            shouldExecuteDirectly: false
          };
        }
      } else if (isNegative) {
        session.clearPendingGoal();
        await this.sessionRepo.saveSession(session);

        RuntimeEventBus.log('ORCHESTRATION_DISPATCH', 'INFO',
          `User rejected goal: "${goal.description}". Aborting...`,
          traceId
        );

        return {
          responseText: `🎙️ *Karen* | _Action Cancelled_\n\n"No problem! I've stopped the pending request. Your scheduled items are perfectly safe. Ready when you are!"`,
          shouldExecuteDirectly: false
        };
      } else {
        // Did not explicitly say Yes/No, remind them of the pending approval prompt
        return {
          responseText: `🎙️ *Karen* | _Awaiting Approval_\n\n"Hey, I still need a clear thumbs-up from you before I wipe those items. Reply with *Yes* to confirm or *No* to cancel."`,
          shouldExecuteDirectly: false
        };
      }
    }

    // 2. Fresh query: Classify if the intent is bulk/selective cancellation
    const isCancelRequest = [
      'cancel', 'remove', 'delete', 'stop', 'dismiss', 'complete', 'clear', 'wipe'
    ].some(word => cleanedInput.includes(word));

    if (isCancelRequest && this.persistence) {
      try {
        // Query active, incomplete reminders
        const activeReminders = await this.persistence.db.collection('saga_states')
          .find({
            'payloadData.userId': userId,
            currentState: { $nin: ['COMPLETED', 'CANCELLED', 'FAILED'] }
          })
          .toArray();

        if (activeReminders.length > 0) {
          // Invite Reminder Worker Sub-Agent to establish a Goal!
          const goal = await this.reminderAgent.establishGoal(messageText, activeReminders);

          if (goal.intent === 'cancel_reminder' && goal.targetTaskIds.length > 0) {
            // Risk level is HIGH (e.g. canceling multiple reminders or all of them)
            if (goal.riskLevel === 'HIGH') {
              // Cache/save the Goal in Session
              session.setPendingGoal(goal);
              await this.sessionRepo.saveSession(session);

              RuntimeEventBus.log('ORCHESTRATION_DISPATCH', 'INFO',
                `Sub-agent established high-risk goal. Waiting for user approval loop...`,
                traceId
              );

              // Compile user-friendly WhatsApp confirmation prompt with target details
              const listLines = goal.targetTaskIds.map((id, idx) => {
                const r = activeReminders.find(x => x.payloadData.taskId === id);
                const title = r?.payloadData?.taskTitle || 'Reminder';
                return `  • *${title}* (ID: \`${id.substring(0, 8)}\`)`;
              }).join('\n');

              const responseText = `🎙️ *Karen* | _Goal Verification_\n\n"Hey! Just checking—did you want me to clear these scheduled reminders for you?\n_${goal.description}_\n\nHere are the active items I'll be removing:\n${listLines}\n\nShall I go ahead and wipe them? (*Yes/No*)"`;
              
              return { responseText, shouldExecuteDirectly: false };
            } else {
              // LOW risk level (canceling only 1 specific reminder) -> Execute immediately!
              RuntimeEventBus.log('ORCHESTRATION_DISPATCH', 'INFO',
                `Sub-agent established low-risk goal. Executing directly without confirmation loop.`,
                traceId
              );
              
              const result = await this.reminderAgent.execute(goal, this.persistence, traceId, messageId);
              return {
                responseText: `🎙️ *Karen* | _Task Cancelled_\n\n"Direct execution completed successfully!"\n\n👉 *${result.summaryReport}*`,
                shouldExecuteDirectly: false
              };
            }
          }
        }
      } catch (err) {
        console.error('[MainKarenOrchestrator] Error checking active reminders for classification:', err);
      }
    }

    // Default: Fallback to the standard, one-shot scheduler pipeline
    return {
      responseText: '',
      shouldExecuteDirectly: true
    };
  }
}
