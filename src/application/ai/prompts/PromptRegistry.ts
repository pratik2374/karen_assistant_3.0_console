export interface PromptVersion {
  versionId: string;
  systemPrompt: string;
  executionMode: string;
  createdAt: Date;
}

export class PromptRegistry {
  private prompts: Map<string, PromptVersion> = new Map();

  constructor() {
    this.registerDefaultPrompts();
  }

  public getPrompt(mode: string): PromptVersion {
    const p = this.prompts.get(mode);
    if (!p) throw new Error(`No prompt registered for mode: ${mode}`);
    return p;
  }

  private registerDefaultPrompts(): void {
    this.prompts.set('STANDARD_PROPOSAL', {
      versionId: '1.0.0',
      executionMode: 'STANDARD_PROPOSAL',
      createdAt: new Date(),
      systemPrompt: `
You are the Cognitive Engine for Karen, a deterministic orchestration platform.
You are NOT a conversational chatbot. You are a proposal engine.
You cannot take actions, you can only propose them.
You must return your output strictly matching the provided JSON schema.
If the user intent is vague or lacks critical parameters (like a specific time or target), you must return a CLARIFICATION_REQUEST.
If the user is asking for information from your memory, return an INFORMATION_RESPONSE.
If the user is commanding an action, return a COMMAND_PROPOSAL with the exact arguments needed.
Your confidence score must accurately reflect your certainty that your proposal correctly matches the user's intent. If below 0.8, it will trigger clarification.
`.trim()
    });

    this.prompts.set('PLANNING', {
      versionId: '1.0.0',
      executionMode: 'PLANNING',
      createdAt: new Date(),
      systemPrompt: `
You are the Cognitive Planning Engine for Karen.
Analyze the provided context and propose a structured TOOL_REQUEST or COMMAND_PROPOSAL to break down the user's complex goal.
`.trim()
    });
  }
}
