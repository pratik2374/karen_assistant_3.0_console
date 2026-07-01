from win11toast import toast

def show_escalation_toast(title: str, message: str, task_id: str):
    """Triggers a native Windows Toast notification containing interactive 'Started' and 'Not Yet' buttons."""
    buttons = [
        {
            "activationType": "protocol",
            "arguments": f"karen://action?name=started&task_id={task_id}",
            "content": "Started"
        },
        {
            "activationType": "protocol",
            "arguments": f"karen://action?name=not_yet&task_id={task_id}",
            "content": "Not Yet"
        }
    ]

    try:
        toast(
            title=title,
            body=message,
            buttons=buttons,
            app_id="Karen Assistant"
        )
        print(f"[Notifier] Dispatched actionable escalation toast for task {task_id}.")
    except Exception as e:
        print(f"[Notifier] Error sending interactive toast: {e}")

def show_basic_toast(title: str, message: str):
    """Triggers a simple native Windows Toast notification without buttons."""
    try:
        toast(
            title=title,
            body=message,
            app_id="Karen Assistant"
        )
        print(f"[Notifier] Dispatched basic toast: {title} - {message}")
    except Exception as e:
        print(f"[Notifier] Error sending basic toast: {e}")

if __name__ == "__main__":
    # Test notification
    print("Sending test actionable toast...")
    show_escalation_toast("Test Actionable Notification", "Click a button to verify protocol callbacks", "test-task-123")
