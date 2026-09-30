# pi-time-stats

Per-call time + token stats for the Pi TUI. One row per tool call — `bash npm install` and `bash python -m main.py` show as separate rows.

## Install

```bash
pi install npm:pi-time-stats
# or from git:
pi install git:github.com/YOURNAME/pi-time-stats@v0.1.0
```

## Use

- `/timestats [n]` — slowest tool calls this session (default 10). Time on the left, tool call gets the rest of the line. Nested calls excluded with a count.
- In the overlay: `↑↓` move, `Enter` expands a row to full multiline detail, `q` closes.
- Live widget above the editor: `last: bash 3.2s | session tools 84s | tokens ~152k`.

## Notes

- Time measured with `performance.now()` between `tool_execution_start` / `tool_execution_end`.
- Token totals come from per-message `usage`; per-call output sizes are character counts labeled `~`.
- Stats reset on session switch. Never logged, never sent to the model.
