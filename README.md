# 🎙️ Karen Assistant - Standalone Python Console & Desktop overlays

Karen Assistant is a premium, Friday-style agentic assistant designed to keep you focused, hydrated, and disciplined. It runs as a dual-component service (an interactive command-line interface and a background scheduler daemon) communicating through MongoDB, and overlays rich, beautiful desktop GUI alerts directly over your active work screen.

---

## 🌟 Key Features

### 1. Interactive Chat Console & Voice Orchestration (`cli.py`)
* **Real-time Streaming**: Visual token-by-token streaming of responses.
* **Dual Input Modes**: Supports standard text input or voice input via speech-to-text.
* **Low-Latency Speech**: Natural vocal speech responses utilizing cached mp3 greetings and dynamic cloud-based text-to-speech.
* **Administrative Commands**: Quick console commands to inspect tasks, manage calendars, and trigger reminders.

### 2. Background Scheduler Daemon (`daemon.py`)
* **Procrastination Saga Escalation**: Tracks scheduled Google Calendar tasks. If tasks are ignored, it triggers a 3-Stage escalating nudge sequence (gentle reminder ➔ disappointed notification ➔ marking as missed).
* **Native Windows Toasts**: Actionable toast notifications with interactive **"Started"** and **"Not Yet"** callbacks to track your task progress.
* **Missed Task Reason Logger**: Tasks marked as missed are tracked. Karen asks why you missed them and stores your responses for long-term review.

### 3. Premium Desktop GUI Overlays (`gui_alerts.py`)
* **💧 Screen-Overlay Water Droplet Splash**: 
  - Opens a transparent window centered on your screen.
  - Animates a smooth falling blue water droplet and ripple splash.
  - Plays triple chimes and speaks witty, short vocal hydration reminders.
  - Window stays open exactly until speech playback is complete, then terminates cleanly.
* **📓 Split-Screen Dark Task Diary**:
  - Centered Pop-up dark notebook check-in form.
  - Splits your screen into two sections: **"WHAT I SHOULD BE DOING"** and **"WHAT I AM DOING"**.
  - Logs timestamps and check-in entries directly to `task_diary.csv`.

---

## 📂 Project Directory Structure

```
karen_assistant/
│
├── cli.py                   # Interactive console interface & slash commands
├── daemon.py                # Background timer scheduler & calendar synchronization
├── gui_alerts.py            # Desktop Tkinter GUI alert overlays (water drops & diaries)
├── voice_service.py         # TTS, STT recorder, and background cleaner daemon
├── db.py                    # MongoDB Atlas cluster driver & collections
├── calendar_service.py      # Google Calendar API integration
├── notifier.py              # Native Windows Toast notifications
│
├── greetings/               # Cached greetings voice MP3s (pre-synthesized)
├── utilities/               # Cached utility warning clips
├── temp/                    # Temporary speech mp3 audio chunks (auto-purged)
│
├── requirements.txt         # Python project dependencies
├── run_karen.bat            # Convenience batch runner script
└── task_diary.csv           # Task check-in logs
```

---

## ⚙️ Prerequisites & Setup

### 1. Install Dependencies
Make sure you are using Python 3.10+ and run:
```bash
pip install -r requirements.txt
```
*(Optional) If you want to use voice microphone input, install voice dependencies:*
```bash
pip install sounddevice SpeechRecognition edge-tts
```

### 2. Configuration (`.env`)
Create a `.env` file in the project root containing your API credentials:
```env
OPENAI_API_KEY="your-openai-api-key"
MONGO_URI="your-mongodb-atlas-connection-string"
```

---

## 🚀 How to Run

For Karen to function fully, both the **Background Daemon** and the **Interactive CLI** must be running simultaneously:

### Step 1: Start the Background Daemon
Runs in the background, checks calendars, schedules escalation sagas, and triggers overlays.
```bash
python daemon.py
```

### Step 2: Start the Chat Console CLI
Launch the terminal client in a separate window to chat and issue commands.
```bash
python cli.py
```

---

## 🛠️ Console Commands

You can run these slash commands directly inside the `karen>` prompt:

* **Hydration reminders**:
  * `/water 30` - Start a recurring hydration reminder every 30 minutes.
  * `/water stop` - Turn off recurring hydration reminders.
* **Task diary check-ins**:
  * `/diary 60` - Activate split-screen task diary checks every 60 minutes.
  * `/diary stop` - Turn off task diary check-ins.
* **Task & Calendar queries**:
  * `/tasks` - Lists active tasks and their status.
  * `/calendar` - Displays calendar events synced from your calendar.
  * `/help` - Displays all available administrative commands.