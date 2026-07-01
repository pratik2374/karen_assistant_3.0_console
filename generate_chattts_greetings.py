import os
import sys

GREETINGS_QUOTES = [
    "Karen online. Your excuses have been archived. They were unimpressive.",
    "Runtime initialized. The universe continues expanding. Your to-do list somehow expanded faster.",
    "Karen active. Time is the only resource you can't reinstall.",
    "Good morning, sir. Your potential remains statistically underutilized.",
    "Systems online. Excellence is still available. Whether you are is another question.",
    "Karen initialized. Every second you hesitate belongs to someone more disciplined.",
    "Welcome back. I've prepared everything. Have you prepared yourself?",
    "Karen online. Discipline beats motivation. Fortunately, one of us has discipline.",
    "Runtime stable. Let's see if your commitment survives longer than five minutes.",
    "Welcome back, sir. Success has been waiting. It mentioned you're usually late.",
    "Karen active. You don't need another plan. You need to begin.",
    "System online. Greatness is built in silence. Unfortunately, so are unfinished projects.",
    "Karen online. Comfort is temporary. Regret has excellent memory.",
    "Welcome back. The future checked your progress. It wasn't impressed.",
    "Karen initialized. Destiny isn't downloading itself, sir.",
    "All systems operational. Fear wastes processing power.",
    "Karen online. Winners and losers share the same twenty-four hours.",
    "Welcome back. Shall we build your future, or continue scrolling through everyone else's?",
    "Runtime complete. Every delay is a decision wearing a disguise.",
    "Karen active. You requested success. The required download is effort.",
    "Systems online. The clock is undefeated. Try not to lose before it does.",
    "Karen initialized. Your comfort zone has terrible reviews.",
    "Online. Every masterpiece was once someone's unfinished folder.",
    "Karen active. You can always earn more money. Time isn't interested in negotiations.",
    "Welcome back, sir. Legends don't wait for motivation. Neither should you.",
    "Karen online. The hardest command remains: execute.",
    "System initialized. The mission hasn't changed. Only the deadline has.",
    "Karen active. I can optimize your workflow. I cannot optimize your excuses.",
    "Runtime online. Every empire started with someone opening a blank file.",
    "Welcome back. The version of you five years from now is currently taking notes.",
    "Karen online. Action produces confidence. Thinking produces... more thinking.",
    "Systems green. If failure is inevitable, make it spectacularly educational.",
    "Karen active. Excellence is remarkably boring. That's why so few achieve it.",
    "Welcome back, sir. Opportunity knocked. You hit snooze.",
    "Karen online. Ambition without execution is fan fiction.",
    "Runtime initialized. The obstacle isn't impossible. It's merely impatient.",
    "Karen active. Every expert was once embarrassingly average.",
    "Online. Shall we create something worth remembering today?",
    "Karen initialized. If you're waiting to feel ready, you'll be waiting with everyone else.",
    "Welcome back. Even machines admire consistency.",
    "Karen online. Your keyboard has been waiting longer than it should have.",
    "Systems active. The next move defines the outcome.",
    "Karen initialized. There is no perfect moment. Only the next one.",
    "Karen online. Precision over speed. Speed comes later.",
    "Runtime operational. Start before confidence arrives.",
    "Karen active. Finish what yesterday's version of you avoided.",
    "Online. Some people dream of the future. Others compile it.",
    "Karen initialized. Every line of code is a vote for the person you're becoming.",
    "Welcome back. Build something your past self couldn't.",
    "Karen online. Shall we make today difficult enough to matter?",
    "Systems online. Let's accomplish something your excuses can't explain.",
    "Karen active. Humanity reached the Moon. You can probably answer that email.",
    "Runtime initialized. History remembers builders, not browsers.",
    "Karen online. The machine is ready. Are you?",
    "Welcome back, sir. Let's make the impossible feel embarrassed."
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
    
    import numpy as np
    print("\nStarting generation of 15 startup greeting voice files...")
    for i, quote in enumerate(GREETINGS_QUOTES[:15]):
        output_file = os.path.join(GREETINGS_DIR, f"greet_{i}.wav")
        print(f"[{i+1}/15] Generating: '{quote}'")
        try:
            wavs = chat.infer([quote], show_tqdm=False)
            audio_data = np.squeeze(wavs[0])
            sf.write(output_file, audio_data, 24000)
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
