import { Composio } from '@composio/core';
import { LlamaindexProvider } from '@composio/llamaindex';
import { RuntimeEventBus } from '../../console/RuntimeEventBus.js';

// ─────────────────────────────────────────────────────────────────────────────
// ComposioClient — The ONLY file in Karen that imports @composio/core.
//
// This is transport-only infrastructure. It:
//  - Wraps the Composio SDK for use by CalendarTool and future tools.
//  - Exposes strongly-typed methods for each Google Calendar action.
//  - Uses Composio's Managed OAuth (single connected account for the assistant).
//  - NEVER orchestrates workflows, manages memory, or makes decisions.
//
// Composio Action Names (googlecalendar toolkit):
//  - GOOGLECALENDAR_LIST_EVENTS
//  - GOOGLECALENDAR_CREATE_EVENT
//  - GOOGLECALENDAR_UPDATE_GOOGLE_EVENT
//  - GOOGLECALENDAR_DELETE_EVENT
//  - GOOGLECALENDAR_FIND_EVENT
//  - GOOGLECALENDAR_QUICK_ADD_EVENT
// ─────────────────────────────────────────────────────────────────────────────

export interface CalendarEventInput {
  summary: string;
  description?: string;
  startDateTime: string;  // ISO 8601
  endDateTime: string;    // ISO 8601
  timezone?: string;
  location?: string;
  calendarId?: string;
}

export interface ComposioCalendarEvent {
  id?: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  location?: string;
  status?: string;
  htmlLink?: string;
  etag?: string;
}

export class ComposioClient {
  private composio: Composio;
  private userId: string;

  constructor(apiKey: string, userId: string) {
    this.composio = new Composio({
      apiKey,
      provider: new LlamaindexProvider(),
    });
    this.userId = userId;
  }

  // ── Session & Tool Access ─────────────────────────────────────────────────

  public async getCalendarTools() {
    const session = await this.composio.create(this.userId);
    return session.tools({ toolkits: ['googlecalendar'] });
  }

  // ── Calendar Tool Executions ──────────────────────────────────────────────

  public async listEvents(
    timeMin: Date,
    timeMax: Date,
    traceId: string
  ): Promise<ComposioCalendarEvent[]> {
    try {
      const session = await this.composio.create(this.userId);
      const result = await session.execute('GOOGLECALENDAR_EVENTS_LIST', {
        time_min: timeMin.toISOString(),
        time_max: timeMax.toISOString(),
        calendar_id: 'primary',
        single_events: true,
      });

      RuntimeEventBus.log('COMPOSIO_REQUEST', 'TRANSPORT',
        `GOOGLECALENDAR_EVENTS_LIST → ${result?.data?.items?.length ?? 0} events`,
        traceId
      );

      return result?.data?.items || [];
    } catch (err: any) {
      RuntimeEventBus.log('COMPOSIO_ERROR', 'ERROR',
        `GOOGLECALENDAR_EVENTS_LIST failed: ${err.message}`, traceId);
      throw err;
    }
  }

  public async createEvent(
    input: CalendarEventInput,
    traceId: string
  ): Promise<ComposioCalendarEvent> {
    try {
      const session = await this.composio.create(this.userId);
      const result = await session.execute('GOOGLECALENDAR_CREATE_EVENT', {
        summary: input.summary,
        description: input.description,
        start_datetime: input.startDateTime,
        end_datetime: input.endDateTime,
        timezone: input.timezone || 'Asia/Kolkata',
        location: input.location,
        calendar_id: input.calendarId || 'primary',
      });

      RuntimeEventBus.log('COMPOSIO_REQUEST', 'TRANSPORT',
        `GOOGLECALENDAR_CREATE_EVENT → eventId: ${result?.data?.id}`, traceId);

      return result?.data || {};
    } catch (err: any) {
      RuntimeEventBus.log('COMPOSIO_ERROR', 'ERROR',
        `GOOGLECALENDAR_CREATE_EVENT failed: ${err.message}`, traceId);
      throw err;
    }
  }

  public async updateEvent(
    eventId: string,
    input: Partial<CalendarEventInput>,
    traceId: string
  ): Promise<ComposioCalendarEvent> {
    try {
      const session = await this.composio.create(this.userId);
      const result = await session.execute('GOOGLECALENDAR_UPDATE_EVENT', {
        event_id: eventId,
        calendar_id: input.calendarId || 'primary',
        summary: input.summary,
        description: input.description,
        start_datetime: input.startDateTime,
        end_datetime: input.endDateTime,
        timezone: input.timezone,
        location: input.location,
      });

      RuntimeEventBus.log('COMPOSIO_REQUEST', 'TRANSPORT',
        `GOOGLECALENDAR_UPDATE_EVENT → eventId: ${eventId}`, traceId);

      return result?.data || {};
    } catch (err: any) {
      RuntimeEventBus.log('COMPOSIO_ERROR', 'ERROR',
        `GOOGLECALENDAR_UPDATE_EVENT failed: ${err.message}`, traceId);
      throw err;
    }
  }

  public async deleteEvent(
    eventId: string,
    traceId: string
  ): Promise<void> {
    try {
      const session = await this.composio.create(this.userId);
      await session.execute('GOOGLECALENDAR_DELETE_EVENT', {
        event_id: eventId,
        calendar_id: 'primary',
      });

      RuntimeEventBus.log('COMPOSIO_REQUEST', 'TRANSPORT',
        `GOOGLECALENDAR_DELETE_EVENT → eventId: ${eventId}`, traceId);
    } catch (err: any) {
      RuntimeEventBus.log('COMPOSIO_ERROR', 'ERROR',
        `GOOGLECALENDAR_DELETE_EVENT failed: ${err.message}`, traceId);
      throw err;
    }
  }

  public async findEvents(
    query: string,
    timeMin: Date,
    timeMax: Date,
    traceId: string
  ): Promise<ComposioCalendarEvent[]> {
    try {
      const session = await this.composio.create(this.userId);
      const result = await session.execute('GOOGLECALENDAR_FIND_EVENT', {
        query,
        time_min: timeMin.toISOString(),
        time_max: timeMax.toISOString(),
        calendar_id: 'primary',
      });

      RuntimeEventBus.log('COMPOSIO_REQUEST', 'TRANSPORT',
        `GOOGLECALENDAR_FIND_EVENT query="${query}" → ${result?.data?.items?.length ?? 0} results`, traceId);

      return result?.data?.items || [];
    } catch (err: any) {
      RuntimeEventBus.log('COMPOSIO_ERROR', 'ERROR',
        `GOOGLECALENDAR_FIND_EVENT failed: ${err.message}`, traceId);
      throw err;
    }
  }
}
