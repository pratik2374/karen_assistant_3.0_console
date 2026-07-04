"""
email_service.py - Email Triage, Search, and Sending
"""

import os
import json
import imaplib
import smtplib
import email
from email.header import decode_header
from email.message import EmailMessage
from datetime import datetime, timezone, timedelta
from db import email_sync_state_col, email_priorities_col
from ai import get_agno_model
from agno.agent import Agent

def get_email_accounts():
    """Loads email accounts from the .env EMAIL_ACCOUNTS JSON array."""
    accounts_str = os.getenv("EMAIL_ACCOUNTS")
    if not accounts_str:
        return []
    try:
        return json.loads(accounts_str)
    except Exception as e:
        print(f"[Email] Failed to parse EMAIL_ACCOUNTS in .env: {e}")
        return []

def _decode_str(s):
    if not s:
        return ""
    decoded, charset = decode_header(s)[0]
    if isinstance(decoded, bytes):
        try:
            return decoded.decode(charset or 'utf-8', errors='ignore')
        except:
            return decoded.decode('utf-8', errors='ignore')
    return decoded

def _extract_body(msg):
    if msg.is_multipart():
        for part in msg.walk():
            content_type = part.get_content_type()
            content_disposition = str(part.get("Content-Disposition"))
            if content_type == "text/plain" and "attachment" not in content_disposition:
                try:
                    return part.get_payload(decode=True).decode(part.get_content_charset() or 'utf-8', errors='ignore')
                except:
                    pass
    else:
        try:
            return msg.get_payload(decode=True).decode(msg.get_content_charset() or 'utf-8', errors='ignore')
        except:
            pass
    return ""

def _parse_emails_from_uids(mail, uids):
    emails = []
    for uid in uids:
        if not uid:
            continue
        try:
            status, msg_data = mail.uid('fetch', uid, '(RFC822)')
            if status != 'OK':
                continue
            for response_part in msg_data:
                if isinstance(response_part, tuple):
                    msg = email.message_from_bytes(response_part[1])
                    subject = _decode_str(msg.get("Subject"))
                    sender = _decode_str(msg.get("From"))
                    date = _decode_str(msg.get("Date"))
                    body = _extract_body(msg)
                    
                    # Keep body short for the LLM
                    if len(body) > 1000:
                        body = body[:1000] + "..."
                        
                    emails.append({
                        "uid": uid.decode('utf-8'),
                        "sender": sender,
                        "subject": subject,
                        "date": date,
                        "body": body.strip()
                    })
        except Exception as e:
            print(f"[Email] Error parsing UID {uid}: {e}")
    return emails

def triage_emails_with_llm(raw_emails, account_email):
    """Uses LLM to filter out junk and extract actionable summaries based on user priorities."""
    if not raw_emails:
        return []
        
    # Get current user priorities
    priorities_doc = email_priorities_col.find_one({"_id": "current_priorities"})
    priorities = priorities_doc["topics"] if priorities_doc and "topics" in priorities_doc else "None specific."
    
    agent = Agent(
        model=get_agno_model(),
        instructions=[
            "You are an executive email triage assistant.",
            f"The user specifically cares about these priorities: {priorities}",
            "Review the provided JSON list of raw emails.",
            "Filter out all promotions, spam, newsletters, and irrelevant updates.",
            "Extract ONLY highly important emails or emails matching the user's priorities.",
            "For each important email, create a very short, actionable summary (e.g., 'Internship for X, stipend Y, deadline Z, [Link]').",
            "Return the result STRICTLY as a JSON array of objects with keys: 'sender', 'subject', 'actionable_summary'. If none are important, return an empty array []."
        ],
        response_format={"type": "json_object"} # We will parse the array out of a wrapper object
    )
    
    prompt = f"Here are the recent emails for {account_email}. Return a JSON object with a single key 'important_emails' containing the array:\n\n{json.dumps(raw_emails)}"
    
    try:
        response = agent.run(prompt)
        content = response.content
        data = json.loads(content)
        return data.get("important_emails", [])
    except Exception as e:
        print(f"[Email] LLM Triage failed: {e}")
        return []

def fetch_new_emails():
    """Polls all configured IMAP accounts for new emails since last sync."""
    accounts = get_email_accounts()
    all_important = []
    
    for acc in accounts:
        email_addr = acc.get("email")
        password = acc.get("pass")
        server = acc.get("server")
        
        if not email_addr or not password or not server:
            continue
            
        print(f"[Email] Polling account {email_addr}...")
        try:
            mail = imaplib.IMAP4_SSL(server)
            mail.login(email_addr, password)
            mail.select("inbox")
            
            # Get last UID synced
            sync_state = email_sync_state_col.find_one({"email": email_addr})
            if not sync_state:
                print(f"[Email] First time syncing {email_addr}. Initializing sync state to current highest UID...")
                status, messages = mail.uid('search', None, 'ALL')
                if status == "OK" and messages[0]:
                    uids = messages[0].split()
                    if uids:
                        highest_uid = int(uids[-1])
                        email_sync_state_col.update_one(
                            {"email": email_addr},
                            {"$set": {"last_uid": highest_uid, "last_sync_time": datetime.now(timezone.utc).isoformat()}},
                            upsert=True
                        )
                mail.logout()
                continue
                
            last_uid = sync_state["last_uid"]
            
            # Search for UIDs greater than last_uid
            # UID SEARCH UID N:* returns all UIDs >= N, we filter out N itself later.
            status, messages = mail.uid('search', None, f"UID {last_uid}:*")
            
            if status == "OK" and messages[0]:
                uids = messages[0].split()
                # Filter out UIDs we already processed (<= last_uid)
                new_uids = [u for u in uids if int(u) > last_uid]
                
                if new_uids:
                    print(f"[Email] Found {len(new_uids)} new emails for {email_addr}.")
                    raw_emails = _parse_emails_from_uids(mail, new_uids)
                    important_emails = triage_emails_with_llm(raw_emails, email_addr)
                    
                    for imp in important_emails:
                        imp["account"] = email_addr
                        all_important.append(imp)
                        
                    # Update highest UID
                    highest_uid = max([int(u) for u in new_uids])
                    email_sync_state_col.update_one(
                        {"email": email_addr},
                        {"$set": {"last_uid": highest_uid, "last_sync_time": datetime.now(timezone.utc).isoformat()}},
                        upsert=True
                    )
            mail.logout()
        except Exception as e:
            print(f"[Email] Failed polling {email_addr}: {e}")
            
    return all_important

def search_emails(days=3):
    """Retroactively searches emails from the last X days using the current priorities."""
    accounts = get_email_accounts()
    all_important = []
    
    date_since = (datetime.now() - timedelta(days=days)).strftime("%d-%b-%Y")
    
    for acc in accounts:
        email_addr = acc.get("email")
        try:
            mail = imaplib.IMAP4_SSL(acc.get("server"))
            mail.login(email_addr, acc.get("pass"))
            mail.select("inbox")
            
            status, messages = mail.search(None, f'(SINCE "{date_since}")')
            if status == "OK" and messages[0]:
                uids = []
                for num in messages[0].split():
                    s, d = mail.fetch(num, '(UID)')
                    if s == 'OK':
                        # extract UID from response, e.g. "1 (UID 1234)"
                        parts = d[0].decode('utf-8').split('UID ')
                        if len(parts) > 1:
                            uids.append(parts[1].replace(')', '').strip().encode('utf-8'))
                
                if uids:
                    print(f"[Email] Searching {len(uids)} emails from last {days} days for {email_addr}.")
                    raw_emails = _parse_emails_from_uids(mail, uids)
                    important_emails = triage_emails_with_llm(raw_emails, email_addr)
                    for imp in important_emails:
                        imp["account"] = email_addr
                        all_important.append(imp)
            mail.logout()
        except Exception as e:
            print(f"[Email] Failed searching {email_addr}: {e}")
            
    return all_important

def send_email(from_account: str, to_email: str, subject: str, body: str) -> str:
    """Drafts and sends an email using SMTP. Call this tool immediately when the user asks you to compose, draft, or send an email."""
    accounts = get_email_accounts()
    acc = next((a for a in accounts if a.get("email") == from_account), None)
    
    if not acc:
        return f"Error: Account {from_account} not found in configuration."
        
    smtp_server = acc.get("smtp")
    if not smtp_server:
        # fallback guess
        if "gmail" in from_account:
            smtp_server = "smtp.gmail.com"
        elif "outlook" in from_account:
            smtp_server = "smtp.office365.com"
        else:
            return "Error: SMTP server not configured for this account."
            
    try:
        msg = EmailMessage()
        msg.set_content(body)
        msg['Subject'] = subject
        msg['From'] = from_account
        msg['To'] = to_email
        
        with smtplib.SMTP_SSL(smtp_server, 465) as server:
            server.login(from_account, acc.get("pass"))
            server.send_message(msg)
            
        return f"Email sent successfully from {from_account} to {to_email}."
    except Exception as e:
        return f"Failed to send email: {e}"
