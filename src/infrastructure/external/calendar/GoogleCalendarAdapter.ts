import { ToolExecutionGateway } from '../gateway/ToolExecutionGateway.js';
import { CircuitBreaker } from '../../resiliency/CircuitBreaker.js';
import { ICalendarAdapter, CalendarEventPayload, ConflictCheckResult, CalendarSyncResult } from '../../../application/ports/ICalendarAdapter.js';
import { CalendarEventProjection, SyncConflictType } from '../../../domain/calendar/CalendarEventProjection.js';
import { GoogleCalendarMapper } from './GoogleCalendarMapper.js';
import { google, calendar_v3 } from 'googleapis';
import { RuntimeConfig } from '../../../composition/config/RuntimeConfig.js';

export class GoogleCalendarAdapter extends ToolExecutionGateway implements ICalendarAdapter {
  private calendarApi?: calendar_v3.Calendar;
  private isConfigured: boolean = false;
  private defaultCalendarId: string = 'primary';

  constructor(circuitBreaker: CircuitBreaker, private config: RuntimeConfig) {
    super(circuitBreaker);
    this.initialize();
  }

  private initialize() {
    try {
      const email = this.config.GOOGLE_SERVICE_ACCOUNT_EMAIL;
      const privateKey = this.config.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
      const calendarId = this.config.GOOGLE_CALENDAR_ID;

      if (email && privateKey) {
        const auth = new google.auth.JWT({
          email: email,
          key: privateKey.replace(/\\n/g, '\n'),
          scopes: ['https://www.googleapis.com/auth/calendar']
        });
        this.calendarApi = google.calendar({ version: 'v3', auth });
        this.isConfigured = true;
        
        if (calendarId) {
          this.defaultCalendarId = calendarId;
        }
      } else {
        console.warn('[GOOGLE CALENDAR] Credentials missing. GoogleCalendarAdapter initialized in inactive mode.');
      }
    } catch (err: any) {
      console.error('[GOOGLE CALENDAR] Failed to initialize Google API client:', err.message);
    }
  }

  async checkConflicts(event: CalendarEventPayload, isSandbox: boolean): Promise<ConflictCheckResult> {
    if (!this.isConfigured || isSandbox) {
      return { hasConflict: false, conflictType: SyncConflictType.NONE, conflictingEventIds: [] };
    }

    return this.execute(
      {
        operationName: 'GoogleCalendar.CheckConflicts',
        isReplay: false,
        isSandbox,
        replaySafe: true,
        idempotencyKey: `cal-conflict-${event.startTime.toISOString()}`,
        requiredScopes: ['READ_CALENDAR']
      },
      async () => {
        try {
          const res = await this.calendarApi!.events.list({
            calendarId: this.defaultCalendarId,
            timeMin: event.startTime.toISOString(),
            timeMax: event.endTime.toISOString(),
            singleEvents: true,
          });

          const items = res.data.items || [];
          if (items.length > 0) {
            return {
              hasConflict: true,
              conflictType: SyncConflictType.SOFT_OVERLAP,
              conflictingEventIds: items.map(i => i.id!).filter(id => !!id)
            };
          }

          return { hasConflict: false, conflictType: SyncConflictType.NONE, conflictingEventIds: [] };
        } catch (err: any) {
          console.error('[GoogleCalendarAdapter] Conflict check failed:', err.message);
          return { hasConflict: false, conflictType: SyncConflictType.NONE, conflictingEventIds: [] };
        }
      },
      async () => {
        return { hasConflict: false, conflictType: SyncConflictType.NONE, conflictingEventIds: [] };
      }
    );
  }

  async createEvent(projection: CalendarEventProjection, isSandbox: boolean): Promise<CalendarSyncResult> {
    if (!this.isConfigured) {
      return { success: false, error: 'Google Calendar API not configured', isRetryable: false };
    }

    return this.execute(
      {
        operationName: 'GoogleCalendar.CreateEvent',
        isReplay: false,
        isSandbox,
        replaySafe: projection.replaySafe,
        idempotencyKey: `cal-create-${projection.internalTaskId}`,
        requiredScopes: ['MODIFY_CALENDAR']
      },
      async () => {
        try {
          const googleEventPayload = GoogleCalendarMapper.toGoogleEvent(projection);
          
          const res = await this.calendarApi!.events.insert({
            calendarId: projection.calendarId || this.defaultCalendarId,
            requestBody: googleEventPayload
          });

          return {
            success: true,
            googleEventId: res.data.id || undefined,
            etag: res.data.etag || undefined
          };
        } catch (err: any) {
          const isRetryable = err.code === 429 || err.code >= 500;
          return { success: false, error: err.message, isRetryable };
        }
      },
      async () => {
        return { success: true, googleEventId: `simulated-${projection.internalTaskId}` };
      }
    );
  }

  async updateEvent(projection: CalendarEventProjection, isSandbox: boolean): Promise<CalendarSyncResult> {
    if (!this.isConfigured || !projection.googleEventId) {
      return { success: false, error: 'Not configured or missing googleEventId', isRetryable: false };
    }

    return this.execute(
      {
        operationName: 'GoogleCalendar.UpdateEvent',
        isReplay: false,
        isSandbox,
        replaySafe: projection.replaySafe,
        idempotencyKey: `cal-update-${projection.internalTaskId}-${projection.version}`,
        requiredScopes: ['MODIFY_CALENDAR']
      },
      async () => {
        try {
          const googleEventPayload = GoogleCalendarMapper.toGoogleEvent(projection);
          
          const res = await this.calendarApi!.events.update({
            calendarId: projection.calendarId || this.defaultCalendarId,
            eventId: projection.googleEventId!,
            requestBody: googleEventPayload
          });

          return {
            success: true,
            googleEventId: res.data.id || undefined,
            etag: res.data.etag || undefined
          };
        } catch (err: any) {
          const isRetryable = err.code === 429 || err.code >= 500;
          return { success: false, error: err.message, isRetryable };
        }
      },
      async () => {
        return { success: true, googleEventId: projection.googleEventId };
      }
    );
  }

  async deleteEvent(projection: CalendarEventProjection, isSandbox: boolean): Promise<CalendarSyncResult> {
    if (!this.isConfigured || !projection.googleEventId) {
      return { success: false, error: 'Not configured or missing googleEventId', isRetryable: false };
    }

    return this.execute(
      {
        operationName: 'GoogleCalendar.DeleteEvent',
        isReplay: false,
        isSandbox,
        replaySafe: true,
        idempotencyKey: `cal-delete-${projection.internalTaskId}`,
        requiredScopes: ['MODIFY_CALENDAR']
      },
      async () => {
        try {
          await this.calendarApi!.events.delete({
            calendarId: projection.calendarId || this.defaultCalendarId,
            eventId: projection.googleEventId!
          });

          return { success: true };
        } catch (err: any) {
          // If already deleted, treat as success
          if (err.code === 404 || err.code === 410) {
            return { success: true };
          }
          const isRetryable = err.code === 429 || err.code >= 500;
          return { success: false, error: err.message, isRetryable };
        }
      },
      async () => {
        return { success: true };
      }
    );
  }

  async fetchExternalEvent(googleEventId: string, calendarId: string, isSandbox: boolean): Promise<any> {
    if (!this.isConfigured || isSandbox) {
      return null;
    }
    
    try {
      const res = await this.calendarApi!.events.get({
        calendarId: calendarId || this.defaultCalendarId,
        eventId: googleEventId
      });
      return res.data;
    } catch (err: any) {
      if (err.code === 404 || err.code === 410) {
        return null; // Deleted or not found
      }
      throw err;
    }
  }
}
