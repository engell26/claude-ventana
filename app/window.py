"""The window: a native Qt frame around the page the local server serves.

Usage: window.py <url>
With VENTANA_TEST=1 it loads the page, prints its title and status, and exits.
"""

import os
import sys

from PySide6.QtCore import QTimer, QUrl
from PySide6.QtGui import QGuiApplication
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QApplication


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
    view.resize(460, 720)
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
        view.show()

    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
