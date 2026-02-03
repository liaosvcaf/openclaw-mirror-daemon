const fs = require('fs');
const path = require('path');
const spawn = require('child_process').spawn;
const { execSync } = require('child_process');

const LOG_DIR = '/tmp/openclaw';
const SESSIONS_DIR = path.join(process.env.HOME || '/Users/liao', '.openclaw/agents/main/sessions');
const TELEGRAM_TARGET = '7380936103';
const IGNORE_TAG = '[mirrored]';
const CACHE_SIZE = 50;
const mirroredCache = new Set();

// Track which runIds we've already processed to avoid duplicates
const processedRuns = new Set();
const PROCESSED_RUNS_MAX = 100;

let currentTail = null;
let currentLogDate = null;

// --- Exported helpers for testing ---

/**
 * Parse the subsystem from entry["0"], which is a JSON string like '{"subsystem":"agent/embedded"}'
 */
function parseSubsystem(entry) {
    const field0 = entry && entry['0'];
    if (!field0 || typeof field0 !== 'string') return null;
    try {
        const parsed = JSON.parse(field0);
        return parsed.subsystem || null;
    } catch {
        return null;
    }
}

/**
 * Parse a log line and determine if it's a webchat "run done" event.
 * Returns { sessionId, runId } if it is, null otherwise.
 */
function parseWebchatRunDone(line) {
    if (!line || !line.trim()) return null;
    let entry;
    try {
        entry = JSON.parse(line);
    } catch {
        return null;
    }

    const subsystem = parseSubsystem(entry);
    if (subsystem !== 'agent/embedded') return null;

    const msg = entry['1'];
    if (typeof msg !== 'string') return null;

    if (!msg.includes('embedded run done:')) return null;

    const sessionMatch = msg.match(/sessionId=([a-zA-Z0-9_-]+)/);
    const runMatch = msg.match(/runId=([a-zA-Z0-9_-]+)/);
    if (!sessionMatch || !runMatch) return null;

    return { sessionId: sessionMatch[1], runId: runMatch[1] };
}

/**
 * Parse a log line and determine if it's an "embedded run start" event.
 * Returns { sessionId, runId, messageChannel } if it is, null otherwise.
 */
function parseRunStart(line) {
    if (!line || !line.trim()) return null;
    let entry;
    try {
        entry = JSON.parse(line);
    } catch {
        return null;
    }

    const subsystem = parseSubsystem(entry);
    if (subsystem !== 'agent/embedded') return null;

    const msg = entry['1'];
    if (typeof msg !== 'string') return null;

    if (!msg.includes('embedded run start:')) return null;

    const sessionMatch = msg.match(/sessionId=([a-zA-Z0-9_-]+)/);
    const runMatch = msg.match(/runId=([a-zA-Z0-9_-]+)/);
    const channelMatch = msg.match(/messageChannel=(\S+)/);
    if (!sessionMatch || !runMatch || !channelMatch) return null;

    return {
        sessionId: sessionMatch[1],
        runId: runMatch[1],
        messageChannel: channelMatch[1],
    };
}

/**
 * Read the last assistant text message from a session JSONL file.
 * Returns the text content or null.
 */
function getLastAssistantText(sessionId) {
    const filePath = path.join(SESSIONS_DIR, sessionId + '.jsonl');
    if (!fs.existsSync(filePath)) return null;

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.trim().split('\n');

        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const entry = JSON.parse(lines[i]);
                if (entry.type !== 'message') continue;
                if (!entry.message || entry.message.role !== 'assistant') continue;

                const contentArr = entry.message.content;
                if (!Array.isArray(contentArr)) continue;

                const textParts = contentArr
                    .filter(c => c.type === 'text' && c.text)
                    .map(c => c.text.trim())
                    .filter(t => t.length > 0);

                if (textParts.length > 0) {
                    return textParts.join('\n');
                }
            } catch {
                continue;
            }
        }
    } catch {
        return null;
    }

    return null;
}

/**
 * Check if text should be ignored (echo loop prevention).
 */
function shouldIgnore(text) {
    if (!text) return true;
    if (text.includes(IGNORE_TAG)) return true;
    if (text.trim().length === 0) return true;
    return false;
}

// --- End exported helpers ---

function getLogPath() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return LOG_DIR + '/openclaw-' + yyyy + '-' + mm + '-' + dd + '.log';
}

function getDateStr() {
    const now = new Date();
    return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
}

function sendToTelegram(text) {
    if (mirroredCache.has(text)) return;

    mirroredCache.add(text);
    if (mirroredCache.size > CACHE_SIZE) {
        const first = mirroredCache.values().next().value;
        mirroredCache.delete(first);
    }

    let sendText = text;
    if (sendText.length > 3900) {
        sendText = sendText.substring(0, 3900) + '\n\n[...truncated]';
    }

    const escaped = sendText.replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
    const command = 'openclaw message send --target "' + TELEGRAM_TARGET + '" --message "' + IGNORE_TAG + ' ' + escaped + '"';
    try {
        execSync(command, { timeout: 15000 });
        console.log('[Sent to Telegram] ' + text.substring(0, 80) + '...');
    } catch (err) {
        console.error('Failed to send: ' + err.message);
    }
}

// Track webchat runs: when we see "run start" with messageChannel=webchat,
// record the runId. When we see "run done" with that runId, fetch the response.
const webchatRuns = new Map(); // runId -> sessionId

function processLine(line) {
    if (!line || !line.trim()) return;

    const startInfo = parseRunStart(line);
    if (startInfo) {
        if (startInfo.messageChannel === 'webchat') {
            webchatRuns.set(startInfo.runId, startInfo.sessionId);
            console.log('[Mirror] Tracking webchat run: ' + startInfo.runId + ' session=' + startInfo.sessionId);
        }
        return;
    }

    const doneInfo = parseWebchatRunDone(line);
    if (!doneInfo) return;

    const sessionId = webchatRuns.get(doneInfo.runId);
    if (!sessionId) return;

    webchatRuns.delete(doneInfo.runId);

    if (processedRuns.has(doneInfo.runId)) return;
    processedRuns.add(doneInfo.runId);
    if (processedRuns.size > PROCESSED_RUNS_MAX) {
        const first = processedRuns.values().next().value;
        processedRuns.delete(first);
    }

    console.log('[Mirror] Webchat run done: ' + doneInfo.runId + ' session=' + sessionId);

    setTimeout(function() {
        const text = getLastAssistantText(sessionId);
        if (text && !shouldIgnore(text)) {
            sendToTelegram(text);
        } else {
            console.log('[Mirror] No text to mirror for run ' + doneInfo.runId);
        }
    }, 500);
}

function startTailing(logPath) {
    if (currentTail) {
        currentTail.kill();
        currentTail = null;
    }

    console.log('[Mirror] Tailing ' + logPath);
    const tail = spawn('tail', ['-F', logPath]);
    currentTail = tail;

    tail.stdout.on('data', function(data) {
        const lines = data.toString().split('\n');
        for (const line of lines) {
            processLine(line);
        }
    });

    tail.stderr.on('data', function(data) {
        console.error('Tail stderr: ' + data);
    });

    tail.on('exit', function(code) {
        console.log('[Mirror] tail exited with code ' + code);
    });
}

function watchForDateChange() {
    setInterval(function() {
        const newDate = getDateStr();
        if (newDate !== currentLogDate) {
            console.log('[Mirror] Date changed: ' + currentLogDate + ' -> ' + newDate);
            currentLogDate = newDate;
            webchatRuns.clear();
            startTailing(getLogPath());
        }
    }, 60000);
}

function waitForLogAndStart() {
    var check = function() {
        var logPath = getLogPath();
        if (fs.existsSync(logPath)) {
            currentLogDate = getDateStr();
            startTailing(logPath);
            watchForDateChange();
        } else {
            console.log('[Mirror] Waiting for ' + logPath + ' ...');
            setTimeout(check, 5000);
        }
    };
    check();
}

// Only start daemon when run directly (not when required for testing)
if (require.main === module) {
    console.log('[Mirror] Daemon starting (PID ' + process.pid + ')');
    waitForLogAndStart();

    process.on('SIGTERM', function() {
        if (currentTail) currentTail.kill();
        process.exit(0);
    });
    process.on('SIGINT', function() {
        if (currentTail) currentTail.kill();
        process.exit(0);
    });
}

// Export for testing
module.exports = {
    parseSubsystem: parseSubsystem,
    parseWebchatRunDone: parseWebchatRunDone,
    parseRunStart: parseRunStart,
    getLastAssistantText: getLastAssistantText,
    shouldIgnore: shouldIgnore,
    processLine: processLine,
    webchatRuns: webchatRuns,
    processedRuns: processedRuns,
    mirroredCache: mirroredCache,
    IGNORE_TAG: IGNORE_TAG,
};
