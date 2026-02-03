const fs = require('fs');
const { spawn, execSync } = require('child_process');
const path = require('path');

// === Config ===
const SESSIONS_DIR = '/Users/liao/.openclaw/agents/main/sessions';
const SESSIONS_JSON = path.join(SESSIONS_DIR, 'sessions.json');
const TELEGRAM_TARGET = '7380936103';
const MIRROR_TAG = '[mirrored]';
const POLL_INTERVAL_MS = 5000;
const CACHE_SIZE = 50;

// === State ===
let currentSessionId = null;
let currentFilePath = null;
let currentTail = null;
let lastLineCount = 0;
let prevUserIsWebchat = false;
const mirroredCache = new Set();

// === Helpers ===

function getActiveSessionId() {
    try {
        const data = JSON.parse(fs.readFileSync(SESSIONS_JSON, 'utf8'));
        const main = data['agent:main:main'];
        return main ? main.sessionId : null;
    } catch (e) {
        return null;
    }
}

function isWebchatUserMessage(text) {
    if (!text || typeof text !== 'string') return false;
    // Webchat messages have UUID-style message_ids and no channel prefix
    if (text.startsWith('[Telegram')) return false;
    if (text.startsWith('System:')) return false;
    if (text.startsWith('[Queued')) return false;
    if (text.startsWith('[Audio]')) return false;
    // Must have a message_id (all real messages do)
    if (!text.includes('message_id:')) return false;
    // UUID message_id pattern (webchat uses UUIDs, telegram uses numbers)
    const match = text.match(/\[message_id:\s*([^\]]+)\]/);
    if (!match) return false;
    const id = match[1].trim();
    // Telegram message_ids are numeric; webchat are UUIDs
    return /[a-f0-9-]{36}/.test(id);
}

function extractAssistantText(content) {
    if (!Array.isArray(content)) return null;
    const texts = [];
    for (const part of content) {
        if (part && part.type === 'text' && part.text && part.text.trim()) {
            texts.push(part.text.trim());
        }
    }
    return texts.length > 0 ? texts.join('\n\n') : null;
}

function sendToTelegram(text) {
    if (!text || mirroredCache.has(text)) return;

    mirroredCache.add(text);
    if (mirroredCache.size > CACHE_SIZE) {
        const first = mirroredCache.values().next().value;
        mirroredCache.delete(first);
    }

    // Truncate very long messages (Telegram limit ~4096 chars)
    const maxLen = 3900;
    let sendText = text.length > maxLen ? text.substring(0, maxLen) + '\n\n[...truncated]' : text;

    const escaped = sendText.replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
    const command = `openclaw message send --target "${TELEGRAM_TARGET}" --message "${MIRROR_TAG} ${escaped}"`;
    try {
        execSync(command, { timeout: 15000, stdio: 'pipe' });
        console.log(`[Mirror] Sent to Telegram: ${text.substring(0, 80)}...`);
    } catch (err) {
        console.error(`[Mirror] Failed to send: ${err.message}`);
    }
}

function processLine(line) {
    if (!line.trim()) return;
    let entry;
    try {
        entry = JSON.parse(line);
    } catch (e) {
        return;
    }

    const msg = entry.message;
    if (!msg) return;
    const role = msg.role;
    const content = msg.content;

    if (role === 'user') {
        // Check if this is a webchat user message
        let text = '';
        if (Array.isArray(content) && content.length > 0) {
            const first = content[0];
            text = (first && typeof first === 'object') ? (first.text || '') : String(first || '');
        } else if (typeof content === 'string') {
            text = content;
        }
        prevUserIsWebchat = isWebchatUserMessage(text);
    } else if (role === 'assistant' && prevUserIsWebchat) {
        const text = extractAssistantText(content);
        if (text) {
            sendToTelegram(text);
        }
        // Don't reset prevUserIsWebchat here -- multi-turn tool calls
        // between user and final assistant text reply are common.
        // We reset only on the next user message.
    }
    // toolResult and other roles: don't change state
}

function processFile(filePath) {
    try {
        const data = fs.readFileSync(filePath, 'utf8');
        const lines = data.split('\n');
        // Only process new lines
        if (lines.length > lastLineCount) {
            const newLines = lines.slice(lastLineCount);
            for (const line of newLines) {
                processLine(line);
            }
            lastLineCount = lines.length;
        }
    } catch (e) {
        // File might be mid-write
    }
}

function watchSession() {
    const sessionId = getActiveSessionId();
    if (!sessionId) {
        console.log('[Mirror] No active session found, waiting...');
        return;
    }

    if (sessionId !== currentSessionId) {
        console.log(`[Mirror] Session changed: ${currentSessionId} -> ${sessionId}`);
        currentSessionId = sessionId;
        currentFilePath = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
        lastLineCount = 0;
        prevUserIsWebchat = false;

        // Scan existing content to initialize state (don't mirror old messages)
        try {
            const data = fs.readFileSync(currentFilePath, 'utf8');
            const lines = data.split('\n');
            lastLineCount = lines.length;
            // Set prevUserIsWebchat based on last user message
            for (let i = lines.length - 1; i >= 0; i--) {
                if (!lines[i].trim()) continue;
                try {
                    const entry = JSON.parse(lines[i]);
                    if (entry.message && entry.message.role === 'user') {
                        let text = '';
                        const content = entry.message.content;
                        if (Array.isArray(content) && content.length > 0) {
                            const first = content[0];
                            text = (first && typeof first === 'object') ? (first.text || '') : String(first || '');
                        }
                        prevUserIsWebchat = isWebchatUserMessage(text);
                        break;
                    }
                } catch (e) {}
            }
            console.log(`[Mirror] Initialized at line ${lastLineCount}, webchat=${prevUserIsWebchat}`);
        } catch (e) {
            console.log(`[Mirror] Session file not yet available: ${currentFilePath}`);
        }
    }

    if (currentFilePath && fs.existsSync(currentFilePath)) {
        processFile(currentFilePath);
    }
}

// === Main Loop ===
console.log(`[Mirror] Daemon starting (PID ${process.pid})`);

setInterval(watchSession, POLL_INTERVAL_MS);
watchSession(); // Initial check

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
