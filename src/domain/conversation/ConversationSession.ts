export interface ClarificationState {
  originalQuery: string;
  clarificationPrompt: string;
  missingInformation: string[];
  expiresAt: Date;
}

export interface PendingGoalApproval {
  goal: any; // Type-erased IAgentGoal to prevent circular imports
  expiresAt: Date;
}

export class ConversationSession {
  public pendingGoal: PendingGoalApproval | null = null;

  constructor(
    public readonly userId: string,
    public activeClarification: ClarificationState | null = null,
    public lastInteractionAt: Date = new Date(),
    public activeWorkflowId: string | null = null
  ) {}

  public isWaitingForClarification(): boolean {
    if (!this.activeClarification) return false;
    if (new Date() > this.activeClarification.expiresAt) {
      this.activeClarification = null; // Expired
      return false;
    }
    return true;
  }

  public setClarification(state: ClarificationState): void {
    this.activeClarification = state;
    this.lastInteractionAt = new Date();
  }

  public clearClarification(): void {
    this.activeClarification = null;
    this.lastInteractionAt = new Date();
  }

  public isWaitingForGoalApproval(): boolean {
    if (!this.pendingGoal) return false;
    if (new Date() > this.pendingGoal.expiresAt) {
      this.pendingGoal = null; // Expired
      return false;
    }
    return true;
  }

  public setPendingGoal(goal: any): void {
    const expiresAt = new Date(Date.now() + 5 * 60000); // 5 minutes expiration
    this.pendingGoal = { goal, expiresAt };
    this.lastInteractionAt = new Date();
  }

  public clearPendingGoal(): void {
    this.pendingGoal = null;
    this.lastInteractionAt = new Date();
  }
}

// Simple in-memory session store for MVP. Should be Redis in production.
export class ConversationSessionRepository {
  private sessions: Map<string, ConversationSession> = new Map();

  public async getSession(userId: string): Promise<ConversationSession> {
    if (!this.sessions.has(userId)) {
      this.sessions.set(userId, new ConversationSession(userId));
    }
    return this.sessions.get(userId)!;
  }

  public async saveSession(session: ConversationSession): Promise<void> {
    this.sessions.set(session.userId, session);
  }
}
