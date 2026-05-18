import { AIProposalRuntime } from '../ai/runtime/AIProposalRuntime.js';
import { ConversationSessionRepository } from '../../domain/conversation/ConversationSession.js';
import { MessageRenderer } from './MessageRenderer.js';
import { WhatsAppAdapter, WhatsAppMessage } from '../../infrastructure/external/whatsapp/WhatsAppAdapter.js';
import { ICommandExecutor } from '../executor/IExecutor.js';
import { ProposalType } from '../commands/CommandStandard.js';
import { RuntimeEventBus } from '../../console/RuntimeEventBus.js';
import { randomUUID } from 'crypto';

export class InboundMessagePipeline {
  constructor(
    private aiRuntime: AIProposalRuntime,
    private sessionRepo: ConversationSessionRepository,
    private renderer: MessageRenderer,
    private whatsapp: WhatsAppAdapter,
    private commandExecutor: ICommandExecutor<any, any> // Generalized for this phase
  ) {}

  public async process(
    userId: string,
    messageText: string,
    messageId: string,
    traceId: string
  ): Promise<void> {
    const session = await this.sessionRepo.getSession(userId);

    let queryToProcess = messageText;

    // Resolve Clarification State
    if (session.isWaitingForClarification()) {
      // Append original query to the user's reply so the AI has full context of the correction
      queryToProcess = `Original Request: "${session.activeClarification!.originalQuery}"\nUser Clarification: "${messageText}"`;
      session.clearClarification();
    }

    try {
      // Execute AI Cognition
      // In a real system, we fetch user memories from MemoryAggregate. Empty for now.
      const proposal = await this.aiRuntime.generateProposal(
        queryToProcess,
        [], 
        'PLANNING', // Mode
        traceId,
        []
      );

      // Route Proposal
      switch (proposal.proposalType) {
        case ProposalType.CLARIFICATION_REQUEST:
          RuntimeEventBus.log('CLARIFICATION_SENT', 'AI',
            `Clarification sent to ${userId}: "${(proposal as any).clarificationPrompt.substring(0, 60)}"`, traceId);
          session.setClarification({
            originalQuery: queryToProcess,
            clarificationPrompt: (proposal as any).clarificationPrompt,
            missingInformation: (proposal as any).missingInformation,
            expiresAt: new Date(Date.now() + 15 * 60 * 1000) // 15 min
          });
          
          await this.sendReply(
            userId,
            this.renderer.renderClarification((proposal as any).clarificationPrompt, (proposal as any).missingInformation),
            messageId
          );
          break;

        case ProposalType.INFORMATION_RESPONSE:
          await this.sendReply(
            userId,
            this.renderer.renderInformation((proposal as any).responseText),
            messageId
          );
          break;

        case ProposalType.COMMAND_PROPOSAL:
          // In a real system, we dispatch this strictly typed via CommandExecutor
          // For now, we simulate execution and render confirmation
          console.log(`[ORCHESTRATION] Dispatching command: ${(proposal as any).actionIntent}`);
          await this.sendReply(
            userId,
            this.renderer.renderConfirmation({
              commandId: randomUUID(),
              commandDeduplicationKey: messageId,
              actionType: (proposal as any).actionIntent,
              payload: (proposal as any).rawPayload,
              validatedAt: new Date(),
              traceId,
              correlationId: randomUUID(),
              expiresAt: new Date(),
              isDryRun: false
            }),
            messageId
          );
          break;

        default:
          console.warn(`[PIPELINE] Unhandled proposal type: ${proposal.proposalType}`);
      }
    } catch (error: any) {
      console.error(`[PIPELINE] Async execution failure: ${error.message}`);
      await this.sendReply(
        userId,
        this.renderer.renderError('I encountered an internal error processing your request.'),
        messageId
      );
    } finally {
      await this.sessionRepo.saveSession(session);
    }
  }

  private async sendReply(to: string, body: string, idempotencyKey: string): Promise<void> {
    const msg: WhatsAppMessage = { to, body, idempotencyKey: `reply-${idempotencyKey}` };
    await this.whatsapp.sendMessage(msg, false, false);
  }
}
