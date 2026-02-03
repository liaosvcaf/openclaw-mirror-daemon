# OpenClaw Mirror Daemon

A lightweight Node.js utility to automatically mirror messages between different OpenClaw channels (e.g., Webchat to Telegram) without incurring additional LLM token costs.

## Motivation

When switching between devices (desk-based Webchat and mobile-based Telegram), users often lose the immediate context of a conversation. While an agent can manually mirror replies using the `message` tool, this has several drawbacks:
1. **Token Cost:** Every manual mirror requires a tool call and adds to the session's context history.
2. **Latency:** Mirroring is dependent on the agent's turn-taking.
3. **Manual Overhead:** The agent must be explicitly instructed or programmed to handles the mirroring.

This daemon solves these issues by monitoring the system logs directly and forwarding messages via the OpenClaw CLI, operating entirely outside the LLM context.

## Solution

The daemon uses a "Sidecar" pattern:
- **Log Monitoring:** Uses `tail -F` on the active OpenClaw JSONL logs.
- **Deduplication:** Maintains a sliding-window cache of recent messages to prevent infinite loops and duplicate sends.
- **Zero-Token Forwarding:** Utilizes the `openclaw message send` CLI command. Because this happens at the system level, no tokens are consumed from the AI model's quota.

## Setup

1. **Configure Target:** Set your target channel/ID in the script (e.g., your Telegram ID).
2. **Verify Log Path:** Ensure the `LOG_PATH` matches your OpenClaw log location (typically `/tmp/openclaw/` or `~/.openclaw/logs/`).
3. **Run:**
   ```bash
   node mirror_daemon.js
   ```

## Design Choices

- **Tail over File Watch:** `tail -F` is more robust against log rotation than Node's `fs.watch`.
- **CLI over API:** Using the local `openclaw` CLI for sending messages avoids the need for managing extra API tokens or complex HTTP requests.
- **JSONL Parsing:** Since OpenClaw logs are JSON objects, the script parses each line to identify the source channel and message content accurately.
