import { AIProposalRuntime } from '../../src/application/ai/runtime/AIProposalRuntime';
import { ClarificationEngine } from '../../src/application/ai/runtime/ClarificationEngine';
import { PromptRegistry } from '../../src/application/ai/prompts/PromptRegistry';
import { SchemaRegistry } from '../../src/application/ai/schemas/SchemaRegistry';
import { ContextEngine } from '../../src/application/ai/ContextEngine';
import { TokenBudgetManager } from '../../src/application/ai/governance/TokenBudgetManager';
import { HeuristicFallbackEstimator } from '../../src/infrastructure/ai/governance/HeuristicFallbackEstimator';
import { DeterministicContextSanitizer } from '../../src/infrastructure/ai/security/ContextSanitizer';
import { ContextObservabilityHook } from '../../src/infrastructure/observability/metrics/ContextObservabilityHook';
import { AIObservabilityHook } from '../../src/infrastructure/observability/metrics/AIObservabilityHook';
import { IOpenAIAdapter, OpenAICompletionRequest } from '../../src/application/ports/IOpenAIAdapter';
import { ProposalType } from '../../src/application/commands/CommandStandard';

class MockOpenAIAdapter implements IOpenAIAdapter {
  public nextResponse: any = {};
  public nextError: Error | null = null;

  async generateStructuredOutput(request: OpenAICompletionRequest): Promise<any> {
    if (this.nextError) throw this.nextError;
    return this.nextResponse;
  }
}

describe('AI Proposal Runtime Simulation', () => {
  let runtime: AIProposalRuntime;
  let mockAdapter: MockOpenAIAdapter;

  beforeEach(() => {
    mockAdapter = new MockOpenAIAdapter();
    const estimator = new HeuristicFallbackEstimator();
    const budgetManager = new TokenBudgetManager(estimator);
    const sanitizer = new DeterministicContextSanitizer();
    const ctxHook = new ContextObservabilityHook();
    const contextEngine = new ContextEngine(budgetManager, sanitizer, ctxHook);
    
    const promptRegistry = new PromptRegistry();
    const schemaRegistry = new SchemaRegistry();
    const clarificationEngine = new ClarificationEngine();
    const aiHook = new AIObservabilityHook();

    runtime = new AIProposalRuntime(
      contextEngine,
      promptRegistry,
      schemaRegistry,
      mockAdapter,
      clarificationEngine,
      aiHook
    );
  });

  it('routes low confidence proposals to clarification deterministically', async () => {
    // Mock OpenAI returning a COMMAND_PROPOSAL but with 0.4 confidence
    mockAdapter.nextResponse = {
      proposalType: ProposalType.COMMAND_PROPOSAL,
      confidence: 0.4,
      reasoning: 'I am guessing this is what they want.',
      actionIntent: 'SOME_ACTION',
      rawPayload: {}
    };

    const result = await runtime.generateProposal('do something', [], 'FAST', 'trace-1', []);

    expect(result.proposalType).toBe(ProposalType.CLARIFICATION_REQUEST);
    if (result.proposalType === ProposalType.CLARIFICATION_REQUEST) {
      expect(result.clarificationPrompt).toContain('clarify your intent');
    }
  });

  it('accepts high confidence proposals', async () => {
    mockAdapter.nextResponse = {
      proposalType: ProposalType.COMMAND_PROPOSAL,
      confidence: 0.95,
      reasoning: 'User explicitly asked.',
      actionIntent: 'SOME_ACTION',
      rawPayload: {}
    };

    const result = await runtime.generateProposal('do something', [], 'FAST', 'trace-2', []);

    expect(result.proposalType).toBe(ProposalType.COMMAND_PROPOSAL);
    expect(result.confidence).toBe(0.95);
  });

  it('handles schema validation errors by requesting clarification', async () => {
    // Missing required field 'actionIntent' for a COMMAND_PROPOSAL
    mockAdapter.nextResponse = {
      proposalType: ProposalType.COMMAND_PROPOSAL,
      confidence: 0.95,
      reasoning: 'Missing fields',
      rawPayload: {}
    };

    const result = await runtime.generateProposal('do something', [], 'FAST', 'trace-3', []);

    // It should catch the ZodError and fallback to Clarification
    expect(result.proposalType).toBe(ProposalType.CLARIFICATION_REQUEST);
    if (result.proposalType === ProposalType.CLARIFICATION_REQUEST) {
      expect(result.clarificationPrompt).toContain('internal error formatting my response');
    }
  });

  it('handles OpenAI network errors by throwing', async () => {
    mockAdapter.nextError = new Error('OpenAI API Failure: 500 Server Error');

    await expect(runtime.generateProposal('test', [], 'FAST', 'trace-4', []))
      .rejects.toThrow('OpenAI API Failure: 500 Server Error');
  });
});
