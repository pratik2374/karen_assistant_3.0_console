"""
proactive_agent.py - Background Polling for Smart Features
Currently handles:
- Email polling (checking for new important emails every X minutes).
"""

import os
import time
import json
from datetime import datetime
from db import live_alerts_col, activity_logs_col
from email_service import fetch_new_emails
from system_commander import see_screen

def run_proactive_checks():
    """Main loop for proactive checks. Should be run in a background thread."""
    email_interval = int(os.getenv("EMAIL_CHECK_INTERVAL_MINUTES", "30"))
    email_interval_seconds = email_interval * 60
    snapshot_interval_seconds = int(os.getenv("SNAPSHOT_INTERVAL_SECONDS", "3600"))
    
    last_email_check = 0
    last_snapshot_check = 0
    
    print(f"[Proactive Agent] Started background polling loop. Email interval: {email_interval} mins. Snapshot interval: {snapshot_interval_seconds} secs.")
    
    while True:
        now = time.time()
        
        # Check Emails
        if now - last_email_check >= email_interval_seconds:
            print("[Proactive Agent] Polling emails...")
            try:
                important_emails = fetch_new_emails()
                if important_emails:
                    # Format the live alert dynamically based on email count
                    if len(important_emails) <= 3:
                        alert_text = f"Hey, you have {len(important_emails)} new important emails. "
                        for e in important_emails:
                            acc = e.get("account", "")
                            acc_name = "college mail" if acc == "123103006@nitkkr.ac.in" else acc
                            sender = e.get("sender", "Unknown")
                            if "<" in sender:
                                sender = sender.split("<")[0].strip()
                            summary = e.get("actionable_summary", "No summary.")
                            alert_text += f"One from {sender} on your {acc_name}: {summary} "
                    else:
                        acc_counts = {}
                        for e in important_emails:
                            acc = e.get("account", "")
                            acc = "college mail" if acc == "123103006@nitkkr.ac.in" else acc
                            acc_counts[acc] = acc_counts.get(acc, 0) + 1
                            
                        alert_text = f"Hey, you have {len(important_emails)} new important emails. "
                        alert_text += ", ".join([f"{count} on {acc}" for acc, count in acc_counts.items()]) + ". "
                        alert_text += "Ask me to read them to you for the full details."
                    
                    # Store the actual emails in the database so Karen can read them instantly
                    from db import live_alerts_col, recent_emails_col
                    
                    recent_emails_col.update_one(
                        {"_id": "latest_batch"},
                        {"$set": {"emails": important_emails, "timestamp": datetime.now().isoformat()}},
                        upsert=True
                    )
                    
                    # Insert into live alerts so the CLI speaks it
                    live_alerts_col.insert_one({
                        "message": alert_text,
                        "created_at": datetime.now().isoformat(),
                        "processed": False
                    })
                    print(f"[Proactive Agent] Inserted alert for {len(important_emails)} emails.")
            except Exception as e:
                print(f"[Proactive Agent] Error checking emails: {e}")
                
            last_email_check = time.time()
            
        # Check Screen Activity (Hourly)
        if now - last_snapshot_check >= snapshot_interval_seconds:
            print("[Proactive Agent] Taking hourly screen snapshot for activity logging & relational checks...")
            try:
                # Capture and extract context
                vision_prompt = "Describe exactly what the user is doing on their computer right now based on this screenshot. Be concise. Focus on applications open, productivity level, and specific topics being viewed."
                response_text = see_screen(vision_prompt)
                
                if response_text and not response_text.startswith("Error"):
                    activity_description = response_text.strip()
                    
                    activity_logs_col.insert_one({
                        "timestamp": datetime.now().isoformat(),
                        "activity_description": activity_description
                    })
                    print(f"[Proactive Agent] Activity logged: {activity_description[:50]}...")
                    
                    # Pass the description to Karen's brain to decide if she wants to react
                    try:
                        from ai import get_karen_reaction_to_screen
                        reaction = get_karen_reaction_to_screen(activity_description)
                        
                        speak = reaction.get("speak", False)
                        message = reaction.get("message", "")
                        mood = reaction.get("mood", "neutral")
                        respect_delta = reaction.get("respect_delta", 0)
                        
                        if respect_delta != 0:
                            from db import karen_state_col
                            state_doc = karen_state_col.find_one({"_id": "respect_score"})
                            current = state_doc.get("score", 100) if state_doc else 100
                            new_score = max(0, min(100, current + respect_delta))
                            karen_state_col.update_one({"_id": "respect_score"}, {"$set": {"score": new_score}}, upsert=True)
                            print(f"[Proactive Agent] Respect score adjusted by {respect_delta}. New score: {new_score}/100")
                        
                        if speak and message:
                            # Trigger live voice alert
                            live_alerts_col.insert_one({
                                "message": message,
                                "mood": mood,
                                "created_at": datetime.now().isoformat(),
                                "processed": False
                            })
                            print(f"[Proactive Agent] Spontaneous Initiation triggered: {message} ({mood})")
                            
                    except Exception as e:
                        print(f"[Proactive Agent] Error getting Karen's reaction: {e}")
                else:
                    print(f"[Proactive Agent] Failed to capture or analyze screen: {response_text}")
            except Exception as e:
                print(f"[Proactive Agent] Error during screen snapshot: {e}")
                
            last_snapshot_check = time.time()
            
        # Check Relational Gifts/Consoling (Randomized 1 to 5 hours)
        if not hasattr(run_proactive_checks, 'next_relational_interval'):
            import random
            run_proactive_checks.next_relational_interval = random.uniform(1.0, 5.0) * 3600

        if now - getattr(run_proactive_checks, 'last_relational_check', 0) >= getattr(run_proactive_checks, 'next_relational_interval'):
            import random
            hours_waited = getattr(run_proactive_checks, 'next_relational_interval') / 3600
            print(f"[Proactive Agent] Running deep Relational Check (after waiting {hours_waited:.2f} hours)...")
            try:
                from ai import get_karen_orchestrator
                karen = get_karen_orchestrator()
                # Run a background relational prompt
                relational_prompt = (
                    "BACKGROUND RELATIONAL CHECK: "
                    "Use read_activity_logs to review the user's recent activity logs. "
                    "If they have been working extremely hard, autonomously use send_email to send them a sweet, encouraging 'gift' email, or use your calendar tools to schedule a 'Mandatory Break'. "
                    "If they seem stressed, send a consoling message. "
                    "ALSO, use read_codex to check their long-term ambitions (e.g. 'placement'). "
                    "If they have a massive goal they are struggling with, YOU MUST autonomously use launch_swarm_task to spin up the Groq Swarm to start researching or finding resources for them right now in the background! "
                    "Then, send a live alert (or just output text) saying: 'Sir, I noticed you are grinding for X, so I spontaneously spun up the Swarm to start researching Y for you.' "
                    "If they are just normal or wasting time, do nothing. "
                    "Do not ask for permission, just do it if warranted."
                )
                # Run the orchestrator silently
                karen.run(relational_prompt)
                print("[Proactive Agent] Relational check complete.")
            except Exception as e:
                print(f"[Proactive Agent] Error during relational check: {e}")
                
            run_proactive_checks.last_relational_check = time.time()
            run_proactive_checks.next_relational_interval = random.uniform(1.0, 5.0) * 3600
            print(f"[Proactive Agent] Next relational check randomly scheduled for {run_proactive_checks.next_relational_interval / 3600:.2f} hours from now.")
            
        time.sleep(10) # Base tick rate

if __name__ == "__main__":
    run_proactive_checks()
