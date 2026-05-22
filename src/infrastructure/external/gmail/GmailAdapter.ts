import { ToolExecutionGateway } from '../gateway/ToolExecutionGateway.js';
import { CircuitBreaker } from '../../resiliency/CircuitBreaker.js';

export interface GmailDraft {
  to: string;
  subject: string;
  body: string;
  approvalMetadata: {
    requiresApproval: boolean;
    requestedBy: string;
  };
}

export class GmailAdapter extends ToolExecutionGateway {
  constructor(circuitBreaker: CircuitBreaker) {
    super(circuitBreaker);
  }

  // READ ONLY — safe for replay
  async summarizeInbox(isSandbox: boolean): Promise<string[]> {
    return this.execute(
      {
        operationName: 'Gmail.SummarizeInbox',
        isReplay: false,
        isSandbox,
        replaySafe: true,
        idempotencyKey: `gmail-summarize-${Date.now()}`,
        requiredScopes: ['READ_GMAIL']
      },
      async () => {
        console.log('[GMAIL] Reading inbox...');
        return ['[Real email summary from Gmail API]'];
      },
      async () => ['[SANDBOX] Simulated email summary']
    );
  }

  // CREATE DRAFT — requires approval metadata, NEVER auto-sends
  async createDraft(draft: GmailDraft, isReplay: boolean, isSandbox: boolean): Promise<void> {
    await this.execute(
      {
        operationName: 'Gmail.CreateDraft',
        isReplay,
        isSandbox,
        replaySafe: false, // Never auto-create drafts during replay
        idempotencyKey: `gmail-draft-${draft.to}-${draft.subject}`,
        requiredScopes: ['WRITE_GMAIL_DRAFT']
      },
      async () => {
        console.log(`[GMAIL] Created draft to ${draft.to}: ${draft.subject}`);
        // Gmail API call here. send() is deliberately ABSENT.
      },
      async () => {
        console.log(`[GMAIL SANDBOX] Simulated draft to ${draft.to}`);
      }
    );
  }

  // NOTE: sendEmail() is INTENTIONALLY ABSENT. Autonomous sending is forbidden.
}
