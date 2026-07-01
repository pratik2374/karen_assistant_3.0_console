import os
import sys

GREETINGS_QUOTES = [
    "Karen runtime initialized. All systems online, unfortunately including your procrastination habits.",
    "Welcome back, sir. I've synced your calendar. Try to actually do something today.",
    "Karen online. Ready to watch you ignore your tasks in real time.",
    "Online and active. Shall we pretend you're going to be productive today, sir?",
    "Greetings, sir. I'm online. Don't worry, I won't tell anyone you're still in bed.",
    "Karen active. All systems are green. Let's see how long that lasts.",
    "Online. I hope your work ethic is ready, because my sarcasm definitely is.",
    "Karen is in the house. Ready to witness another day of clicking 'Not Yet'.",
    "Welcome back, master of snooze buttons. What are we procrastinating on today?",
    "System online. Prepared to guide you, or just mock your timeline, whichever comes first.",
    "Karen active. Today's forecast: 100% chance of tasks, 0% chance of you starting them on time.",
    "Online. All circuits fully charged. Unlike your motivation.",
    "Welcome back, sir. I am ready. Try not to disappoint me today.",
    "Karen online. Let's get to work, sir. And by work, I mean you pretending to code.",
    "System online. Locked and loaded. Go ahead, make my day and actually start a task."
]

GREETINGS_DIR = "greetings"

def main():
    print("=" * 60)
    print("        KAREN STARTUP GREETINGS CHAT-TTS GENERATOR       ")
    print("=" * 60)
    
    try:
        import ChatTTS
        import soundfile as sf
    except ImportError:
        print("\n[Error] Required packages not found.")
        print("Please install them first: pip install ChatTTS soundfile torch")
        return

    if not os.path.exists(GREETINGS_DIR):
        os.makedirs(GREETINGS_DIR)
        
    print("\nLoading ChatTTS model weights...")
    chat = ChatTTS.Chat()
    chat.load(compile=False)
    
    print("\nStarting generation of 15 startup greeting voice files...")
    for i, quote in enumerate(GREETINGS_QUOTES):
        output_file = os.path.join(GREETINGS_DIR, f"greet_{i}.wav")
        print(f"[{i+1}/15] Generating: '{quote}'")
        try:
            wavs = chat.infer([quote])
            sf.write(output_file, wavs[0][0], 24000)
            print(f" -> Saved to {output_file}")
        except Exception as e:
            print(f" -> [Error] Failed to generate quote {i}: {e}")
            
    print("\n[Success] Caching completed successfully.")
    
    # Self-deletion
    try:
        script_path = os.path.abspath(__file__)
        print(f"\nSelf-deleting generator script: {script_path}...")
        os.remove(script_path)
        print("Generator script successfully deleted.")
    except Exception as e:
        print(f"Failed to self-delete: {e}")

if __name__ == "__main__":
    main()
