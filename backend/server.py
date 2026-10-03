"""
Command Pilot — Standalone FastAPI Server
Lightweight WebSocket server for the Command Pilot Electron app.

Usage:
    python server.py
    → Starts on http://127.0.0.1:8765
"""

import os
import re
import sys
import json
import time
import asyncio

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# --- PATH SETUP (Portable) ---
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if _BASE_DIR not in sys.path:
    sys.path.insert(0, _BASE_DIR)

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import uvicorn

from pilot_engine import CommandPilotEngine
from browser_vision_agent import BrowserVisionAgent
import keys_manager

# Ensure configured keys are loaded into environment at startup
keys_manager.load_all_keys()


# ─────────────────────────────────────────────────────────────────────────────
# App Setup
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(title="Click", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─────────────────────────────────────────────────────────────────────────────
# WebSocket Connection Manager
# ─────────────────────────────────────────────────────────────────────────────

class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        print(f"✅ Client connected. Total: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        print(f"🔌 Client disconnected. Total: {len(self.active_connections)}")

    async def broadcast(self, message: dict):
        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                disconnected.append(connection)
        for conn in disconnected:
            self.disconnect(conn)


manager = ConnectionManager()

# ─────────────────────────────────────────────────────────────────────────────
# Command Pilot Engine Instance
# ─────────────────────────────────────────────────────────────────────────────

async def engine_callback(msg_type: str, payload):
    """Bridge between sync engine and async WebSocket broadcasts."""
    if msg_type == "status":
        await manager.broadcast({"type": "status", "payload": payload})
    elif msg_type == "response":
        await manager.broadcast({"type": "response", "payload": payload})
    elif msg_type == "action":
        await manager.broadcast({"action": payload})
    elif msg_type == "log":
        await manager.broadcast({"type": "log", "payload": payload})
    else:
        await manager.broadcast({"type": msg_type, "payload": payload})


engine = CommandPilotEngine(callback=engine_callback)
browser_vision_agent = BrowserVisionAgent()

# ─────────────────────────────────────────────────────────────────────────────
# Static Demo Mount (SIH Benchmark Pages)
# ─────────────────────────────────────────────────────────────────────────────
_demo_dir = os.path.join(_BASE_DIR, "static", "demo")

@app.get("/demo/checkout")
async def demo_checkout():
    return FileResponse(os.path.join(_demo_dir, "checkout.html"))

@app.get("/demo/banking")
async def demo_banking():
    return FileResponse(os.path.join(_demo_dir, "banking.html"))

@app.get("/demo/social")
async def demo_social():
    return FileResponse(os.path.join(_demo_dir, "social.html"))

@app.get("/demo/privacy_test")
async def demo_privacy_test():
    return FileResponse(os.path.join(_demo_dir, "privacy_test.html"))

if os.path.exists(_demo_dir):
    app.mount("/demo", StaticFiles(directory=_demo_dir, html=True), name="demo")

# ─────────────────────────────────────────────────────────────────────────────
# REST Endpoints
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return {
        "status": "online",
        "name": "Click",
        "version": "2.0.0",
        "model": browser_vision_agent.model,
        "demo_suite": "/demo"
    }


@app.get("/api/adv_settings")
async def get_settings():
    """Return pilot settings (used by Electron for always-on-top etc.)."""
    return JSONResponse(content=engine.get_settings())


@app.post("/api/adv_settings")
async def update_settings(data: dict):
    """Update a setting."""
    for key, value in data.items():
        engine.update_setting(key, value)
    return {"status": "ok"}


@app.get("/api/shutdown")
@app.post("/api/shutdown")
async def shutdown_server():
    """Cleanly shut down the backend server."""
    print("🛑 Received shutdown request. Exiting Click backend...")
    asyncio.get_event_loop().call_later(0.15, lambda: os._exit(0))
    return {"status": "shutting_down"}


# ── UNIFIED CHATS PERSISTENCE ────────────────────────────────────────────────
_CHATS_FILE = os.path.join(_BASE_DIR, "..", "chats.json")

@app.get("/api/chats")
async def get_chats():
    """Get unified previous chats history."""
    if os.path.exists(_CHATS_FILE):
        try:
            with open(_CHATS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                return JSONResponse(content=data)
        except Exception as e:
            print(f"⚠️ Error reading chats.json: {e}")
    return JSONResponse(content={"chats": [], "active_chat_id": None})


@app.post("/api/chats")
async def save_chats_endpoint(data: dict):
    """Save unified previous chats history."""
    try:
        with open(_CHATS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"⚠️ Error saving chats.json: {e}")
    return {"status": "ok"}


# ── SECURE KEYS & DATA RESET API ─────────────────────────────────────────────

@app.get("/api/keys/status")
async def get_keys_status_endpoint():
    """Check configuration status of API keys with safe masked previews."""
    return JSONResponse(content=keys_manager.get_keys_status())


@app.post("/api/keys/save")
async def save_keys_endpoint(data: dict):
    """
    Save and resolve API keys (either direct key string or env var name).
    Dynamically propagates to os.environ and updates active agent engines.
    """
    res = keys_manager.save_api_keys(data)
    if hasattr(browser_vision_agent, "_load_api_keys"):
        browser_vision_agent._load_api_keys()
    if hasattr(engine, "vision_agent") and hasattr(engine.vision_agent, "_load_api_keys"):
        engine.vision_agent._load_api_keys()
    return JSONResponse(content=res)


@app.post("/api/reset-data")
async def reset_data_endpoint(data: dict = None):
    """Factory reset: wipes chats, stored keys, and temp files."""
    clear_chats = True
    clear_keys = True
    if data and isinstance(data, dict):
        clear_chats = data.get("clear_chats", True)
        clear_keys = data.get("clear_keys", True)
    res = keys_manager.reset_all_data(clear_chats=clear_chats, clear_keys=clear_keys)
    if hasattr(browser_vision_agent, "_load_api_keys"):
        browser_vision_agent._load_api_keys()
    if hasattr(engine, "vision_agent") and hasattr(engine.vision_agent, "_load_api_keys"):
        engine.vision_agent._load_api_keys()
    return JSONResponse(content=res)



# ─────────────────────────────────────────────────────────────────────────────
# WebSocket Endpoint
# ─────────────────────────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)

    # Set the event loop on the engine so callbacks work from background threads
    engine.loop = asyncio.get_running_loop()

    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
            except json.JSONDecodeError:
                continue

            action = msg.get("action", "")

            # ── COMMAND PILOT TEXT INPUT ──────────────────────────────
            if action == "command_pilot":
                text = msg.get("text", "").strip()
                incoming_history = msg.get("chat_history")
                if incoming_history is not None and engine:
                    engine.command_pilot_history = [
                        {"role": h.get("role", "user"), "content": h.get("content", "")}
                        for h in incoming_history if h.get("content")
                    ]
                if text and engine:
                    print(f"📨 Received: {text}")
                    loop = asyncio.get_running_loop()
                    await loop.run_in_executor(None, engine.process_command_pilot, text)

            # ── MIC TOGGLE ───────────────────────────────────────────
            elif action == "toggle_mic":
                state = msg.get("state", False)
                if engine:
                    engine.input_mode = "command_pilot" if state else None
                    engine.toggle_listening(state)

            # ── SETTINGS REQUEST ─────────────────────────────────────
            elif action == "get_settings":
                await websocket.send_json({
                    "type": "adv_settings_full",
                    "settings": engine.get_settings()
                })

            # ── UPDATE SETTING ───────────────────────────────────────
            elif action == "update_setting":
                key = msg.get("key", "")
                value = msg.get("value", "")
                if key:
                    engine.update_setting(key, value)
                    await websocket.send_json({
                        "type": "adv_setting_ack",
                        "key": key,
                        "value": value
                    })

            # ── CLEAR HISTORY (new chat) ─────────────────────────────
            elif action == "clear_history":
                if engine:
                    engine.command_pilot_history = []
                    if hasattr(engine, 'nvidia_vision') and engine.nvidia_vision:
                        engine.nvidia_vision._task_active = False
                    engine.stop_listening_flag = True
                    print("🗑️ Chat history cleared and active tasks stopped (new chat)")

            # ── SET HISTORY (switch chat) ────────────────────────────
            elif action == "set_history":
                if engine:
                    history = msg.get("history", [])
                    engine.command_pilot_history = [
                        {"role": h["role"], "content": h["content"]}
                        for h in history
                    ]
                    print(f"🔄 Chat history set ({len(history)} messages)")

            # ── STOP AGENT ───────────────────────────────────────────
            elif action == "stop_agent":
                if engine:
                    # Stop vision agent if running
                    if hasattr(engine, 'nvidia_vision') and engine.nvidia_vision:
                        engine.nvidia_vision._task_active = False
                    # Stop listening if active
                    engine.stop_listening_flag = True
                    print("🛑 Agent stopped by user")
                    await manager.broadcast(json.dumps({
                        "type": "status",
                        "payload": "ONLINE"
                    }))

            # ── UNKNOWN ──────────────────────────────────────────────
            else:
                print(f"⚠️ Unknown action: {action}")

    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        print(f"WebSocket Error: {e}")
        manager.disconnect(websocket)


# ─────────────────────────────────────────────────────────────────────────────
# PrivaPilot Browser Agent WebSocket (SIH26171)
# ─────────────────────────────────────────────────────────────────────────────

# ── PERSISTENT BROWSER SESSIONS (Module-Level) ──────────────────────────────
BROWSER_AGENT_SESSIONS: dict[str, dict] = {}


@app.websocket("/ws/browser_agent")
async def browser_agent_ws(websocket: WebSocket):
    """
    WebSocket endpoint for the Chrome/Firefox Extension.
    Receives ONLY sanitized, privacy-redacted visual frames and DOM snapshots.
    Dispatches tool calls (click, type, scroll, navigate, etc.) back to browser.
    """
    await websocket.accept()
    print("🌐 [PrivaPilot] Browser extension connected to /ws/browser_agent")
    active_chat_id = "default"

    try:
        while True:
            raw_text = await websocket.receive_text()
            try:
                data = json.loads(raw_text)
            except json.JSONDecodeError:
                continue

            msg_type = data.get("type", "")

            try:
                # Heartbeat ping
                if msg_type == "ping":
                    await websocket.send_json({"type": "pong", "timestamp": time.time()})

                # Extension requests next action with sanitized frame
                elif msg_type == "step_context":
                    step_recv_t0 = time.perf_counter()
                    goal = data.get("goal", "").strip()
                    sanitized_img = data.get("sanitized_image")  # base64 redacted JPEG/PNG
                    dom_elements = data.get("dom_elements", [])
                    viewport = data.get("viewport")
                    url = data.get("url", "")
                    title = data.get("title", "")
                    console_logs = data.get("console_logs", [])

                    chat_id = data.get("chat_id") or active_chat_id or "default"
                    active_chat_id = chat_id

                    if chat_id not in BROWSER_AGENT_SESSIONS:
                        BROWSER_AGENT_SESSIONS[chat_id] = {
                            "history": [],
                            "completed_tasks": [],
                            "chat_history": [],
                            "current_goal": goal
                        }
                    session = BROWSER_AGENT_SESSIONS[chat_id]

                    # Detect new task starting in the same chat
                    incoming_step = data.get("step", 1)
                    if incoming_step == 1 or session.get("current_goal") != goal:
                        session["history"] = []
                        session["current_goal"] = goal

                    history = session["history"]
                    incoming_chat_history = data.get("chat_history")
                    if incoming_chat_history:
                        session["chat_history"] = incoming_chat_history

                    chat_history = session.get("chat_history", [])
                    completed_tasks = session.get("completed_tasks", [])

                    step_idx = incoming_step

                    img_size_kb = round(len(sanitized_img) * 3 / 4 / 1024) if sanitized_img else 0
                    print(f"👁️ [PrivaPilot] Step {step_idx} (Chat: {active_chat_id}): Goal='{goal[:45]}' | "
                          f"Image: {img_size_kb}KB | DOM: {len(dom_elements)} elements")

                    # Run model reasoning in worker thread
                    vlm_t0 = time.perf_counter()
                    loop = asyncio.get_running_loop()
                    decision = await loop.run_in_executor(
                        None,
                        browser_vision_agent.plan_next_action,
                        goal,
                        sanitized_img,
                        dom_elements,
                        history,
                        url,
                        title,
                        console_logs,
                        viewport,
                        data.get("max_steps", 40),
                        data.get("user_clarification"),
                        data.get("open_tabs") or None,
                        data.get("page_text", ""),
                        chat_history,
                        completed_tasks
                    )
                    vlm_elapsed_ms = round((time.perf_counter() - vlm_t0) * 1000)

                    tool_name = decision.get("tool", "wait")
                    args = decision.get("args", {})
                    thought = decision.get("thought", "")

                    if tool_name == "finish_task":
                        summary = args.get("summary") or thought or "Task completed."
                        extracted_data = args.get("data")
                        task_record = {"goal": goal, "summary": summary}
                        if extracted_data:
                            task_record["data"] = extracted_data
                        session.setdefault("completed_tasks", []).append(task_record)

                    print(f"🤖 [PrivaPilot] Decision: tool='{tool_name}' args={args} | Thought: {thought[:60]}...")

                    # Resolve click or scroll coordinates for action grounding overlay
                    click_coords = None
                    scroll_coords = None
                    if tool_name == "click":
                        if "coordinates" in args and isinstance(args["coordinates"], (list, tuple)) and len(args["coordinates"]) >= 2:
                            try:
                                click_coords = [int(args["coordinates"][0]), int(args["coordinates"][1])]
                            except (ValueError, TypeError):
                                pass
                        if not click_coords and "selector" in args:
                            target_sel = str(args["selector"]).strip()
                            for el in dom_elements:
                                sel = el.get("selector", "")
                                el_id = el.get("id", "")
                                priva_id = el.get("privaId", "")
                                if sel == target_sel or (el_id and f"#{el_id}" == target_sel) or (priva_id and f"[data-priva-id=\"{priva_id}\"]" == target_sel):
                                    r = el.get("rect", {})
                                    if r:
                                        cx = int((r.get("x") or 0) + (r.get("width") or 0) / 2)
                                        cy = int((r.get("y") or 0) + (r.get("height") or 0) / 2)
                                        click_coords = [cx, cy]
                                        break
                        if not click_coords and "text" in args:
                            t_search = str(args["text"]).strip().lower()
                            for el in dom_elements:
                                el_text = (el.get("text") or "").lower()
                                if t_search and (t_search in el_text or el_text in t_search):
                                    r = el.get("rect", {})
                                    if r:
                                        cx = int((r.get("x") or 0) + (r.get("width") or 0) / 2)
                                        cy = int((r.get("y") or 0) + (r.get("height") or 0) / 2)
                                        click_coords = [cx, cy]
                                        break
                        # Element label grounding (p-XX from Set-of-Marks)
                        if not click_coords and "element" in args:
                            import re as _re
                            m = _re.search(r"p-(\d+)", str(args["element"]))
                            if m:
                                target_sel = f'[data-priva-id="p-{m.group(1)}"]'
                                for el in dom_elements:
                                    if el.get("selector") == target_sel:
                                        r = el.get("rect", {})
                                        if r:
                                            cx = int((r.get("x") or 0) + (r.get("width") or 0) / 2)
                                            cy = int((r.get("y") or 0) + (r.get("height") or 0) / 2)
                                            click_coords = [cx, cy]
                                            break
                    elif tool_name == "scroll":
                        if "coordinates" in args and isinstance(args["coordinates"], (list, tuple)) and len(args["coordinates"]) >= 2:
                            try:
                                scroll_coords = [int(args["coordinates"][0]), int(args["coordinates"][1])]
                            except (ValueError, TypeError):
                                pass
                        if not scroll_coords and "selector" in args:
                            target_sel = str(args["selector"]).strip()
                            for el in dom_elements:
                                sel = el.get("selector", "")
                                el_id = el.get("id", "")
                                priva_id = el.get("privaId", "")
                                if sel == target_sel or (el_id and f"#{el_id}" == target_sel) or (priva_id and f"[data-priva-id=\"{priva_id}\"]" == target_sel):
                                    r = el.get("rect", {})
                                    if r:
                                        cx = int((r.get("x") or 0) + (r.get("width") or 0) / 2)
                                        cy = int((r.get("y") or 0) + (r.get("height") or 0) / 2)
                                        scroll_coords = [cx, cy]
                                        break
                        if not scroll_coords:
                            scroll_coords = [640, 400]

                    elif tool_name == "drag":
                        if "from_coordinates" in args and isinstance(args["from_coordinates"], (list, tuple)) and len(args["from_coordinates"]) >= 2:
                            try:
                                click_coords = [int(args["from_coordinates"][0]), int(args["from_coordinates"][1])]
                            except (ValueError, TypeError):
                                pass

                    # Record in session history with sanitized image for multi-frame visual context
                    history.append({
                        "step": step_idx,
                        "thought": thought,
                        "tool": tool_name,
                        "args": args,
                        "url": url,
                        "viewport": viewport,
                        "click_coords": click_coords,
                        "scroll_coords": scroll_coords,
                        "sanitized_image": sanitized_img,
                        "remaining_subtasks": decision.get("remaining_subtasks") or []
                    })

                    # Prune old images beyond the visual history window to keep memory lean
                    keep_visual_turns = max(6, browser_vision_agent.visual_history_turns + 2)
                    if len(history) > keep_visual_turns:
                        for old_h in history[:-keep_visual_turns]:
                            if "sanitized_image" in old_h:
                                old_h["sanitized_image"] = None

                    # Send tool execution command to extension and bridge with chat_id
                    await websocket.send_json({
                        "type": "tool_call",
                        "step": step_idx,
                        "chat_id": chat_id,
                        "decision": decision
                    })

                    total_server_ms = round((time.perf_counter() - step_recv_t0) * 1000)
                    print(f"⏱️ [PrivaPilot] Server Step {step_idx} Timing: VLM API={vlm_elapsed_ms}ms | Total server={total_server_ms}ms")

                # Extension reports tool execution outcome
                elif msg_type == "tool_result":
                    step_idx = data.get("step")
                    success = data.get("success", True)
                    result_str = str(data.get("result") or "")
                    effect = data.get("effect")
                    reported_click_coords = data.get("click_coords")
                    reported_scroll_coords = data.get("scroll_coords")
                    if not reported_click_coords and not reported_scroll_coords and result_str:
                        m = re.search(r"@\((\d+),\s*(\d+)\)", result_str)
                        if m:
                            c = [int(m.group(1)), int(m.group(2))]
                            if history and history[-1].get("tool") == "click":
                                reported_click_coords = c
                            elif history and history[-1].get("tool") == "scroll":
                                reported_scroll_coords = c

                    print(f"✅ [PrivaPilot] Tool result (step {step_idx}): success={success}, effect={effect}, info={result_str[:80]}")
                    # Defensive error formatting: prefix ERROR on failed results
                    if not success and result_str and not result_str[:6].upper().startswith("ERROR"):
                        result_str = "ERROR: " + result_str
                    if history:
                        # P1-5: Only update the matching history entry (prevents out-of-order/duplicate corruption)
                        if step_idx is not None and history[-1].get("step") != step_idx:
                            print(f"⚠️ [PrivaPilot] Ignoring tool_result for step {step_idx} (expected step {history[-1].get('step')})")
                        else:
                            history[-1]["result"] = result_str
                            history[-1]["success"] = success
                            if effect:
                                history[-1]["effect"] = effect
                            if reported_click_coords:
                                history[-1]["click_coords"] = reported_click_coords
                            if reported_scroll_coords:
                                history[-1]["scroll_coords"] = reported_scroll_coords

                    await websocket.send_json({
                        "type": "tool_ack",
                        "step": step_idx,
                        "status": "ready_for_next_step"
                    })

                # Clear/Reset session
                elif msg_type == "reset_session":
                    target_chat = data.get("chat_id")
                    if target_chat and target_chat in BROWSER_AGENT_SESSIONS:
                        BROWSER_AGENT_SESSIONS[target_chat] = {"history": [], "completed_tasks": [], "chat_history": [], "current_goal": ""}
                    else:
                        BROWSER_AGENT_SESSIONS.clear()
                    print(f"🔄 [PrivaPilot] Task history cleared (chat: {target_chat or 'all'})")
                    await websocket.send_json({"type": "session_cleared", "chat_id": target_chat})

                elif msg_type == "start_task":
                    chat_id = data.get("chat_id") or active_chat_id or "default"
                    goal = data.get("goal", "").strip()
                    incoming_chat_history = data.get("chat_history") or []

                    # If starting a new chat or switching chats, initialize session if not present
                    if chat_id not in BROWSER_AGENT_SESSIONS:
                        BROWSER_AGENT_SESSIONS[chat_id] = {
                            "history": [],
                            "completed_tasks": [],
                            "chat_history": [],
                            "current_goal": goal
                        }
                    active_chat_id = chat_id

                    session = BROWSER_AGENT_SESSIONS[active_chat_id]
                    session["history"] = []
                    session["current_goal"] = goal
                    if incoming_chat_history:
                        session["chat_history"] = incoming_chat_history

                    print(f"🚀 [PrivaPilot] Task Start received (chat: {active_chat_id}): {goal}")
                    await websocket.send_json({
                        "type": "task_started",
                        "goal": goal,
                        "chat_id": active_chat_id
                    })

                elif msg_type == "stop_task":
                    target_chat = data.get("chat_id") or active_chat_id
                    print(f"🛑 [PrivaPilot] Task Stop received (chat: {target_chat})")
                    await websocket.send_json({"type": "task_stopped", "chat_id": target_chat})

            except Exception as step_err:
                import traceback
                print(f"⚠️ [PrivaPilot] Error processing '{msg_type}': {step_err}")
                traceback.print_exc()
                if msg_type == "step_context":
                    step_idx = data.get("step", len(history) + 1)
                    recovery_decision = {
                        "thought": "Transient server error during action planning. Pausing briefly to recover state.",
                        "tool": "wait",
                        "args": {"seconds": 2.5},
                        "error": str(step_err)
                    }
                    try:
                        await websocket.send_json({
                            "type": "tool_call",
                            "step": step_idx,
                            "decision": recovery_decision
                        })
                    except Exception:
                        pass

    except WebSocketDisconnect:
        print("🔌 [PrivaPilot] Browser extension disconnected")
    except Exception as e:
        print(f"⚠️ [PrivaPilot] Fatal WebSocket loop error: {e}")


# ─────────────────────────────────────────────────────────────────────────────
# Startup
# ─────────────────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup():
    print("=" * 50)
    print("  🚀 CLICK — Standalone Server")
    print("  📡 http://127.0.0.1:8765")
    print("  🔌 WebSocket: ws://127.0.0.1:8765/ws")
    print("=" * 50)


if __name__ == "__main__":
    uvicorn.run(
        "server:app",
        host="127.0.0.1",
        port=8765,
        reload=False,
        log_level="info"
    )
