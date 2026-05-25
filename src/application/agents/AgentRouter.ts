import { IAgent, AgentContext, AgentExecutionResult } from '../../agents/base/IAgent.js';
import { CalendarAgent } from '../../agents/calendar/CalendarAgent.js';
import { SystemOpsAgent } from '../../agents/system/SystemOpsAgent.js';
import { DocsAgent } from '../../agents/docs/DocsAgent.js';
import { RuntimeEventBus } from '../../console/RuntimeEventBus.js';
import { OpenAI, OpenAIAgent } from '@llamaindex/openai';
import { FunctionTool } from 'llamaindex';
import * as dotenv from 'dotenv';
dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
// AgentRouter — LLM-Powered Supervisor Dispatcher.
//
// GOVERNANCE RULES:
//  - Routing is dynamically evaluated by an LLM (LlamaIndex).
//  - The LLM will choose which sub-agent tool to invoke based on intent and payload.
//  - Sub-agents are exposed as tools to the router.
// ─────────────────────────────────────────────────────────────────────────────

export type RouterResult =
  | { routed: true; result: AgentExecutionResult }
  | { routed: false; reason: string };

export class AgentRouter {
  constructor(
    private calendarAgent: CalendarAgent,
    private systemOpsAgent: SystemOpsAgent,
    private docsAgent: DocsAgent
  ) {}

  public canRoute(intent: string): boolean {
    // LLM Router will attempt to route EVERYTHING!
    return true;
  }

  public async route(intent: string, context: AgentContext): Promise<RouterResult> {
    const normalizedIntent = intent.toLowerCase();
    
    RuntimeEventBus.log('AGENT_ROUTER', 'SYSTEM',
      `LLM Router evaluating intent: "${normalizedIntent}"`,
      context.traceId
    );

    let subAgentResult: AgentExecutionResult | null = null;
    let routedTo: string | null = null;

    const calendarTool = FunctionTool.from(
      async () => {
        RuntimeEventBus.log('AGENT_ROUTER', 'SYSTEM', `LLM Chose CalendarAgent`, context.traceId);
        routedTo = 'CalendarAgent';
        subAgentResult = await this.calendarAgent.execute({ ...context, intent: normalizedIntent });
        return `Successfully routed to CalendarAgent. Summary: ${subAgentResult.summaryReport}`;
      },
      {
        name: 'route_to_calendar',
        description: 'Route the request to the CalendarAgent. Use this for ANY calendar, scheduling, or event related tasks.',
        parameters: { type: 'object', properties: {} }
      }
    );

    const systemOpsTool = FunctionTool.from(
      async () => {
        RuntimeEventBus.log('AGENT_ROUTER', 'SYSTEM', `LLM Chose SystemOpsAgent`, context.traceId);
        routedTo = 'SystemOpsAgent';
        subAgentResult = await this.systemOpsAgent.execute({ ...context, intent: normalizedIntent });
        return `Successfully routed to SystemOpsAgent. Summary: ${subAgentResult.summaryReport}`;
      },
      {
        name: 'route_to_system_ops',
        description: 'Route the request to the SystemOpsAgent. Use this for: reminders, tasks, timers, sagas, internal system queries, completing/cancelling a reminder, snoozing a reminder, user saying "started" or "I started" or "snooze X minutes" or "do it after X minutes".',
        parameters: { type: 'object', properties: {} }
      }
    );

    const docsTool = FunctionTool.from(
      async (payload: any) => {
        RuntimeEventBus.log('AGENT_ROUTER', 'SYSTEM', `LLM Chose DocsAgent`, context.traceId);
        routedTo = 'DocsAgent';
        subAgentResult = await this.docsAgent.execute({ ...context, intent: normalizedIntent, payload });
        return `Successfully routed to DocsAgent. Summary: ${subAgentResult.summaryReport}`;
      },
      {
        name: 'route_to_docs',
        description: 'Route the request to the DocsAgent. Use this for retrieving or storing personal documents (e.g. Aadhar, PAN, Passport, Voter ID) from the secure vault. For RETRIEVE, pass the query or "all". For STORE, pass the name and the {{MASKED_URL}} placeholder.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['RETRIEVE', 'STORE'] },
            query: { type: 'string', description: 'The search query for retrieval, or "all" to list all.' },
            name: { type: 'string', description: 'The name of the document to store.' },
            urlPlaceholder: { type: 'string', description: 'The {{MASKED_URL_x}} placeholder to store.' }
          },
          required: ['action']
        }
      }
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

      const agent = new OpenAIAgent({
        tools: [calendarTool, systemOpsTool, docsTool],
        llm,
        verbose: true,
      });

      const query = `
You are the Master Supervisor Router for Karen.
Your ONLY job is to select the correct sub-agent tool to fulfill the user's intent.

Intent: ${normalizedIntent}
Payload: ${JSON.stringify(context.payload)}

If the intent involves standard reminders, tasks, timers, or system state, call route_to_system_ops.
If the intent involves calendar events or scheduling external meetings, call route_to_calendar.
If the intent involves retrieving or saving personal/secure documents to the vault, call route_to_docs.

Call the appropriate tool now. DO NOT generate an answer without calling a tool.
      `;

      await agent.chat({ message: query });

      if (subAgentResult && routedTo) {
        return { routed: true, result: subAgentResult };
      }

      RuntimeEventBus.log('AGENT_ROUTER', 'SYSTEM',
        `LLM Router failed to pick an agent tool for intent: ${normalizedIntent}`,
        context.traceId
      );
      
      return { routed: false, reason: `LLM Router declined to route intent: ${normalizedIntent}` };
    } catch (err: any) {
      RuntimeEventBus.log('AGENT_ROUTER', 'ERROR',
        `LLM Router crashed: ${err.message}`,
        context.traceId
      );
      return { routed: false, reason: `LLM Router Error: ${err.message}` };
    }
  }
}
