const fs = require('fs');
const spawn = require('child_process').spawn;
const { execSync } = require('child_process');
const MirrorLogLogic = require('./mirror_logic');

/**
 * CONFIGURATION
 */
const LOG_PATH = '/tmp/openclaw/openclaw-2026-02-02.log';
const TARGET_ID = '7380936103';

const logic = new MirrorLogLogic(TARGET_ID);

console.log(`Starting Fixed Mirror Daemon... monitoring ${LOG_PATH}`);

const tail = spawn('tail', ['-F', LOG_PATH]);

tail.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
        const textToMirror = logic.shouldMirror(line);
        if (textToMirror) {
            const command = logic.sendToTarget(textToMirror);
            if (command) {
                try {
                    execSync(command);
                    console.log(`[Mirrored] ${textToMirror}`);
                } catch (err) {
                    console.error(`Failed to forward: ${err.message}`);
                }
            }
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
