// @ts-nocheck
import { IAgent, AgentContext, AgentExecutionResult } from '../base/IAgent.js';
import { CalendarTool } from '../../tools/calendar/CalendarTool.js';
import { CalendarProjectionMongoRepository } from '../../infrastructure/persistence/mongo/repositories/CalendarProjectionMongoRepository.js';
import { RuntimeEventBus } from '../../console/RuntimeEventBus.js';
import { OpenAI, OpenAIAgent } from '@llamaindex/openai';
import * as dotenv from 'dotenv';
dotenv.config();

export class CalendarAgent implements IAgent {
  readonly name = 'CalendarAgent';
  readonly domain = 'calendar';
  readonly capabilities = [
    'list_tasks',
    'query_calendar',
    'create_calendar_event',
    'update_calendar_event',
    'delete_calendar_event',
    'find_calendar_event',
  ];

  constructor(
    private calendarTool: CalendarTool,
    private projectionRepo: CalendarProjectionMongoRepository
  ) {}

  async execute(context: AgentContext): Promise<AgentExecutionResult> {
    const start = Date.now();

    RuntimeEventBus.log('AGENT_STARTED', 'AI',
      `CalendarAgent executing intent via LlamaIndex: ${context.intent}`,
      context.traceId
    );

    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY is missing from environment variables');
      }

      // 1. Initialize OpenAI LLM
      const llm = new OpenAI({
        apiKey,
        model: 'gpt-5.4-mini',
        temperature: 0,
      });

      // 2. Fetch LlamaIndex tools directly from Composio
      const tools = await this.calendarTool.composio.getCalendarTools();

      // 3. Initialize LlamaIndex Agent
      const agent = new OpenAIAgent({
        tools: tools as any,
        llm,
        verbose: true,
      });

      // 4. Build a robust query for the agent using the extracted payload and intent
      const userQuery = context.payload.userQuery || context.payload.query || '';
      const now = new Date();
      const localTimeKolkata = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
      const localDateKolkataStr = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).toDateString();
      
      const query = `
You are a specialized Calendar Assistant. Your task is to fulfill the following intent using the tools provided.
Intent: ${context.intent}
Parameters Extracted by User: ${JSON.stringify(context.payload)}
Original User Query: "${userQuery}"

SYSTEM TIME CONTEXT:
- Current UTC Time: ${now.toISOString()}
- User Timezone: Asia/Kolkata
- Current User Local Time (IST): ${localTimeKolkata}
- Today's Date (in User Timezone): ${localDateKolkataStr}

When creating or modifying events, you MUST strictly use the User Timezone (Asia/Kolkata).
If the user specifies a relative time like "after 20 minutes" or "tomorrow at 9 AM", calculate it relative to the Current User Local Time (IST) listed above: ${localTimeKolkata}.
For example, if it is 6:29 PM IST, "after 20 minutes" is 6:49 PM IST on the same day.
Ensure you pass the local ISO 8601 datetime strings to the tool WITHOUT any timezone offset or Z suffix (e.g., YYYY-MM-DDTHH:mm:ss, like '2026-05-21T18:49:17'), and ALWAYS explicitly set the timezone parameter to 'Asia/Kolkata'. Do NOT include '+05:30' or 'Z' in the start_datetime or end_datetime strings.

Please execute the necessary calendar operations. Use the provided tools to query or mutate Google Calendar.
Return a concise, human-readable summary of the actions taken and the data retrieved.
Do not invent or hallucinate events. 
      `;

      // 5. Execute LlamaIndex Agent
      const response = await agent.chat({
        message: query,
      });

      const summaryReport = response.toString();

      // NOTE: Because the LlamaIndex agent executes tools directly via Composio, 
      // we must trigger a background sync to reconcile Karen's shadow projections.
      // In a fully production system, the ToolExecutionGateway would ideally wrap these LlamaIndex tools.
      
      RuntimeEventBus.log('AGENT_COMPLETED', 'AI',
        `CalendarAgent SUCCESS | ${Date.now() - start}ms | intent: ${context.intent}`,
        context.traceId
      );

      // Emit a calendar mutation completed event to trigger immediate background sync/reconciliation
      const mutatingIntents = ['create_calendar_event', 'update_calendar_event', 'delete_calendar_event'];
      if (mutatingIntents.includes(context.intent)) {
        RuntimeEventBus.emit({
          type: 'CALENDAR_MUTATION_COMPLETED',
          category: 'SYSTEM',
          message: `Calendar mutation intent "${context.intent}" completed successfully.`,
          traceId: context.traceId,
          timestamp: new Date()
        });

        if (context.intent === 'create_calendar_event') {
          RuntimeEventBus.emit({
            type: 'CALENDAR_EVENT_CREATED_MANUALLY',
            category: 'DOMAIN',
            message: `Fast-tracking reminder for manual calendar creation`,
            traceId: context.traceId,
            timestamp: new Date(),
            metadata: {
              title: context.payload.title,
              start: context.payload.start,
              end: context.payload.end,
              userId: context.userId
            }
          });
        }
      }

      return {
        status: 'SUCCESS',
        data: {},
        summaryReport,
        mutationsCount: 1, 
        latencyMs: Date.now() - start,
      };

    } catch (err: any) {
      RuntimeEventBus.log('AGENT_FAILED', 'ERROR',
        `CalendarAgent failed: ${err.message}`,
        context.traceId
      );
      const safeErrorMessage = err.message.length > 1000 ? err.message.substring(0, 1000) + '... [truncated]' : err.message;
      return {
        status: 'FAILED',
        data: {},
        summaryReport: `Calendar operation failed: ${safeErrorMessage}`,
        mutationsCount: 0,
        latencyMs: Date.now() - start,
        errorCode: 'AGENT_EXECUTION_ERROR',
      };
    }
  }
}
