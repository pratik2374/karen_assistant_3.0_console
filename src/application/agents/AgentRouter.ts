import { IAgent, AgentContext, AgentExecutionResult } from '../../agents/base/IAgent.js';
import { CalendarAgent } from '../../agents/calendar/CalendarAgent.js';
import { SystemOpsAgent } from '../../agents/system/SystemOpsAgent.js';
import { DocsAgent } from '../../agents/docs/DocsAgent.js';
import { ListAgent } from '../../agents/list/ListAgent.js';
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
    private docsAgent: DocsAgent,
    private listAgent: ListAgent
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
        const rawUserQuery = context.payload?.userQuery || context.payload?.query || "";
        const mergedPayload = { ...context.payload, ...payload, userQuery: rawUserQuery };
        subAgentResult = await this.docsAgent.execute({ ...context, intent: normalizedIntent, payload: mergedPayload });
        return `Successfully routed to DocsAgent. Summary: ${subAgentResult.summaryReport}`;
      },
      {
        name: 'route_to_docs',
        description: 'Route the request to the DocsAgent. Use this for retrieving or storing personal documents (e.g. Aadhar, PAN, Passport, Voter ID) from the secure vault, or for image background removal.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['RETRIEVE', 'STORE', 'REMOVE_BACKGROUND'] },
            query: { type: 'string', description: 'The search query for retrieval, or "all" to list all.' },
            name: { type: 'string', description: 'The name of the document to store.' },
            urlPlaceholder: { type: 'string', description: 'The {{MASKED_URL_x}} placeholder representing the URL or image to store/process.' }
          },
          required: ['action']
        }
      }
    );

    const directChatTool = FunctionTool.from(
      async () => {
        RuntimeEventBus.log('AGENT_ROUTER', 'SYSTEM', `LLM Chose DirectChat`, context.traceId);
        routedTo = 'DirectChat';
        subAgentResult = {
          status: 'SUCCESS',
          summaryReport: 'DELEGATE_TO_DIRECT_CHAT',
          data: {},
          mutationsCount: 0,
          latencyMs: 0
        };
        return `Successfully routed to Direct Chat for personality chitchat.`;
      },
      {
        name: 'route_to_direct_chat',
        description: 'Route the request to direct chitchat/conversation. Use this for greetings, questions, personal conversations, standard chitchat, or when the user is simply talking or asking things that do not require specialized calendar, docs, or reminder tasks.',
        parameters: { type: 'object', properties: {} }
      }
    );

    const listsTool = FunctionTool.from(
      async (payload: any) => {
        RuntimeEventBus.log('AGENT_ROUTER', 'SYSTEM', `LLM Chose ListAgent`, context.traceId);
        routedTo = 'ListAgent';
        const rawUserQuery = context.payload?.userQuery || context.payload?.query || "";
        const mergedPayload = { ...context.payload, ...payload, userQuery: rawUserQuery };
        subAgentResult = await this.listAgent.execute({ ...context, intent: normalizedIntent, payload: mergedPayload });
        return `Successfully routed to ListAgent. Summary: ${subAgentResult.summaryReport}`;
      },
      {
        name: 'route_to_lists',
        description: 'Route the request to the ListAgent. Use this for ANY grocery lists, movie bucket lists, or coding link buckets. Actions include adding items, querying lists, tagging coding links, and checking off grocery purchases.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['ADD', 'QUERY', 'COMPLETE'] },
            listType: { type: 'string', enum: ['grocery', 'coding_bucket', 'movie_bucket'] }
          },
          required: ['action', 'listType']
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
        tools: [calendarTool, systemOpsTool, docsTool, directChatTool, listsTool],
        llm,
        verbose: true,
      });

      const conversationContext = context.payload?.conversationContext || "";

      const query = `
You are the Master Supervisor Router for Karen.
Your ONLY job is to select the correct sub-agent tool to fulfill the user's intent.

Recent Conversation & Memory Context:
${conversationContext || "_No context._"}

PRONOUN RESOLUTION RULES:
- Read the Conversation Context carefully to resolve ambiguous terms. E.g., if the user says "link of it" or "link?" or "show it" right after a document was stored/uploaded, "it" refers to that document. In that case, choose route_to_docs!
- E.g., if the user says "snooze it" or "start it" after a reminder was discussed, "it" refers to the reminder. Choose route_to_system_ops!
- E.g., if the user says "delete that meeting" or "when is it?" after scheduling/discussing a calendar event, Choose route_to_calendar!

ROUTING CRITERIA:
- If the intent is chitchat, greetings, general questions, talking about personal details, or standard conversation, call route_to_direct_chat.
- If the intent involves standard reminders, tasks, timers, or system state, call route_to_system_ops.
- If the intent involves calendar events or scheduling external meetings, call route_to_calendar.
- If the intent involves retrieving or saving personal/secure documents to the vault, or removing image backgrounds, call route_to_docs.
- If the intent involves grocery lists, coding link buckets, or movie bucket lists (adding items, searching/viewing lists, completing/deleting items), call route_to_lists.

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
