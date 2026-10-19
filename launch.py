"""Start the self-hosted game and open its menu in the default browser."""
import argparse
import json
import os
from pathlib import Path
import threading
import time
from urllib.request import urlopen
import webbrowser

import uvicorn


def open_when_ready(port):
    url = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            with urlopen(url + "/health", timeout=0.5) as response:
                if response.status == 200:
                    webbrowser.open(url + "/Golfgame/")
                    return
        except OSError:
            time.sleep(0.2)


def main():
    parser = argparse.ArgumentParser(description="Host GolfBot on your computer.")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    try:
        with urlopen(f"http://127.0.0.1:{args.port}/health", timeout=0.5) as response:
            running = json.load(response).get('status') == 'ok'
    except (OSError, ValueError):
        running = False
    if running:
        print(f"GolfBot is already running on port {args.port}.")
        if not args.no_browser:
            webbrowser.open(f"http://127.0.0.1:{args.port}/Golfgame/")
        return
    if not args.no_browser:
        threading.Thread(target=open_when_ready, args=(args.port,), daemon=True).start()
    print(f"GolfBot: http://localhost:{args.port}/Golfgame/")
    print("Keep this window open to host. Press Ctrl+C to stop.")
    pid_file = Path(__file__).parent / '.artifacts' / 'server.pid'
    pid_file.parent.mkdir(exist_ok=True)
    pid_file.write_text(str(os.getpid()))
    try:
        uvicorn.run("server:app", host="0.0.0.0", port=args.port, workers=1)
    finally:
        if pid_file.exists() and pid_file.read_text().strip() == str(os.getpid()):
            pid_file.unlink()


if __name__ == "__main__":
    main()
