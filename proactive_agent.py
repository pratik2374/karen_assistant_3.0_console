"""
proactive_agent.py - Background Polling for Smart Features
Currently handles:
- Email polling (checking for new important emails every X minutes).
"""

import os
import time
import json
from datetime import datetime
from db import live_alerts_col
from email_service import fetch_new_emails

def run_proactive_checks():
    """Main loop for proactive checks. Should be run in a background thread."""
    email_interval = int(os.getenv("EMAIL_CHECK_INTERVAL_MINUTES", "30"))
    email_interval_seconds = email_interval * 60
    
    last_email_check = 0
    
    print(f"[Proactive Agent] Started background polling loop. Email interval: {email_interval} mins.")
    
    while True:
        now = time.time()
        
        # Check Emails
        if now - last_email_check >= email_interval_seconds:
            print("[Proactive Agent] Polling emails...")
            try:
                important_emails = fetch_new_emails()
                if important_emails:
                    # Summarize the count and accounts
                    acc_counts = {}
                    for e in important_emails:
                        acc = e["account"]
                        acc_counts[acc] = acc_counts.get(acc, 0) + 1
                        
                    alert_text = f"Hey, you have {len(important_emails)} new important emails. "
                    alert_text += ", ".join([f"{count} on {acc}" for acc, count in acc_counts.items()]) + "."
                    
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
            
        time.sleep(10) # Base tick rate

if __name__ == "__main__":
    run_proactive_checks()
