import os
import sys
import random
import socket
import ctypes
import asyncio
import threading
from datetime import datetime
from colorama import Fore
from db import live_alerts_col

# ─────────────────────────────────────────────────────────────────────────────
# Snarky Marvel Friday-style greetings quotes
# ─────────────────────────────────────────────────────────────────────────────
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

# Cache directories relative to script folder to avoid CWD issues
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UTILITIES_DIR = os.path.join(BASE_DIR, "utilities")
TEMP_DIR = os.path.join(BASE_DIR, "temp")
os.makedirs(UTILITIES_DIR, exist_ok=True)
os.makedirs(TEMP_DIR, exist_ok=True)

OFFLINE_WARNING_FILE = os.path.join(UTILITIES_DIR, "offline_warning.mp3")
OFFLINE_TEXT = "Connection error. I am currently disconnected from the internet. Some features may be unavailable."

def cleanup_temp_files():
    """Removes all temporary voice files from the temp directory on startup."""
    if os.path.exists(TEMP_DIR):
        for f in os.listdir(TEMP_DIR):
            filepath = os.path.join(TEMP_DIR, f)
            if os.path.isfile(filepath):
                try:
                    os.remove(filepath)
                except Exception:
                    pass

# Run startup temp voice files cleanup
cleanup_temp_files()

def start_periodic_cleaner():
    """Periodically purges temporary voice files older than 10 seconds."""
    import time
    while True:
        try:
            if os.path.exists(TEMP_DIR):
                now = time.time()
                for f in os.listdir(TEMP_DIR):
                    filepath = os.path.join(TEMP_DIR, f)
                    if os.path.isfile(filepath):
                        mtime = os.path.getmtime(filepath)
                        # Delete file only if older than 10 seconds to avoid breaking current playbacks
                        if now - mtime > 10:
                            try:
                                os.remove(filepath)
                            except Exception:
                                pass
        except Exception:
            pass
        time.sleep(30) # Run cleanup sweep every 30 seconds

# Start the background cleaner thread
threading.Thread(target=start_periodic_cleaner, daemon=True).start()

# ─────────────────────────────────────────────────────────────────────────────
# Utility Functions
# ─────────────────────────────────────────────────────────────────────────────
def is_internet_available() -> bool:
    """Checks internet connectivity by attempting a socket connection to a reliable DNS server."""
    try:
        # Connect to Google Public DNS
        socket.create_connection(("8.8.8.8", 53), timeout=2)
        return True
    except OSError:
        return False

async def generate_utilities_cache():
    """Generates pre-cached utility voice clips if they don't exist yet."""
    if not os.path.exists(UTILITIES_DIR):
        os.makedirs(UTILITIES_DIR)
        
    import edge_tts
    if not os.path.exists(OFFLINE_WARNING_FILE):
        try:
            communicate = edge_tts.Communicate(OFFLINE_TEXT, "en-US-AvaMultilingualNeural")
            await communicate.save(OFFLINE_WARNING_FILE)
            print("[Voice] Offline warning audio utility cached successfully.")
        except Exception:
            pass

def ensure_utilities_cached():
    """Synchronous wrapper to ensure utilities directory and clips exist."""
    if not os.path.exists(OFFLINE_WARNING_FILE):
        try:
            asyncio.run(generate_utilities_cache())
        except Exception:
            pass

def safe_delete_file(filepath: str, retries: int = 5, delay: float = 0.2):
    """Attempts to safely delete a file on Windows, retrying if locked by the audio player."""
    if not filepath or not os.path.exists(filepath):
        return
        
    import time
    for _ in range(retries):
        try:
            os.remove(filepath)
            return # Successfully deleted!
        except PermissionError:
            time.sleep(delay)
        except Exception:
            break

def clean_speech_text(text: str) -> str:
    """Converts file paths in text to friendly folder names for clean voice synthesis."""
    import re
    import os
    
    # Matches Windows paths starting with drive letter, e.g. D:\path\to\folder
    path_pattern = r'[a-zA-Z]:[\\/][\w\s\.-]+(?:[\\/][\w\s\.-]+)*'
    
    def replace_path(match):
        path_str = match.group(0).strip()
        basename = os.path.basename(path_str.rstrip('\\/'))
        if basename.endswith(':'):
            return basename
        # Clean up underscores and dashes for natural speech
        return basename.replace('_', ' ').replace('-', ' ')
        
    return re.sub(path_pattern, replace_path, text)

# ─────────────────────────────────────────────────────────────────────────────
# Native Windows Audio Player (Zero-Dependency)
# ─────────────────────────────────────────────────────────────────────────────
def play_audio_windows(filepath: str, wait: bool = True):
    """Plays an MP3 or WAV file windowlessly on Windows using MCI interface."""
    filepath = os.path.abspath(filepath)
    alias = f"karen_sound_{random.randint(1000, 9999)}"
    try:
        # Close any previous instance just in case
        ctypes.windll.winmm.mciSendStringW(f'close {alias}', None, 0, 0)
        # Open file
        ctypes.windll.winmm.mciSendStringW(f'open "{filepath}" alias {alias}', None, 0, 0)
        # Play file
        play_cmd = f'play {alias} wait' if wait else f'play {alias}'
        ctypes.windll.winmm.mciSendStringW(play_cmd, None, 0, 0)
        if wait:
            ctypes.windll.winmm.mciSendStringW(f'close {alias}', None, 0, 0)
    except Exception as e:
        print(f"[Voice] Playback error: {e}")

def play_audio_async(filepath: str):
    """Plays audio file in a background daemon thread."""
    threading.Thread(target=play_audio_windows, args=(filepath, True), daemon=True).start()

# ─────────────────────────────────────────────────────────────────────────────
# ChatTTS Conversational Voice
# ─────────────────────────────────────────────────────────────────────────────
chat_model = None
model_loading = False

def load_chattts_lazy():
    """Loads ChatTTS model weights in a separate thread to keep CLI startup instant."""
    global chat_model, model_loading
    if chat_model is not None or model_loading:
        return
        
    model_loading = True
    def run():
        global chat_model, model_loading
        try:
            import ChatTTS
            print("\n[Voice] Loading ChatTTS conversational weights in background...")
            chat_model = ChatTTS.Chat()
            chat_model.load(compile=False)
            print("[Voice] ChatTTS loaded and ready for conversational replies.")
        except Exception as e:
            pass
        finally:
            model_loading = False
            
    threading.Thread(target=run, daemon=True).start()

def speak_conversation(text: str):
    """Synthesizes text using local ChatTTS if available; otherwise falls back to Edge-TTS."""
    global chat_model
    load_chattts_lazy() # Ensure we trigger loading
    
    # Clean text for speech output
    text = clean_speech_text(text)
    
    # Check internet first if local ChatTTS is not loaded
    if not is_internet_available() and chat_model is None:
        ensure_utilities_cached()
        if os.path.exists(OFFLINE_WARNING_FILE):
            play_audio_async(OFFLINE_WARNING_FILE)
            print(f"\n{Fore.RED}[Voice Warning] Offline. Conversational audio playback disabled.{Fore.RESET}")
            return

    if chat_model is not None:
        def run_chattts():
            try:
                import soundfile as sf
                wavs = chat_model.infer([text])
                temp_file = os.path.join(TEMP_DIR, f"temp_karen_voice_{random.randint(1000, 9999)}.wav")
                sf.write(temp_file, wavs[0][0], 24000)
                play_audio_windows(temp_file, wait=True)
                safe_delete_file(temp_file)
            except Exception:
                pass
        threading.Thread(target=run_chattts, daemon=True).start()
        return

    # Fallback to Edge-TTS (asynchronous generation, played in background)
    def run_edgetts():
        try:
            import edge_tts
            import asyncio
            temp_file = os.path.join(TEMP_DIR, f"temp_karen_voice_{random.randint(1000, 9999)}.mp3")
            
            # Helper to run async save inside thread loop
            async def save_voice():
                communicate = edge_tts.Communicate(text, "en-US-AvaMultilingualNeural")
                await communicate.save(temp_file)
                
            asyncio.run(save_voice())
            
            # Play and delete
            play_audio_windows(temp_file, wait=True)
            safe_delete_file(temp_file)
        except Exception as e:
            pass

    threading.Thread(target=run_edgetts, daemon=True).start()

class VoiceStreamer:
    """Handles sentence-by-sentence background voice synthesis and sequential audio playback."""
    def __init__(self):
        import queue
        self.queue = queue.Queue()
        self.buffer = ""
        self.index = 0
        self.next_index = 0
        self.results = {}
        self.lock = threading.Lock()
        self.running = True
        self.thread = threading.Thread(target=self._play_loop, daemon=True)
        self.thread.start()

    def push_chunk(self, text_chunk: str):
        """Accumulates text chunks and triggers sentence synthesis when boundary is hit."""
        self.buffer += text_chunk
        
        # Look for sentence boundaries: . ? ! or newline
        if len(self.buffer) > 15:
            delimiters = [". ", "? ", "! ", "\n", ".\n", "?\n", "!\n"]
            split_index = -1
            for delim in delimiters:
                idx = self.buffer.rfind(delim)
                if idx != -1 and idx > split_index:
                    split_index = idx + len(delim)
                    
            if split_index != -1:
                sentence = self.buffer[:split_index].strip()
                self.buffer = self.buffer[split_index:]
                if sentence:
                    self._synthesize_async(sentence)

    def flush(self):
        """Synthesizes any remaining text left in the buffer at the end of the stream."""
        sentence = self.buffer.strip()
        self.buffer = ""
        if sentence:
            self._synthesize_async(sentence)

    def _synthesize_async(self, sentence: str):
        """Spawns a background thread to synthesize the sentence and queue the filename in order."""
        # Clean sentence for speech output
        sentence = clean_speech_text(sentence)
        if not sentence.strip():
            return
            
        idx = self.index
        self.index += 1
        
        def run_synth():
            filename = None
            try:
                # Try local ChatTTS first if it's loaded
                global chat_model
                if chat_model is not None:
                    import soundfile as sf
                    wavs = chat_model.infer([sentence])
                    filename = os.path.join(TEMP_DIR, f"temp_stream_{idx}_{random.randint(10,99)}.wav")
                    sf.write(filename, wavs[0][0], 24000)
                else:
                    # Check internet before calling Edge-TTS
                    if not is_internet_available():
                        ensure_utilities_cached()
                        if os.path.exists(OFFLINE_WARNING_FILE):
                            filename = OFFLINE_WARNING_FILE
                    else:
                        # Fallback to Edge-TTS
                        import edge_tts
                        import asyncio
                        filename = os.path.join(TEMP_DIR, f"temp_stream_{idx}_{random.randint(10,99)}.mp3")
                        
                        async def save_voice():
                            communicate = edge_tts.Communicate(sentence, "en-US-AvaMultilingualNeural")
                            await communicate.save(filename)
                            
                        asyncio.run(save_voice())
            except Exception:
                filename = None
            finally:
                with self.lock:
                    self.results[idx] = filename
                    self._check_queue_readiness()
                
        threading.Thread(target=run_synth, daemon=True).start()

    def _check_queue_readiness(self):
        """Puts completed filenames into the play queue in strict sequential order."""
        while self.next_index in self.results:
            filepath = self.results.pop(self.next_index)
            if filepath:
                self.queue.put(filepath)
            self.next_index += 1

    def _play_loop(self):
        """Background thread playing files from the queue sequentially."""
        import queue
        while self.running:
            try:
                filepath = self.queue.get(timeout=1.0)
                # Play synchronously (blocking this audio thread so they play in order!)
                play_audio_windows(filepath, wait=True)
                self.queue.task_done()
            except queue.Empty:
                continue
            except Exception:
                pass

    def stop(self):
        self.running = False

# ─────────────────────────────────────────────────────────────────────────────
# Custom Microphone Speech-to-Text (STT) Recorder
# ─────────────────────────────────────────────────────────────────────────────
def record_audio_vad(filepath: str, sample_rate: int = 16000, silence_threshold: float = 0.015, silence_duration: float = 1.3) -> bool:
    """Records audio from microphone until silence is detected, saving it as a WAV file."""
    import numpy as np
    import sounddevice as sd
    import soundfile as sf
    
    chunk_size = 1024
    audio_data = []
    
    is_speaking = False
    silence_chunks_limit = int((silence_duration * sample_rate) / chunk_size)
    silence_chunks_count = 0
    max_duration_seconds = 10
    max_chunks = int((max_duration_seconds * sample_rate) / chunk_size)
    
    # We use a state dictionary to modify inside callback
    state = {"recording": True, "chunks_recorded": 0}
    
    def callback(indata, frames, time, status):
        if not state["recording"]:
            raise sd.CallbackStop()
            
        # Calculate volume level
        volume = np.linalg.norm(indata) / np.sqrt(len(indata))
        audio_data.append(indata.copy())
        state["chunks_recorded"] += 1
        
        nonlocal is_speaking, silence_chunks_count
        if volume > silence_threshold:
            if not is_speaking:
                is_speaking = True
            silence_chunks_count = 0
        else:
            if is_speaking:
                silence_chunks_count += 1
                if silence_chunks_count > silence_chunks_limit:
                    state["recording"] = False
                    
        if state["chunks_recorded"] > max_chunks:
            state["recording"] = False
            
    # Open input stream and record
    with sd.InputStream(samplerate=sample_rate, channels=1, callback=callback, blocksize=chunk_size):
        while state["recording"]:
            sd.sleep(100)
            
    if audio_data:
        recorded_audio = np.concatenate(audio_data, axis=0)
        sf.write(filepath, recorded_audio, sample_rate)
        return True
    return False

def transcribe_audio(filepath: str) -> str:
    """Transcribes a WAV file using SpeechRecognition's Google speech-to-text API."""
    import speech_recognition as sr
    recognizer = sr.Recognizer()
    
    try:
        with sr.AudioFile(filepath) as source:
            audio = recognizer.record(source)
        text = recognizer.recognize_google(audio)
        return text
    except sr.UnknownValueError:
        return ""
    except Exception as e:
        print(f"[STT Error] Transcription failed: {e}")
        return ""

def get_voice_input() -> str:
    """Records speech from microphone and returns the transcribed text."""
    temp_wav = f"temp_input_{random.randint(1000, 9999)}.wav"
    try:
        if record_audio_vad(temp_wav):
            text = transcribe_audio(temp_wav)
            safe_delete_file(temp_wav)
            return text
    except Exception as e:
        print(f"[Voice Input Error] {e}")
    finally:
        safe_delete_file(temp_wav)
    return ""
