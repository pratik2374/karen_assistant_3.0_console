"""
system_commander.py — Shell Execution & Vision System

Handles:
1. Shell Execution: Running PowerShell commands and returning output.
2. Vision System: Capturing screenshots and analyzing them using Groq API.
"""

import os
import subprocess
import base64
from PIL import ImageGrab
from groq import Groq

def run_shell_command(command: str) -> str:
    """
    Executes a shell command (using PowerShell on Windows) and returns the output.
    
    Args:
        command (str): The command to execute.
    """
    print(f"[System Commander] Running command: {command}")
    try:
        # Run the command with a 15-second timeout to prevent hanging
        result = subprocess.run(
            ["powershell", "-Command", command],
            capture_output=True,
            text=True,
            timeout=15
        )
        
        output = result.stdout.strip()
        error = result.stderr.strip()
        
        if result.returncode == 0:
            if not output:
                return "Command executed successfully with no output."
            # Truncate output if it's too long for the LLM
            if len(output) > 3000:
                return output[:3000] + "\n...[Output truncated due to length]"
            return output
        else:
            return f"Command failed with error:\n{error}"
            
    except subprocess.TimeoutExpired:
        return "Command timed out after 15 seconds."
    except Exception as e:
        return f"Failed to execute command: {e}"

def _take_screenshot(filepath: str = "temp_screenshot.jpg") -> str:
    """Takes a screenshot of the primary monitor and saves it to disk."""
    try:
        screenshot = ImageGrab.grab()
        # Resize slightly to stay within API limits and reduce payload size
        screenshot.thumbnail((1920, 1080))
        screenshot.save(filepath, format="JPEG", quality=85)
        return filepath
    except Exception as e:
        print(f"[Vision Error] Failed to take screenshot: {e}")
        return None

def _encode_image(image_path: str) -> str:
    """Encodes an image to a base64 string."""
    with open(image_path, "rb") as image_file:
        return base64.b64encode(image_file.read()).decode('utf-8')

def see_screen(question: str = "Describe what you see on my screen in detail.") -> str:
    """
    Takes a screenshot of the user's current screen and asks the Groq vision model to answer a question about it.
    
    Args:
        question (str): The question to ask about the screen (e.g. "What code am I looking at?", "Read this error").
    """
    print(f"[Vision] Taking screenshot and asking: '{question}'")
    
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        return "Error: GROQ_API_KEY is not set in the environment variables."
        
    image_path = _take_screenshot()
    if not image_path:
        return "Error: Failed to capture the screen."
        
    try:
        base64_image = _encode_image(image_path)
        
        client = Groq(api_key=api_key)
        completion = client.chat.completions.create(
            model="meta-llama/llama-4-scout-17b-16e-instruct",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": question},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{base64_image}",
                            },
                        },
                    ],
                }
            ],
            temperature=0.5,
            max_tokens=1024,
        )
        
        # Clean up temp screenshot
        try:
            os.remove(image_path)
        except:
            pass
            
        return completion.choices[0].message.content
        
    except Exception as e:
        return f"Vision processing failed: {e}"
