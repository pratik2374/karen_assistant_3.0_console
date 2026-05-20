import { ToolExecutionGateway } from '../../infrastructure/external/gateway/ToolExecutionGateway.js';
import { CircuitBreaker } from '../../infrastructure/resiliency/CircuitBreaker.js';
import { ComposioClient, CalendarEventInput, ComposioCalendarEvent } from '../../infrastructure/composio/ComposioClient.js';
import { CalendarProjectionMongoRepository } from '../../infrastructure/persistence/mongo/repositories/CalendarProjectionMongoRepository.js';
import { CalendarSyncState } from '../../domain/calendar/CalendarEventProjection.js';
import { RuntimeEventBus } from '../../console/RuntimeEventBus.js';
import { ToolInput, ToolResult } from '../base/ITool.js';
import { randomUUID } from 'crypto';

// ─────────────────────────────────────────────────────────────────────────────
// CalendarTool — The ONLY external calendar integration boundary.
//
// GOVERNANCE RULES:
//  - All calls pass through ToolExecutionGateway (circuit breaker + replay guard).
//  - Every mutation syncs the shadow projection AFTER successful API call.
//  - Sandbox mode returns mocked empty results, no API calls made.
//  - Composio is the ONLY external transport layer (no Google SDK direct access).
//  - Karen's shadow projection remains the canonical internal source of truth.
// ─────────────────────────────────────────────────────────────────────────────

export class CalendarTool extends ToolExecutionGateway {
  readonly name = 'CalendarTool';

  constructor(
    circuitBreaker: CircuitBreaker,
    public readonly composio: ComposioClient,
    private projectionRepo: CalendarProjectionMongoRepository
  ) {
    super(circuitBreaker);
  }

  // ── List Events ───────────────────────────────────────────────────────────

  async listEvents(
    input: ToolInput & { timeMin: Date; timeMax: Date }
  ): Promise<ToolResult<ComposioCalendarEvent[]>> {
    const start = Date.now();
    RuntimeEventBus.log('TOOL_CALLED', 'SYSTEM',
      `CalendarTool.listEvents [${input.timeMin.toISOString()} → ${input.timeMax.toISOString()}]`,
      input.traceId
    );

    return this.execute(
      {
        operationName: 'CalendarTool.ListEvents',
        isReplay: input.isReplay,
        isSandbox: input.isSandbox,
        replaySafe: true,
        idempotencyKey: input.idempotencyKey,
        requiredScopes: ['READ_CALENDAR'],
      },
      async () => {
        const events = await this.composio.listEvents(input.timeMin, input.timeMax, input.traceId);
        RuntimeEventBus.log('TOOL_RESULT', 'SYSTEM',
          `CalendarTool.listEvents → ${events.length} events (${Date.now() - start}ms)`,
          input.traceId
        );
        return { success: true, data: events, latencyMs: Date.now() - start };
      },
      async () => {
        RuntimeEventBus.log('TOOL_RESULT', 'SYSTEM', `CalendarTool.listEvents [SANDBOX/REPLAY] → []`, input.traceId);
        return { success: true, data: [], latencyMs: 0 };
      }
    );
  }

  // ── Create Event ──────────────────────────────────────────────────────────

  async createEvent(
    input: ToolInput & { event: CalendarEventInput }
  ): Promise<ToolResult<ComposioCalendarEvent>> {
    const start = Date.now();
    RuntimeEventBus.log('TOOL_CALLED', 'SYSTEM',
      `CalendarTool.createEvent "${input.event.summary}"`,
      input.traceId
    );

    return this.execute(
      {
        operationName: 'CalendarTool.CreateEvent',
        isReplay: input.isReplay,
        isSandbox: input.isSandbox,
        replaySafe: false,
        idempotencyKey: input.idempotencyKey,
        requiredScopes: ['WRITE_CALENDAR'],
      },
      async () => {
        const event = await this.composio.createEvent(input.event, input.traceId);

        // Sync shadow projection immediately after successful creation
        if (event.id) {
          await this.upsertShadowProjection(event, input.userId, input.traceId);
        }

        RuntimeEventBus.log('TOOL_RESULT', 'SYSTEM',
          `CalendarTool.createEvent → eventId: ${event.id} (${Date.now() - start}ms)`,
          input.traceId
        );
        return {
          success: true,
          data: event,
          externalEventId: event.id,
          etag: event.etag,
          latencyMs: Date.now() - start
        };
      },
      async () => {
        RuntimeEventBus.log('TOOL_RESULT', 'SYSTEM', `CalendarTool.createEvent [SANDBOX] → mocked`, input.traceId);
        return { 
          success: true, 
          data: { id: 'sandbox-event-id', summary: input.event.summary }, 
          externalEventId: 'sandbox-event-id',
          etag: undefined,
          latencyMs: 0 
        };
      }
    );
  }

  // ── Update Event ──────────────────────────────────────────────────────────

  async updateEvent(
    input: ToolInput & { eventId: string; event: Partial<CalendarEventInput> }
  ): Promise<ToolResult<ComposioCalendarEvent>> {
    const start = Date.now();
    RuntimeEventBus.log('TOOL_CALLED', 'SYSTEM',
      `CalendarTool.updateEvent eventId="${input.eventId}"`,
      input.traceId
    );

    return this.execute(
      {
        operationName: 'CalendarTool.UpdateEvent',
        isReplay: input.isReplay,
        isSandbox: input.isSandbox,
        replaySafe: false,
        idempotencyKey: input.idempotencyKey,
        requiredScopes: ['WRITE_CALENDAR'],
      },
      async () => {
        const event = await this.composio.updateEvent(input.eventId, input.event, input.traceId);

        if (event.id) {
          await this.upsertShadowProjection(event, input.userId, input.traceId);
        }

        RuntimeEventBus.log('TOOL_RESULT', 'SYSTEM',
          `CalendarTool.updateEvent → eventId: ${input.eventId} (${Date.now() - start}ms)`,
          input.traceId
        );
        return { success: true, data: event, externalEventId: event.id, latencyMs: Date.now() - start };
      },
      async () => {
        return { success: true, data: { id: input.eventId }, externalEventId: input.eventId, latencyMs: 0 };
      }
    );
  }

  // ── Delete Event ──────────────────────────────────────────────────────────

  async deleteEvent(
    input: ToolInput & { eventId: string }
  ): Promise<ToolResult<void>> {
    const start = Date.now();
    RuntimeEventBus.log('TOOL_CALLED', 'SYSTEM',
      `CalendarTool.deleteEvent eventId="${input.eventId}"`,
      input.traceId
    );

    return this.execute(
      {
        operationName: 'CalendarTool.DeleteEvent',
        isReplay: input.isReplay,
        isSandbox: input.isSandbox,
        replaySafe: false,
        idempotencyKey: input.idempotencyKey,
        requiredScopes: ['WRITE_CALENDAR'],
      },
      async () => {
        await this.composio.deleteEvent(input.eventId, input.traceId);

        // Archive projection
        const existing = await this.projectionRepo.findByGoogleEventId(input.eventId);
        if (existing) {
          existing.syncState = CalendarSyncState.PENDING_DELETE;
          await this.projectionRepo.save(existing);
        }

        RuntimeEventBus.log('TOOL_RESULT', 'SYSTEM',
          `CalendarTool.deleteEvent → done (${Date.now() - start}ms)`,
          input.traceId
        );
        return { success: true, latencyMs: Date.now() - start };
      },
      async () => {
        return { success: true, latencyMs: 0 };
      }
    );
  }

  // ── Find Events ───────────────────────────────────────────────────────────

  async findEvents(
    input: ToolInput & { query: string; timeMin: Date; timeMax: Date }
  ): Promise<ToolResult<ComposioCalendarEvent[]>> {
    const start = Date.now();
    RuntimeEventBus.log('TOOL_CALLED', 'SYSTEM',
      `CalendarTool.findEvents query="${input.query}"`,
      input.traceId
    );

    return this.execute(
      {
        operationName: 'CalendarTool.FindEvents',
        isReplay: input.isReplay,
        isSandbox: input.isSandbox,
        replaySafe: true,
        idempotencyKey: input.idempotencyKey,
        requiredScopes: ['READ_CALENDAR'],
      },
      async () => {
        const events = await this.composio.findEvents(input.query, input.timeMin, input.timeMax, input.traceId);
        RuntimeEventBus.log('TOOL_RESULT', 'SYSTEM',
          `CalendarTool.findEvents → ${events.length} results (${Date.now() - start}ms)`,
          input.traceId
        );
        return { success: true, data: events, latencyMs: Date.now() - start };
      },
      async () => {
        return { success: true, data: [], latencyMs: 0 };
      }
    );
  }

  // ── Private: Shadow Projection Upsert ────────────────────────────────────

  private async upsertShadowProjection(
    event: ComposioCalendarEvent,
    userId: string,
    traceId: string
  ): Promise<void> {
    try {
      const existing = await this.projectionRepo.findByGoogleEventId(event.id!);
      const internalId = existing?.internalTaskId ?? randomUUID();
      const startTime = new Date(event.start?.dateTime || event.start?.date || new Date());
      const endTime = new Date(event.end?.dateTime || event.end?.date || new Date());

      await this.projectionRepo.save({
        internalTaskId: internalId,
        googleEventId: event.id,
        calendarId: 'primary',
        title: event.summary || 'Untitled Event',
        description: event.description,
        startTime,
        endTime,
        timezone: event.start?.timeZone || 'Asia/Kolkata',
        syncState: CalendarSyncState.SYNCED,
        lastExternalSyncAt: new Date(),
        lastInternalMutationAt: new Date(),
        etag: event.etag,
        replaySafe: false,
        version: (existing?.version ?? 0) + 1,
        createdBy: userId,
        updatedBy: userId,
      });

      RuntimeEventBus.log('SHADOW_PROJECTION_SYNC', 'SYSTEM',
        `Shadow projection upserted for eventId: ${event.id}`,
        traceId
      );
    } catch (err: any) {
      // Non-fatal: projection sync failure should not block the primary tool result
      console.error('[CalendarTool] Shadow projection upsert failed:', err.message);
    }
  }
}
