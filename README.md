# OpenClaw Mirror Daemon

Mirrors webchat assistant replies to Telegram automatically, without consuming LLM tokens.

## How It Works

The daemon watches OpenClaw session transcript files (JSONL) for new entries. When it detects an assistant reply following a webchat user message, it forwards the reply text to a configured Telegram user via `openclaw message send`.

### Why Session Transcripts?

OpenClaw's runtime logs (`/tmp/openclaw/*.log`) contain only metadata (run start/end, durations, errors) -- never the actual message text. The real content lives in session transcript JSONL files under `~/.openclaw/agents/main/sessions/`.

### Detection Logic

- **Webchat messages** have UUID-style `message_id` values (e.g., `a8733e42-3dce-4de0-8dfc-4d8e1aaf7e4a`)
- **Telegram messages** are prefixed with `[Telegram ...]` and have numeric message IDs
- **System/queued/audio messages** are filtered out
- Tool call rounds between user message and final assistant reply are handled correctly

## Setup

```bash
npm install
node mirror_daemon.js
```

Or via launchd (macOS):

```bash
# See com.openclaw.mirror-daemon.plist
launchctl load ~/Library/LaunchAgents/com.openclaw.mirror-daemon.plist
```

## Configuration

Edit constants at the top of `mirror_daemon.js`:

- `SESSIONS_DIR` -- path to OpenClaw session transcripts
- `TELEGRAM_TARGET` -- Telegram user ID to mirror to
- `POLL_INTERVAL_MS` -- how often to check for new entries (default: 5s)

## Tests

```bash
npm test
```

32 regression tests covering:
- Webchat vs Telegram message detection
- Assistant text extraction (with/without tool calls)
- Full processing pipeline (user -> tool calls -> assistant reply)
- Dedup cache behavior
- Message truncation

## License

ISC
