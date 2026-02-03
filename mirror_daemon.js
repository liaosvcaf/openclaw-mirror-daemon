const fs = require('fs');
const spawn = require('child_process').spawn;
const { execSync } = require('child_process');

/**
 * CONFIGURATION
 * Set these values to match your environment.
 */
const LOG_PATH = '/tmp/openclaw/openclaw.log'; // Adjust to your log location
const TARGET_ID = 'YOUR_TARGET_ID';            // e.g., Telegram User ID
const IGNORE_TAG = '[mirrored]';
const CACHE_SIZE = 10;
const mirroredCache = new Set();

console.log(`Starting Mirror Daemon... monitoring ${LOG_PATH}`);

function sendToTarget(text) {
    if (mirroredCache.has(text)) return;
    
    // Simple deduplication cache
    mirroredCache.add(text);
    if (mirroredCache.size > CACHE_SIZE) {
        const first = mirroredCache.values().next().value;
        mirroredCache.delete(first);
    }

    // Forward the message via OpenClaw CLI
    const command = `openclaw message send --target "${TARGET_ID}" --message "${IGNORE_TAG} ${text.replace(/"/g, '\\"')}"`;
    try {
        execSync(command);
        console.log(`[Mirrored] ${text}`);
    } catch (err) {
        console.error(`Failed to forward message: ${err.message}`);
    }
}

// Watch the log file
const tail = spawn('tail', ['-F', LOG_PATH]);

tail.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
        if (!line.trim()) continue;
        
        try {
            const entry = JSON.parse(line);
            
            // Logic to identify webchat user messages
            const isWebchat = JSON.stringify(entry).toLowerCase().includes('webchat');
            const content = entry[0] || entry.message || "";

            if (isWebchat && content && !content.includes(IGNORE_TAG)) {
                if (typeof content === 'string' && content.trim().length > 0) {
                    sendToTarget(content);
                }
            }
        } catch (e) {
            // Not a JSON line
        }
    }
});

tail.stderr.on('data', (data) => {
    console.error(`Tail error: ${data}`);
});

process.on('SIGTERM', () => {
    tail.kill();
    process.exit(0);
});
