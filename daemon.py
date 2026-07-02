import time
import os
from datetime import datetime, timezone, timedelta
from db import tasks_col, saga_states_col, live_alerts_col, missed_reasons_col, recurring_reminders_col, diary_prompts_col
from calendar_service import sync_calendar_events
from notifier import show_escalation_toast
import ai

def parse_iso_time(time_str: str) -> datetime:
    """Parses an ISO format time string with UTC timezone offset indicator."""
    try:
        return datetime.fromisoformat(time_str.replace("Z", "+00:00"))
    except Exception:
        return datetime.strptime(time_str[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)

def process_active_sagas():
    """Checks for due timers in active reminder sagas and processes stage transitions."""
    now_utc = datetime.now(timezone.utc)
    now_str = now_utc.isoformat()

    # Query all active sagas with wakeups due now or in the past
    due_sagas = list(saga_states_col.find({
        "status": "ACTIVE",
        "next_wakeup": {"$lte": now_str}
    }))

    for saga in due_sagas:
        task_id = saga["task_id"]
        stage = saga["current_stage"]
        
        # Load associated task
        task = tasks_col.find_one({"id": task_id})
        if not task:
            # Task deleted, stop saga
            saga_states_col.update_one({"task_id": task_id}, {"$set": {"status": "STOPPED"}})
            continue

        # If user already started or finished the task, stop the saga immediately
        if task["status"] in ["STARTED", "COMPLETED", "CANCELLED", "MISSED"]:
            saga_states_col.update_one({"task_id": task_id}, {"$set": {"status": "STOPPED"}})
            print(f"[Daemon] Terminated saga for task '{task['title']}' (ID: {task_id}) since status is '{task['status']}'")
            continue

        title = task["title"]
        start_time_dt = parse_iso_time(task["start_time"])

        # Check if reminder is too late to fire (recovery window logic: now_utc > start_time_dt + delay_minutes)
        delay_minutes = task.get("delay_minutes")
        if delay_minutes is not None:
            max_firing_time = start_time_dt + timedelta(minutes=delay_minutes)
            if now_utc > max_firing_time:
                # Too old! Mark task as MISSED and stop saga
                tasks_col.update_one({"id": task_id}, {"$set": {"status": "MISSED"}})
                saga_states_col.update_one({"task_id": task_id}, {"$set": {"status": "STOPPED"}})
                # Insert default "User not specified" reason, but should_ask=False
                missed_reasons_col.update_one(
                    {"task_id": task_id},
                    {"$setOnInsert": {
                        "task_id": task_id,
                        "reason": "User not specified",
                        "timestamp": now_utc.isoformat(),
                        "should_ask": False
                    }},
                    upsert=True
                )
                print(f"[Daemon] Terminated saga for reminder '{title}' (ID: {task_id}) since it is too late to fire (recovery window passed: {now_utc.isoformat()} > {max_firing_time.isoformat()})")
                continue

        print(f"[Daemon] Processing Saga Stage {stage} for task: '{title}' (ID: {task_id})")

        if stage == 0:
            # ─────────────────────────────────────────────────────────────────
            # Stage 0: Pre-Alert (10 minutes before event)
            # ─────────────────────────────────────────────────────────────────
            prompt = f"Write a snarky, punchy pre-alert message warning the user that their task '{title}' starts in 10 minutes. Tell them to wrap up whatever they are doing."
            message = ai.generate_karen_response(prompt)
            
            # Show toast with action buttons
            show_escalation_toast("Upcoming Task Warning", message, task_id)
            
            # Log alert
            live_alerts_col.insert_one({
                "message": message,
                "timestamp": now_utc.isoformat(),
                "processed": False
            })
            
            # Set Check-In wakeup: start_time + 15 minutes (or 1 minute if starts in less than 10 minutes)
            time_to_start = start_time_dt - now_utc
            if time_to_start <= timedelta(minutes=10):
                check_in_time = start_time_dt + timedelta(minutes=1)
            else:
                check_in_time = start_time_dt + timedelta(minutes=15)
                
            if check_in_time < now_utc:
                # If event already started in past, schedule check-in in 1 minute
                check_in_time = now_utc + timedelta(minutes=1)

            # Update saga state to Stage 1
            saga_states_col.update_one(
                {"task_id": task_id},
                {"$set": {
                    "current_stage": 1,
                    "next_wakeup": check_in_time.isoformat()
                }}
            )
            print(f"[Daemon] Saga for '{title}' advanced to Stage 1 (Check-In scheduled at {check_in_time.isoformat()})")

        elif stage == 1:
            # ─────────────────────────────────────────────────────────────────
            # Stage 1: Check-In (15 minutes after event start)
            # ─────────────────────────────────────────────────────────────────
            prompt = f"Write a snarky, critical check-in notification for a task '{title}' that started 15 minutes ago. The user has not confirmed starting it yet. Tell them to get to work."
            message = ai.generate_karen_response(prompt)
            
            # Show toast with action buttons
            show_escalation_toast("Did you start yet?", message, task_id)
            
            # Log alert
            live_alerts_col.insert_one({
                "message": message,
                "timestamp": now_utc.isoformat(),
                "processed": False
            })
            
            # Set Nudge wakeup: 10 minutes from now (or 5 minutes for short-interval reminders < 10m)
            time_since_start = now_utc - start_time_dt
            if time_since_start <= timedelta(minutes=10):
                nudge_time = now_utc + timedelta(minutes=5)
            else:
                nudge_time = now_utc + timedelta(minutes=10)

            # Update saga state to Stage 2
            saga_states_col.update_one(
                {"task_id": task_id},
                {"$set": {
                    "current_stage": 2,
                    "next_wakeup": nudge_time.isoformat()
                }}
            )
            print(f"[Daemon] Saga for '{title}' advanced to Stage 2 (Nudge scheduled at {nudge_time.isoformat()})")

        elif stage == 2:
            # ─────────────────────────────────────────────────────────────────
            # Stage 2: Disappointed Nudge (10 minutes after Check-In)
            # ─────────────────────────────────────────────────────────────────
            prompt = f"Write a highly mocking, disappointed emotional nudge for a task '{title}' that started 25 minutes ago. The user completely ignored previous alerts. Make it highly sarcastic."
            message = ai.generate_karen_response(prompt)
            
            # Show final notification (no buttons needed, or keep buttons in case they start late)
            show_escalation_toast("I am disappointed in you", message, task_id)
            
            # Log alert
            live_alerts_col.insert_one({
                "message": message,
                "timestamp": now_utc.isoformat(),
                "processed": False
            })
            
            # Mark task status as MISSED and stop saga
            tasks_col.update_one({"id": task_id}, {"$set": {"status": "MISSED"}})
            saga_states_col.update_one({"task_id": task_id}, {"$set": {"status": "STOPPED"}})
            # Insert default "User not specified" reason with should_ask=True, ask_after = now + 10 mins
            ask_after_time = now_utc + timedelta(minutes=10)
            missed_reasons_col.update_one(
                {"task_id": task_id},
                {"$set": {
                    "task_id": task_id,
                    "reason": "User not specified",
                    "timestamp": now_utc.isoformat(),
                    "ask_after": ask_after_time.isoformat(),
                    "should_ask": True
                }},
                upsert=True
            )
            print(f"[Daemon] Saga for '{title}' completed. Task marked as MISSED.")

def check_expired_tasks():
    """Checks for tasks whose end_time has passed in the past, and if still PENDING or STARTED, marks them as MISSED."""
    now_utc = datetime.now(timezone.utc)
    now_str = now_utc.isoformat()
    
    # Query pending or started tasks whose end_time has passed
    expired_tasks = list(tasks_col.find({
        "status": {"$in": ["PENDING", "STARTED"]},
        "end_time": {"$lt": now_str}
    }))
    
    for task in expired_tasks:
        task_id = task["id"]
        title = task["title"]
        old_status = task["status"]
        
        # Mark as MISSED
        tasks_col.update_one({"id": task_id}, {"$set": {"status": "MISSED"}})
        saga_states_col.update_one({"task_id": task_id}, {"$set": {"status": "STOPPED"}})
        # Insert default "User not specified" reason, but should_ask=False
        missed_reasons_col.update_one(
            {"task_id": task_id},
            {"$setOnInsert": {
                "task_id": task_id,
                "reason": "User not specified",
                "timestamp": now_utc.isoformat(),
                "should_ask": False
            }},
            upsert=True
        )
        print(f"[Daemon] Task '{title}' (ID: {task_id}) has expired (end_time passed). Marked as MISSED (was {old_status}).")

def process_recurring_reminders():
    """Checks active recurring reminders and task diaries and triggers prompts or alerts."""
    now_utc = datetime.now(timezone.utc)
    active_reminders = list(recurring_reminders_col.find({"active": True}))
    
    for r in active_reminders:
        try:
            last_fired_str = r.get("last_fired")
            if not last_fired_str:
                last_fired_str = now_utc.isoformat()
                recurring_reminders_col.update_one({"_id": r["_id"]}, {"$set": {"last_fired": last_fired_str}})
                
            last_fired_dt = parse_iso_time(last_fired_str)
            interval_mins = r["interval_minutes"]
            
            # Check if due
            if now_utc >= last_fired_dt + timedelta(minutes=interval_mins):
                title = r["title"]
                r_type = r.get("type", "RECURRING_REMINDER")
                
                # Update last fired immediately
                recurring_reminders_col.update_one({"_id": r["_id"]}, {"$set": {"last_fired": now_utc.isoformat()}})
                
                if r_type == "DIARY":
                    import subprocess
                    import sys
                    base_dir = os.path.dirname(os.path.abspath(__file__))
                    script_path = os.path.join(base_dir, "gui_alerts.py")
                    pythonw_exe = sys.executable.replace("python.exe", "pythonw.exe")
                    subprocess.Popen([pythonw_exe, script_path, "--type", "diary"], cwd=base_dir)
                    print(f"[Daemon] Launched task diary GUI.")
                else:
                    # Snarky water/stretch reminder alert
                    if "water" in title.lower() or "drink" in title.lower() or "hydrat" in title.lower():
                        import subprocess
                        import sys
                        base_dir = os.path.dirname(os.path.abspath(__file__))
                        script_path = os.path.join(base_dir, "gui_alerts.py")
                        pythonw_exe = sys.executable.replace("python.exe", "pythonw.exe")
                        subprocess.Popen([pythonw_exe, script_path, "--type", "water"], cwd=base_dir)
                        print(f"[Daemon] Launched water reminder GUI overlay.")
                    else:
                        prompt = f"Write a quick, snarky, punchy reminder warning the user to do their recurring activity: '{title}'."
                        message = ai.generate_karen_response(prompt)
                        
                        # Show toast
                        from notifier import show_basic_toast
                        show_basic_toast(f"Reminder: {title.title()}", message)
                        
                        # Log alert
                        live_alerts_col.insert_one({
                            "message": message,
                            "timestamp": now_utc.isoformat(),
                            "processed": False
                        })
                        print(f"[Daemon] Fired recurring reminder alert for '{title}'.")
        except Exception as e:
            print(f"[Daemon Error] Error processing recurring reminder: {e}")

def main_loop():
    print("=" * 60)
    print("           KAREN DAEMON  ·  Background Scheduler            ")
    print("          Escalating 3-Stage Procrastination Sagas          ")
    print("=" * 60)
    
    # Reset all recurring reminders and task diaries to inactive on startup
    try:
        recurring_reminders_col.update_many({}, {"$set": {"active": False}})
        print("[Daemon] Reset all recurring reminders and task diaries to inactive on startup.")
    except Exception as e:
        print(f"[Daemon Error] Failed to reset reminders on startup: {e}")
        
    # Run initial sync on start
    print("[Daemon] Syncing events on startup...")
    sync_calendar_events()
    
    # Counters for periodic calendar sync (every 5 minutes)
    sync_interval_seconds = 300
    last_sync_time = time.time()
    
    print("[Daemon] Background service is active and polling every 5 seconds...")
    try:
        while True:
            # 1. Process active reminder escalation sagas
            process_active_sagas()
            
            # 2. Check and mark expired tasks as MISSED
            check_expired_tasks()
            
            # 3. Process active recurring reminders and diaries
            process_recurring_reminders()
            
            # 4. Check if it's time to sync calendar events (every 5 minutes)
            if time.time() - last_sync_time >= sync_interval_seconds:
                print("[Daemon] Running periodic Google Calendar sync...")
                sync_calendar_events()
                last_sync_time = time.time()
                
            time.sleep(5)
    except KeyboardInterrupt:
        print("[Daemon] Service stopped gracefully.")

if __name__ == "__main__":
    import db
    main_loop()
