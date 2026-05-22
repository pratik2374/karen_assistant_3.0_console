import { Db, Collection, UpdateResult } from 'mongodb';
import { CalendarEventProjection, CalendarSyncState } from '../../../../domain/calendar/CalendarEventProjection.js';

export class CalendarProjectionMongoRepository {
  private collection: Collection<CalendarEventProjection>;

  constructor(private db: Db) {
    this.collection = this.db.collection('calendar_event_projection');
  }

  async findByInternalTaskId(internalTaskId: string): Promise<CalendarEventProjection | null> {
    return this.collection.findOne({ internalTaskId });
  }

  async findByGoogleEventId(googleEventId: string): Promise<CalendarEventProjection | null> {
    return this.collection.findOne({ googleEventId });
  }

  async findByTitleAndStartTime(title: string, startTime: Date): Promise<CalendarEventProjection | null> {
    return this.collection.findOne({ title, startTime });
  }

  async updateGoogleEventId(internalTaskId: string, googleEventId: string): Promise<void> {
    await this.collection.updateOne(
      { internalTaskId },
      { $set: { googleEventId, syncState: CalendarSyncState.SYNCED, lastExternalSyncAt: new Date() } }
    );
  }

  async save(projection: CalendarEventProjection): Promise<void> {
    await this.collection.updateOne(
      { internalTaskId: projection.internalTaskId },
      { $set: projection },
      { upsert: true }
    );
  }

  async updateSyncState(internalTaskId: string, state: CalendarSyncState, etag?: string, googleEventId?: string): Promise<UpdateResult> {
    const updateDoc: any = {
      $set: {
        syncState: state,
        lastInternalMutationAt: new Date()
      }
    };
    
    if (etag) updateDoc.$set.etag = etag;
    if (googleEventId) updateDoc.$set.googleEventId = googleEventId;
    if (state === CalendarSyncState.SYNCED) {
      updateDoc.$set.lastExternalSyncAt = new Date();
    }

    return this.collection.updateOne({ internalTaskId }, updateDoc);
  }

  async findPendingSyncs(limit: number = 50): Promise<CalendarEventProjection[]> {
    return this.collection.find({
      syncState: {
        $in: [
          CalendarSyncState.PENDING_CREATE,
          CalendarSyncState.PENDING_UPDATE,
          CalendarSyncState.PENDING_DELETE,
          CalendarSyncState.FAILED_RETRYABLE
        ]
      }
    }).limit(limit).toArray();
  }

  async markAsDriftDetected(internalTaskId: string): Promise<void> {
    await this.updateSyncState(internalTaskId, CalendarSyncState.DRIFT_DETECTED);
  }
}
