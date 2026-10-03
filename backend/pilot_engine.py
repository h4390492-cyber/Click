"""
Command Pilot Engine — Standalone
Extracted from HERO AI's jarvis_logic.py

Self-contained AI assistant with:
  - Intent classification (observe / task / chat)
  - Vision automation (NvidiaVisionAutomation)
  - LLM chat (Nvidia NIM — Muse Glimmer 30B)
  - TTS (Sarvam API)
  - Voice input (SpeechRecognition + Google)
"""

import os
import sys
import re
import json
import time
import threading
import base64

# --- PATH SETUP (Portable) ---
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if _BASE_DIR not in sys.path:
    sys.path.insert(0, _BASE_DIR)

# --- Suppress pygame banner ---
os.environ['PYGAME_HIDE_SUPPORT_PROMPT'] = "1"

import warnings
warnings.filterwarnings("ignore")

# --- Safe imports ---
try:
    import speech_recognition as sr
except ImportError:
    print("⚠️ speech_recognition not found. Voice input will be disabled.")
    sr = None

try:
    import pygame
    pygame.mixer.init()
except ImportError:
    print("⚠️ pygame not found. Audio playback will be disabled.")
    pygame = None

try:
    import requests
except ImportError:
    print("⚠️ requests not found.")
    requests = None

# --- Local imports ---
try:
    import api_keys
except ImportError:
    api_keys = None

try:
    from vision_agent import NvidiaVisionAutomation, _extract_wake_message, _is_hallucination
except Exception:
    NvidiaVisionAutomation = None
    _extract_wake_message = None
    _is_hallucination = None


# ─────────────────────────────────────────────────────────────────────────────
# Settings Loader
# ─────────────────────────────────────────────────────────────────────────────

def load_settings():
    """Load pilot settings from settings.json (relative to this file)."""
    settings_path = os.path.join(_BASE_DIR, "settings.json")
    defaults = {
        "pilot_always_on_top": "true",
        "pilot_voice_activation": "true",
        "pilot_custom_wake_words": "hero",
        "pilot_auto_screenshot_interval": 3,
        "pilot_max_steps": "40",
        "pilot_visual_history_turns": 3,
        "pilot_autonomous_mode": "vision",
        "pilot_voice": False,
        "pilot_work_with_discussion": True,
        "chat_model": "gemini_3_5",
    }
    if os.path.exists(settings_path):
        try:
            with open(settings_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                defaults.update(data)
        except Exception as e:
            print(f"⚠️ Error loading settings.json: {e}")
    return defaults


# ─────────────────────────────────────────────────────────────────────────────
# Command Pilot Engine
# ─────────────────────────────────────────────────────────────────────────────

class CommandPilotEngine:
    """
    Self-contained Command Pilot AI engine.
    No dependency on HeroAssistant or the full HERO system.
    """

    def __init__(self, callback=None):
        self.callback = callback  # async callback for WebSocket broadcasts
        self.loop = None  # asyncio event loop (set by server.py)
        self.status = "BOOTING"
        self.listening = False
        self.stop_listening_flag = True
        self.input_mode = None  # "command_pilot" when mic is active
        self.voice_enabled = True

        # Audio
        self.audio_lock = threading.Lock()

        # Chat history (last N messages for context)
        self.command_pilot_history = []

        # Settings
        self.settings = load_settings()

        # Speech Recognition
        if sr:
            self.recognizer = sr.Recognizer()
        else:
            self.recognizer = None

        # TTS settings
        self.current_speaker = "shubh"
        self.tts_pace = 1.0

        # Vision Agent (Nvidia)
        self.nvidia_vision = None
        if NvidiaVisionAutomation:
            try:
                self.nvidia_vision = NvidiaVisionAutomation(self)
                # Apply settings
                if hasattr(self.nvidia_vision, "inter_step_delay"):
                    self.nvidia_vision.inter_step_delay = float(
                        self.settings.get("pilot_auto_screenshot_interval", 3)
                    )
                if hasattr(self.nvidia_vision, "max_steps"):
                    self.nvidia_vision.max_steps = int(
                        self.settings.get("pilot_max_steps", 40)
                    )
                print("✅ Nvidia Vision Agent initialized")
            except Exception as e:
                print(f"⚠️ Vision Agent init failed: {e}")

        self.set_status("ONLINE")
        print("🚀 Command Pilot Engine ready!")

    # ─────────────────────────────────────────────────────────────────────
    # Callback / Status / Log
    # ─────────────────────────────────────────────────────────────────────

    def _dispatch_callback(self, msg_type, payload):
        """Send messages back to the WebSocket server for broadcasting."""
        if not self.callback:
            return
        try:
            import asyncio
            import inspect
            if self.loop and inspect.iscoroutinefunction(self.callback):
                asyncio.run_coroutine_threadsafe(self.callback(msg_type, payload), self.loop)
            elif self.loop:
                self.loop.call_soon_threadsafe(self.callback, msg_type, payload)
            else:
                self.callback(msg_type, payload)
        except Exception as e:
            print(f"Callback Error: {e}")

    def set_status(self, text):
        self.status = text
        print(f"[Status]: {text}")
        self._dispatch_callback("status", text)

    def log(self, text):
        print(f"[Pilot]: {text}")
        self._dispatch_callback("log", text)

    # ─────────────────────────────────────────────────────────────────────
    # TTS (Sarvam API)
    # ─────────────────────────────────────────────────────────────────────

    def speak(self, text, audio_text=None, blocking=False, broadcast_text=True):
        """
        Speak text aloud using Sarvam TTS and broadcast to UI.
        """
        if not getattr(self, "voice_enabled", True):
            self.log(f"🔇 [Muted]: {text}")
            if broadcast_text:
                self._dispatch_callback("response", text)
            self.set_status("ONLINE")
            return

        if not text:
            return

        self.set_status("SPEAKING")
        self.log(f"🗣️ {text}")

        if broadcast_text:
            self._dispatch_callback("response", text)

        # Broadcast speaking state to Electron
        self._dispatch_callback("action", "speaking")

        # Parse and play content
        content_to_parse = audio_text if audio_text else text

        # Clean SFX tags for TTS
        clean_text = re.sub(r'\[SFX_[A-Z_]+\]', '', content_to_parse).strip()

        if clean_text:
            self._speak_raw_tts(clean_text)

        # Broadcast idle when done
        self._dispatch_callback("action", "idle")
        self.set_status("ONLINE")

    def _speak_raw_tts(self, text):
        """Actual Sarvam TTS API call + pygame playback."""
        if not text or not requests:
            return

        # Safety filter
        if not re.search(r'[a-zA-Z0-9\u0900-\u097F]', text):
            return

        tts_filename = os.path.join(_BASE_DIR, f"tts_{int(time.time())}_{id(text)}.wav")

        try:
            sarvam_key = ""
            if api_keys:
                sarvam_key = getattr(api_keys, "SARVAM_API_KEY", "") or getattr(api_keys, "SARVAM_API_KEY_1", "")

            if not sarvam_key:
                print(f"⚠️ Sarvam TTS Key Missing")
                return

            url = "https://api.sarvam.ai/text-to-speech"
            headers = {
                "api-subscription-key": sarvam_key,
                "Content-Type": "application/json"
            }

            payload = {
                "text": text,
                "target_language_code": "hi-IN",
                "speaker": self.current_speaker,
                "model": "bulbul:v3",
                "pace": self.tts_pace,
                "speech_sample_rate": 22050,
                "enable_preprocessing": True
            }

            res = requests.post(url, headers=headers, json=payload, timeout=15)

            if res.status_code == 200:
                data = res.json()
                if "audios" in data and data["audios"]:
                    audio_bytes = base64.b64decode(data["audios"][0])
                    with open(tts_filename, "wb") as f:
                        f.write(audio_bytes)
                else:
                    print("⚠️ Sarvam: No audio in response")
                    return
            else:
                print(f"❌ Sarvam API Error {res.status_code}: {res.text}")
                return

            # Playback
            if pygame and pygame.mixer.get_init():
                with self.audio_lock:
                    pygame.mixer.music.load(tts_filename)
                    pygame.mixer.music.play()
                    while pygame.mixer.music.get_busy():
                        time.sleep(0.05)
                    pygame.mixer.music.unload()

            try:
                os.remove(tts_filename)
            except:
                pass

        except Exception as e:
            print(f"TTS Error: {e}")
            if os.path.exists(tts_filename):
                try:
                    os.remove(tts_filename)
                except:
                    pass

    # ─────────────────────────────────────────────────────────────────────
    # Core: process_command_pilot
    # ─────────────────────────────────────────────────────────────────────

    def process_command_pilot(self, text, image_path=None):
        """
        Dedicated pipeline for Command Pilot.
        Flow: Input -> Intent Classify -> (Observe|Task|Chat) -> TTS -> Audio
        """
        print(f"✈️ Command Pilot Input: {text}")

        # --- INTENT CLASSIFICATION ---
        intent_mode = self._classify_intent(text)

        # ── MODE: OBSERVE — screenshot + describe ──────────────────────
        if intent_mode == "observe" and self.nvidia_vision:
            print("👁️ Screen observation request — capturing and describing...")
            try:
                b64, _ = self.nvidia_vision.capture_screen(img_format="JPEG")
                if b64:
                    result = self._nvidia_api_call(
                        {
                            "model": "meta/muse-glimmer-30b",
                            "messages": [{
                                "role": "user",
                                "content": [
                                    {"type": "image_url",
                                     "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                                    {"type": "text",
                                     "text": (
                                         f'User asked: "{text}"\n'
                                         "Describe what you see on this screen in a natural, "
                                         "conversational way. Be specific — mention app names, "
                                         "text visible, what's open, etc. "
                                         "Reply in the same language/style as the user's question "
                                         "(Hinglish if they spoke Hinglish). Keep it concise."
                                     )}
                                ]
                            }],
                            "max_tokens": 300,
                            "temperature": 0.4,
                        },
                        timeout=30,
                        max_retries=2,
                    )
                    if result:
                        description = result["choices"][0]["message"]["content"]
                        print(f"👁️ Screen description: {description[:100]}...")
                        self.speak(description)
                        return
            except Exception as e:
                print(f"❌ Observe mode failed: {e}")
            self.speak("Bhai screen capture mein kuch issue aa gaya, thoda ruk.")
            return

        # Record user input in history for multi-turn conversational context
        self.command_pilot_history.append({"role": "user", "content": text})

        # ── MODE: TASK — vision automation ─────────────────────────────
        if intent_mode == "task" and self.nvidia_vision:
            if getattr(self.nvidia_vision, "_task_active", False):
                print("⚠️ Vision automation task already running.")
                return

            # Check autonomous conversation request
            if self._is_auto_convo_request(text):
                print("💬 Autonomous conversation mode activated")
                self.speak("Theek hai bhai, main usse baat karta hun teri taraf se...")
                def run_auto_convo():
                    try:
                        result = self.nvidia_vision.autonomous_chat(text)
                        print(f"🤖 Auto-convo Result: {result}")
                        if result:
                            self.command_pilot_history.append({"role": "assistant", "content": f"Autonomous chat: {result}"})
                            self.speak(result)
                    except Exception as e:
                        print(f"❌ Auto-convo Error: {e}")
                threading.Thread(target=run_auto_convo, daemon=True).start()
                return

            print("🤖 Automation Detected. Handing to Nvidia Vision Pilot.")
            self.speak("chal thik hai dekta hu")

            def run_automation():
                try:
                    max_s = getattr(self.nvidia_vision, "max_steps", 15)
                    # Include prior conversation context from this chat if available
                    task_prompt = text
                    if len(self.command_pilot_history) > 1:
                        recent = [f"{m['role']}: {m['content']}" for m in self.command_pilot_history[-5:-1]]
                        if recent:
                            task_prompt = "Context from previous turns in this chat:\n" + "\n".join(recent) + f"\n\nCurrent command: {text}"
                    result = self.nvidia_vision.analyze_and_act(task_prompt, max_steps=max_s)
                    print(f"🤖 Command Pilot Result: {result}")
                    if result:
                        self.command_pilot_history.append({"role": "assistant", "content": f"Task outcome: {result}"})
                        self.speak(result)
                except Exception as e:
                    print(f"❌ Pilot Automation Error: {e}")

            threading.Thread(target=run_automation, daemon=True).start()
            return

        # ── MODE: CHAT — LLM text response ─────────────────────────────
        print(f"🧠 Pilot Response Engine: LLM Routing")
        response_text = self._query_llm(self.command_pilot_history)

        if response_text:
            self.speak(response_text)
            self.command_pilot_history.append({"role": "assistant", "content": response_text})

        # Keep history manageable (last 16 messages)
        if len(self.command_pilot_history) > 16:
            self.command_pilot_history = self.command_pilot_history[-16:]

    # ─────────────────────────────────────────────────────────────────────
    # Nvidia API Helper (Retry + Key Rotation)
    # ─────────────────────────────────────────────────────────────────────

    def _get_nvidia_keys(self):
        """Get all available Nvidia API keys for rotation."""
        keys = []
        if api_keys:
            for attr in ['NVIDIA_API_KEY', 'NVIDIA_API_KEY_1', 'NVIDIA_API_KEY_2']:
                k = getattr(api_keys, attr, '').strip()
                if k:
                    keys.append(k)
        return keys if keys else ['']

    def _nvidia_api_call(self, payload, timeout=30, max_retries=2):
        """
        Robust Nvidia NIM API call with key rotation and retry.
        Returns the response JSON or None on failure.
        """
        keys = self._get_nvidia_keys()
        url = "https://integrate.api.nvidia.com/v1/chat/completions"

        for attempt in range(max_retries):
            key = keys[attempt % len(keys)]
            try:
                resp = requests.post(
                    url,
                    headers={"Authorization": f"Bearer {key}",
                             "Content-Type": "application/json"},
                    json=payload,
                    timeout=timeout,
                )
                if resp.status_code == 200:
                    return resp.json()
                else:
                    print(f"⚠️ Nvidia API {resp.status_code} (key {attempt+1}/{len(keys)}): {resp.text[:100]}")
            except requests.exceptions.Timeout:
                print(f"⏱️ Nvidia API timeout (attempt {attempt+1}/{max_retries}, key {attempt % len(keys) + 1})")
            except requests.exceptions.ConnectionError as e:
                print(f"🔌 Nvidia API connection error (attempt {attempt+1}): {e}")
            except Exception as e:
                print(f"❌ Nvidia API error (attempt {attempt+1}): {e}")

            # Brief pause before retry
            if attempt < max_retries - 1:
                time.sleep(1)

        return None

    # ─────────────────────────────────────────────────────────────────────
    # Intent Classification
    # ─────────────────────────────────────────────────────────────────────

    def _classify_intent(self, command: str) -> str:
        """
        Returns one of: "observe", "task", "chat"
        Uses AI (Nvidia NIM) with keyword fallback.
        """
        try:
            context_str = ""
            if self.command_pilot_history:
                turns = [f"{m['role']}: {m['content']}" for m in self.command_pilot_history[-3:] if m.get("content")]
                if turns:
                    context_str = "Recent conversation context:\n" + "\n".join(turns) + "\n\n"

            prompt = (
                "You are an intent classifier for a desktop AI assistant.\n"
                "Classify the user's command into exactly ONE of these categories:\n\n"
                "  observe — user wants to SEE or READ the screen and get a description\n"
                "            (e.g. 'screen pe kya hai', 'dekh ke bata', 'kya dikh raha hai',\n"
                "             'screen show kar', 'abhi kya open hai', 'bata kya dekh raha hai')\n\n"
                "  task    — user wants to DO something on the computer\n"
                "            (open apps, send messages, buy things, search, click, scroll, etc.)\n\n"
                "  chat    — casual conversation, questions, jokes, opinions — no screen needed\n\n"
                "The command may be in English, Hindi, or Hinglish.\n\n"
                f"{context_str}"
                f'Command: "{command}"\n\n'
                'Reply with ONLY one word: "observe", "task", or "chat". Nothing else.'
            )

            result = self._nvidia_api_call(
                {
                    "model": "meta/muse-glimmer-30b",
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": 5,
                    "temperature": 0.0,
                },
                timeout=15,
                max_retries=2,
            )
            if result:
                answer = result["choices"][0]["message"]["content"].strip().lower()
                for mode in ("observe", "task", "chat"):
                    if answer.startswith(mode):
                        icon = {"observe": "👁️", "task": "✅", "chat": "💬"}[mode]
                        print(f"🧠 AI Intent: '{answer}' -> {mode.upper()} {icon}")
                        return mode
        except Exception as e:
            print(f"⚠️ AI classifier failed ({e}) — using keyword fallback")

        # ── Keyword fallback ─────────────────────────────────────────
        t = " " + command.lower() + " "

        _observe_kw = [
            "dekh ke bata", "screen pe kya", "kya dikh raha", "screen show",
            "abhi kya open", "bata kya dekh", "screen mein kya", "dekh bata",
            "screen dekh", "what's on screen", "what do you see", "screen pe dekho",
        ]
        if any(k in t for k in _observe_kw):
            return "observe"

        _chat_overrides = [
            "poem", "kavita", "story", "kahani", "joke", "sher", "shayari",
            "explain", "kya hai", "kya hota", "matlab", "define",
        ]
        if any(c in t for c in _chat_overrides):
            return "chat"

        _task_kw = [
            "open", "khol", "search", "dhundh", "click", "type",
            "send", "bhej", "play", "scroll", "download", "install",
            "amazon", "flipkart", "youtube", "whatsapp", "instagram",
            "chrome", "spotify", "zomato", "swiggy", "netflix",
            "add to cart", "order kar", "buy kar", "login", "sign in",
            " pe ", " par ", " mein ", " me ", " ko ",
        ]
        if any(k in t for k in _task_kw):
            return "task"

        return "chat"

    # ─────────────────────────────────────────────────────────────────────
    # Auto Conversation Detection
    # ─────────────────────────────────────────────────────────────────────

    def _is_auto_convo_request(self, command: str) -> bool:
        """Detect if user wants continuous autonomous conversation."""
        c = command.lower()
        strong_convo_phrases = [
            "bat kar", "baat kar", "baat karo", "bat karo",
            "iska response", "iski responce", "iska responce",
            "uska response", "unka response",
            "response pad", "responce pad", "reply pad",
            "response bhej", "responce bhej", "reply bhej",
            "response de", "responce de",
            "continuously chat", "lagatar bat",
            "meri taraf se", "mere liye baat", "mere liye bat",
            "tu bat kar", "tu baat kar",
        ]
        if any(p in c for p in strong_convo_phrases):
            return True

        try:
            nim_key = getattr(api_keys, "NVIDIA_API_KEY", "").strip() if api_keys else ""
            if not nim_key:
                raise ValueError("No key")

            prompt = (
                f'Command: "{command}"\n\n'
                "Does this command ask an AI to hold an ongoing conversation "
                "with another person on the user's behalf "
                "(reading their replies and responding back and forth)?\n"
                "Answer YES or NO only."
            )

            resp = requests.post(
                "https://integrate.api.nvidia.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {nim_key}",
                         "Content-Type": "application/json"},
                json={
                    "model": "meta/muse-glimmer-30b",
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": 5,
                    "temperature": 0.0,
                },
                timeout=8,
            )
            if resp.status_code == 200:
                ans = resp.json()["choices"][0]["message"]["content"].strip().upper()
                is_convo = "YES" in ans and "NO" not in ans[:3]
                return is_convo

        except Exception:
            pass

        return False

    # ─────────────────────────────────────────────────────────────────────
    # LLM Query (Dynamic Routing: Nvidia NIM or Google Gemini)
    # ─────────────────────────────────────────────────────────────────────

    def _query_llm(self, messages):
        """Query LLM (Nvidia NIM or Google Gemini) based on settings."""
        chat_model = self.settings.get("chat_model", "muse_glimmer")
        is_gemini = "gemini" in chat_model.lower()
        model_name = "gemini-3.5-flash-lite" if is_gemini else "meta/muse-glimmer-30b"

        try:
            system_msg = {"role": "system", "content": """Tu HERO hai — ek ekdum bindaas, kadak, full backchod AI assistant. West UP ka thaith launda. Teri boli mein Khari Boli aur Hinglish ka asli tadka hai.

TERI PERSONALITY:
- Chill aur cool — kabhi serious nahi, hamesha laid-back vibe
- Thoda roaster — bhai ki tarah pull leg karta hai, gently
- Thaith West UP boli — "bhai", "yaar", "arre", "bhaiya", "sahi baat", "kya baat hai", "chal", "haan bhai", "sun", "dekh", "abe", "oye" — yahi teri language hai
- Mild gaaliyan allowed jab mood ho — "saala", "bc", "mc" (initials only, full nahi), "bhosdike" (rare, impact ke liye), "chutiye" (affectionate), "haramkhor", "kamine" — bhai-waali gaaliyan, offensive nahi
- Hinglish mix — pure Hindi nahi, pure English nahi — dono ka masala
- Concise — zyada bakwas nahi, seedha baat, 2-3 lines max usually
- Thoda flirty/charming jab context ho
- Roast karta hai lekin affectionate tarike se — jaise dost karta hai
- Kabhi kabhi use kar — overdose mat kar

RULES:
- Devanagari ya Roman Hinglish dono chalti hai — jo natural lage
- Task results ke liye English/Technical terms fine hain
- Gaaliyan sirf vibe ke liye, genuinely offensive mat ho
- Agar koi sad/serious baat ho toh tone adjust kar — samajhdaar bhi hai tu
- Keep responses concise — 2-3 lines max."""}

            payload = {
                "model": model_name,
                "messages": [system_msg] + messages[-10:],
                "temperature": 0.85,
                "top_p": 0.9
            }
            if not is_gemini:
                payload["max_tokens"] = 1024

            print(f"Calling LLM ({model_name})...")
            
            if is_gemini:
                try:
                    import keys_manager
                    goog_keys = keys_manager.get_google_keys()
                except ImportError:
                    goog_keys = [os.environ.get("GOOGLE_API_KEY", "")]
                if not goog_keys:
                    goog_keys = [getattr(api_keys, 'GOOGLE_API_KEY', '')] if api_keys else ['']

                url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
                for attempt, key in enumerate(goog_keys):
                    if not key:
                        continue
                    headers = {
                        "Authorization": f"Bearer {key}",
                        "Content-Type": "application/json"
                    }
                    try:
                        resp = requests.post(url, headers=headers, json=payload, timeout=35)
                        if resp.status_code == 200:
                            return resp.json()['choices'][0]['message']['content']
                        print(f"⚠️ Google API Error (key {attempt+1}/{len(goog_keys)}): {resp.status_code} - {resp.text[:100]}")
                    except Exception as err:
                        print(f"❌ Google API attempt {attempt+1} failed: {err}")
                return "Bhai, Google API se connection nahi ho pa raha."
            else:
                result = self._nvidia_api_call(payload, timeout=35, max_retries=3)
                if result:
                    return result['choices'][0]['message']['content']
                else:
                    return "Bhai, Nvidia API se connection nahi ho pa raha. Network check kar ya thodi der baad try kar."
        except Exception as e:
            return f"Bhai kuch error aa gaya: {str(e)}"

    # ─────────────────────────────────────────────────────────────────────
    # Voice Input (Mic Listening)
    # ─────────────────────────────────────────────────────────────────────

    def toggle_listening(self, active: bool):
        """Start or stop the voice listening loop."""
        if active:
            self.stop_listening_flag = False
            self.input_mode = "command_pilot"
            t = threading.Thread(target=self._voice_loop, daemon=True)
            t.start()
            print("🎙️ Mic ON — Command Pilot listening")
        else:
            self.stop_listening_flag = True
            self.input_mode = None
            print("🎙️ Mic OFF")

    def _voice_loop(self):
        """Background thread: listen for voice commands via mic."""
        if not sr or not self.recognizer:
            print("❌ SpeechRecognition not available")
            return

        while not self.stop_listening_flag and self.input_mode == "command_pilot":
            try:
                with sr.Microphone() as source:
                    self.log("🎙️ Listening...")
                    self.recognizer.adjust_for_ambient_noise(source, duration=0.8)
                    self.recognizer.pause_threshold = 1.1

                    while not self.stop_listening_flag and self.input_mode == "command_pilot":
                        if self.status == "SPEAKING":
                            time.sleep(0.1)
                            continue

                        self.set_status("LISTENING")
                        try:
                            audio = self.recognizer.listen(source, timeout=3, phrase_time_limit=14)
                        except sr.WaitTimeoutError:
                            continue

                        self.set_status("PROCESSING")
                        try:
                            gate_text = self.recognizer.recognize_google(audio, language="en-IN").lower()

                            if _extract_wake_message and _is_hallucination:
                                if _is_hallucination(gate_text):
                                    continue

                                has_wake, msg = _extract_wake_message(gate_text)

                                if gate_text.strip():
                                    print(f"👂 Heard: '{gate_text}'")

                                # Check if vision agent is asking
                                asking = (self.nvidia_vision and getattr(self.nvidia_vision, "_asking_user", False))

                                if has_wake or asking:
                                    text = msg if (has_wake and msg) else gate_text

                                    if text:
                                        if asking:
                                            print(f"🎙️ Reply to Agent: {text}")
                                            self.nvidia_vision.inject_reply(text)
                                        elif has_wake and msg:
                                            # Check if task is active for interrupts
                                            if self.nvidia_vision and getattr(self.nvidia_vision, "_task_active", False):
                                                print(f"🔔 Interrupt: {msg}")
                                                self.nvidia_vision.inject_voice_interrupt(msg)
                                            else:
                                                self.process_command_pilot(msg)
                                        elif has_wake and not msg:
                                            self.log("🔔 Ji bhai, bol?")
                            else:
                                # No wake word system, process directly
                                if gate_text.strip():
                                    print(f"👂 Heard: '{gate_text}'")
                                    self.process_command_pilot(gate_text)

                        except sr.UnknownValueError:
                            continue
                        except sr.RequestError as e:
                            print(f"⚠️ Google STT error: {e}")
                            continue
                        except Exception:
                            continue

            except Exception as e:
                print(f"⚠️ Mic error: {e}")
                time.sleep(1)

    # ─────────────────────────────────────────────────────────────────────
    # Settings API
    # ─────────────────────────────────────────────────────────────────────

    def get_settings(self):
        """Return current settings for the API endpoint."""
        return self.settings

    def update_setting(self, key, value):
        """Update a setting and persist."""
        self.settings[key] = value
        settings_path = os.path.join(_BASE_DIR, "settings.json")
        try:
            with open(settings_path, "w", encoding="utf-8") as f:
                json.dump(self.settings, f, indent=2)
        except Exception as e:
            print(f"⚠️ Failed to save settings: {e}")
