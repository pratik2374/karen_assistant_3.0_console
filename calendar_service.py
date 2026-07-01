import os
from datetime import datetime, timezone, timedelta
from google.oauth2 import service_account
from googleapiclient.discovery import build
from db import tasks_col, saga_states_col

def get_calendar_service():
    """Initializes Google Calendar API Client using Service Account Credentials from environment."""
    email = os.getenv("GOOGLE_SERVICE_ACCOUNT_EMAIL")
    private_key = os.getenv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY")
    if not email or not private_key:
        print("[Calendar] Google Calendar credentials not found in environment. Sync is disabled.")
        return None

    info = {
        "type": "service_account",
        "private_key": private_key.replace("\\n", "\n"),
        "client_email": email,
        "token_uri": "https://oauth2.googleapis.com/token"
    }

    try:
        credentials = service_account.Credentials.from_service_account_info(
            info,
            scopes=['https://www.googleapis.com/auth/calendar.readonly']
        )
        return build('calendar', 'v3', credentials=credentials)
    except Exception as e:
        print(f"[Calendar] API Client initialization failed: {e}")
        return None

def sync_calendar_events():
    """Fetches calendar events for the next 24 hours and syncs them to MongoDB tasks & sagas."""
    service = get_calendar_service()
    if not service:
        return

    calendar_id = os.getenv("GOOGLE_CALENDAR_ID", "primary")
    
    # Range: 16 hours ago (covers entire day starting from morning) to 24 hours from now
    now_utc = datetime.now(timezone.utc)
    time_min = (now_utc - timedelta(hours=16)).isoformat()
    time_max = (now_utc + timedelta(hours=24)).isoformat()

    try:
        print(f"[Calendar] Fetching events from '{calendar_id}'...")
        events_result = service.events().list(
            calendarId=calendar_id,
            timeMin=time_min,
            timeMax=time_max,
            singleEvents=True,
            orderBy='startTime'
        ).execute()
        
        events = events_result.get('items', [])
        print(f"[Calendar] Found {len(events)} events in Google Calendar.")

        new_tasks_count = 0
        for event in events:
            event_id = event.get('id')
            title = event.get('summary', 'Untitled Event')
            
            # Get event start and end times
            start = event.get('start', {})
            start_time_str = start.get('dateTime') or start.get('date')
            if not start_time_str:
                continue
                
            end = event.get('end', {})
            end_time_str = end.get('dateTime') or end.get('date') or start_time_str
            
            # Normalize ISO start/end times
            if len(start_time_str) == 10:
                start_time_str += "T00:00:00Z"
            if len(end_time_str) == 10:
                end_time_str += "T00:00:00Z"
            
            # Check if task already exists
            existing_task = tasks_col.find_one({"id": event_id})
            
            if not existing_task:
                # 1. Insert new task with end_time
                tasks_col.insert_one({
                    "id": event_id,
                    "title": title,
                    "start_time": start_time_str,
                    "end_time": end_time_str,
                    "status": "PENDING"
                })
                
                # 2. Parse start date to set timer
                try:
                    dt = datetime.fromisoformat(start_time_str.replace("Z", "+00:00"))
                except Exception:
                    dt = datetime.strptime(start_time_str[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)

                # Set Pre-Alert trigger time: 10 minutes before start
                pre_alert_time = dt - timedelta(minutes=10)
                # If the event is starting sooner, fire in 10 seconds
                if pre_alert_time < now_utc:
                    pre_alert_time = now_utc + timedelta(seconds=10)

                # 3. Create active saga state
                saga_states_col.insert_one({
                    "task_id": event_id,
                    "current_stage": 0,  # 0=pre-alert, 1=check-in, 2=nudge
                    "next_wakeup": pre_alert_time.isoformat(),
                    "status": "ACTIVE"
                })
                
                new_tasks_count += 1
                print(f"[Calendar] Synced new task: '{title}' (ID: {event_id}) starting at {start_time_str}")
            else:
                # Event start time changed, update it if still pending
                if existing_task["status"] == "PENDING" and (existing_task.get("start_time") != start_time_str or existing_task.get("end_time") != end_time_str):
                    tasks_col.update_one(
                        {"id": event_id},
                        {"$set": {
                            "start_time": start_time_str,
                            "end_time": end_time_str
                        }}
                    )
                    
                    # Reschedule wakeup
                    try:
                        dt = datetime.fromisoformat(start_time_str.replace("Z", "+00:00"))
                    except Exception:
                        dt = datetime.strptime(start_time_str[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
                    
                    pre_alert_time = dt - timedelta(minutes=10)
                    if pre_alert_time < now_utc:
                        pre_alert_time = now_utc + timedelta(seconds=10)
                        
                    saga_states_col.update_one(
                        {"task_id": event_id, "status": "ACTIVE"},
                        {"$set": {"next_wakeup": pre_alert_time.isoformat(), "current_stage": 0}}
                    )
                    print(f"[Calendar] Updated rescheduled task: '{title}' starting at {start_time_str}")

        if new_tasks_count > 0:
            print(f"[Calendar] Sync completed. Created {new_tasks_count} new tasks.")

    except Exception as e:
        print(f"[Calendar] Synchronization failed: {e}")

if __name__ == "__main__":
    import db
    sync_calendar_events()
