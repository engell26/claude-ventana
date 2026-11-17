"""The window: a native Qt frame around the page the local server serves.

Usage: window.py <url>
With VENTANA_TEST=1 it loads the page, prints its title and status, and exits.
"""

import json
import os
import subprocess
import sys

from PySide6.QtCore import QTimer, QUrl
from PySide6.QtGui import QGuiApplication
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QApplication


HIDDEN = "special:claude-terminal"


def show_terminal() -> None:
    """Bring Claude's terminal back if the window hid it (Hyprland only)."""
    pid = os.environ.get("KITTY_PID")
    if not pid or not os.environ.get("HYPRLAND_INSTANCE_SIGNATURE"):
        return
    try:
        def hypr(*args: str) -> str:
            return subprocess.run(
                ["hyprctl", *args], capture_output=True, text=True, timeout=5
            ).stdout

        active = json.loads(hypr("activeworkspace", "-j"))["id"]
        for client in json.loads(hypr("clients", "-j")):
            if str(client["pid"]) == pid and client["workspace"]["name"] == HIDDEN:
                address = client["address"]
                # Hyprland's Lua dispatchers, then the older spelling.
                hypr(
                    "dispatch",
                    f"hl.dsp.window.move({{ workspace = '{active}', follow = false,"
                    f" window = 'address:{address}' }})",
                )
                hypr("dispatch", "movetoworkspacesilent", f"{active},address:{address}")
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        pass


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: window.py <url>", file=sys.stderr)
        return 2
    url = sys.argv[1]
    is_test = os.environ.get("VENTANA_TEST") == "1"

    app = QApplication(sys.argv[:1])
    app.setApplicationName("Claude")
    # The Wayland app id: a Hyprland rule matches `class:claude-ventana`.
    QGuiApplication.setDesktopFileName("claude-ventana")

    view = QWebEngineView()
    view.setWindowTitle("Claude")
    view.resize(1040, 760)
    view.load(QUrl(url))

    if is_test:
        def report() -> None:
            script = (
                "document.title + ' | ' + "
                "document.getElementById('status').textContent"
            )
            view.page().runJavaScript(script, lambda text: (print(text), app.quit()))

        view.loadFinished.connect(lambda ok: QTimer.singleShot(1500, report))
        QTimer.singleShot(15000, app.quit)
    else:
        # Closing the window always gives the terminal back.
        app.aboutToQuit.connect(show_terminal)
        view.show()

    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
