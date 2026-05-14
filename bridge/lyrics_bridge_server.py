import ctypes
import json
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import pystray
import requests
from PIL import Image

HOST = "127.0.0.1"
PORT = 8974

ROOT_DIR = Path(__file__).resolve().parent
CURRENT_PATH = ROOT_DIR / "lyrics-current.json"

DISCORD_SETTINGS_URL = "https://discord.com/api/v9/users/@me/settings"
DISCORD_TOKEN = ""

STATUS_COOLDOWN_SECONDS = 1

STATE = {
    "payload": None,
    "displayed_line": "",
    "last_sent_status": "",
    "last_status_time": 0,
    "active": True,
    "console_visible": True,
}

server = None


def get_console_window():
    return ctypes.windll.kernel32.GetConsoleWindow()


def hide_console():
    hwnd = get_console_window()
    if hwnd:
        ctypes.windll.user32.ShowWindow(hwnd, 0)
        STATE["console_visible"] = False


def show_console():
    hwnd = get_console_window()
    if hwnd:
        ctypes.windll.user32.ShowWindow(hwnd, 5)
        STATE["console_visible"] = True


def toggle_console(icon, item):
    if STATE["console_visible"]:
        hide_console()
    else:
        show_console()


def clear_discord_status():
    headers = {
        "Authorization": DISCORD_TOKEN,
        "Content-Type": "application/json",
    }

    json_data = {
        "status": "online",
        "custom_status": None
    }

    try:
        requests.patch(
            DISCORD_SETTINGS_URL,
            headers=headers,
            json=json_data,
            timeout=5
        )
    except requests.RequestException:
        pass


def toggle_active(icon, item):
    STATE["active"] = not STATE["active"]

    if not STATE["active"]:
        clear_discord_status()

    icon.update_menu()


def create_tray_icon():
    def on_exit(icon, item):
        clear_discord_status()
        icon.stop()

        if server:
            server.shutdown()
            server.server_close()
    def clear():
        clear_discord_status()

    image = Image.new("RGB", (16, 16), (0, 0, 0))

    menu = pystray.Menu(
        pystray.MenuItem(
            "Active",
            toggle_active,
            checked=lambda item: STATE["active"]
        ),
        pystray.MenuItem(
            "Show Console",
            toggle_console,
            checked=lambda item: STATE["console_visible"]
        ),
        pystray.MenuItem("Clear", clear),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Exit", on_exit)
    )

    return pystray.Icon(
        "Lyrics Bridge",
        image,
        "Lyrics Bridge",
        menu
    )


def write_current_payload(payload: dict) -> None:
    CURRENT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def read_current_payload() -> dict:
    if STATE["payload"] is not None:
        return STATE["payload"]

    if CURRENT_PATH.exists():
        try:
            STATE["payload"] = json.loads(
                CURRENT_PATH.read_text(encoding="utf-8")
            )
            return STATE["payload"]
        except Exception:
            return {}

    return {}


def change_status(lyric: str) -> None:
    if not STATE["active"]:
        return

    lyric = lyric.strip()[:128]

    if not lyric:
        return

    now = time.time()

    if lyric == STATE["last_sent_status"]:
        return

    if now - STATE["last_status_time"] < STATUS_COOLDOWN_SECONDS:
        return

    headers = {
        "Authorization": DISCORD_TOKEN,
        "Content-Type": "application/json",
    }

    json_data = {
        "status": "online",
        "custom_status": {
            "text": lyric,
            "emoji_name": "🎶"
        }
    }

    try:
        response = requests.patch(
            DISCORD_SETTINGS_URL,
            headers=headers,
            json=json_data,
            timeout=5
        )

        if response.status_code in (200, 204):
            STATE["last_sent_status"] = lyric
            STATE["last_status_time"] = now

    except requests.RequestException as exc:
        print("\nPATCH failed:", exc)


def extract_console_line(payload: dict) -> str:
    playback = payload.get("playback") or {}
    lyric = payload.get("lyric") or {}
    line = str(lyric.get("text") or "").strip()

    if not playback.get("isPlaying") or not line:
        return ""

    return line


def render_console_line(payload: dict) -> None:
    next_line = extract_console_line(payload)
    previous_line = STATE.get("displayed_line", "")

    if next_line == previous_line:
        return

    clear_width = max(len(previous_line), len(next_line))
    sys.stdout.write("\r" + (" " * clear_width) + "\r")

    if next_line:
        sys.stdout.write(next_line)
        change_status(next_line)

    sys.stdout.flush()
    STATE["displayed_line"] = next_line


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")

        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/health":
            self._send_json(
                200,
                {
                    "ok": True,
                    "active": STATE["active"],
                    "timestamp": datetime.now(timezone.utc).isoformat()
                }
            )
            return

        if parsed.path == "/current":
            self._send_json(
                200,
                {
                    "ok": True,
                    "payload": read_current_payload()
                }
            )
            return

        self._send_json(404, {"ok": False, "error": "Not found"})

    def do_POST(self):
        parsed = urlparse(self.path)

        if parsed.path != "/lyrics":
            self._send_json(404, {"ok": False, "error": "Not found"})
            return

        try:
            content_length = int(self.headers.get("Content-Length") or "0")
            body = self.rfile.read(content_length)
            payload = json.loads(body.decode("utf-8"))
        except Exception as exc:
            self._send_json(400, {"ok": False, "error": f"Invalid JSON: {exc}"})
            return

        STATE["payload"] = payload
        write_current_payload(payload)
        render_console_line(payload)

        self._send_json(
            200,
            {
                "ok": True,
                "active": STATE["active"],
                "storedAt": datetime.now(timezone.utc).isoformat()
            }
        )

    def log_message(self, format: str, *args):
        return


if __name__ == "__main__":
    CURRENT_PATH.parent.mkdir(parents=True, exist_ok=True)

    server = ThreadingHTTPServer((HOST, PORT), Handler)

    print(f"Lyrics bridge listening on http://{HOST}:{PORT}", flush=True)

    server_thread = threading.Thread(
        target=server.serve_forever,
        daemon=True
    )
    server_thread.start()

    tray_icon = create_tray_icon()

    hide_console()

    try:
        tray_icon.run()
    except KeyboardInterrupt:
        pass
    finally:
        clear_discord_status()

        if server:
            server.shutdown()
            server.server_close()

        show_console()
        print("Lyrics bridge stopped.", flush=True)