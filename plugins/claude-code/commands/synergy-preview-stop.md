---
description: Stop the Synergy preview server
---

Run `synergy preview stop` in the current project root.

The CLI reads `.synergy/preview.pid`, sends SIGTERM to the recorded pid, escalates to SIGKILL if needed, and removes the PID file. If nothing is running, it tells you and exits.
