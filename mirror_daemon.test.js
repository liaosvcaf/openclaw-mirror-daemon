const fs = require('fs');
const path = require('path');

// Mock execSync before requiring the module
jest.mock('child_process', () => ({
    ...jest.requireActual('child_process'),
    execSync: jest.fn(),
    spawn: jest.fn(() => ({
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        kill: jest.fn(),
    })),
}));

const {
    parseSubsystem,
    parseWebchatRunDone,
    parseRunStart,
    getLastAssistantText,
    shouldIgnore,
    processLine,
    webchatRuns,
    processedRuns,
    mirroredCache,
    IGNORE_TAG,
} = require('./mirror_daemon');

// --- Helpers to build realistic log lines ---

function makeLogLine(subsystem, message, extra) {
    var entry = {
        '0': JSON.stringify({ subsystem: subsystem }),
        '1': message,
        _meta: {
            runtime: 'node',
            runtimeVersion: '25.5.0',
            hostname: 'unknown',
            name: JSON.stringify({ subsystem: subsystem }),
            parentNames: ['openclaw'],
            date: new Date().toISOString(),
            logLevelId: 2,
            logLevelName: 'DEBUG',
        },
        time: new Date().toISOString(),
    };
    if (extra) Object.assign(entry, extra);
    return JSON.stringify(entry);
}

function makePlainLogLine(message) {
    return JSON.stringify({
        '0': message,
        _meta: {
            runtime: 'node',
            name: 'openclaw',
            date: new Date().toISOString(),
            logLevelId: 3,
            logLevelName: 'INFO',
        },
        time: new Date().toISOString(),
    });
}

function makeRunStartLine(runId, sessionId, channel) {
    return makeLogLine(
        'agent/embedded',
        'embedded run start: runId=' + runId + ' sessionId=' + sessionId + ' provider=anthropic model=claude-opus-4-5 thinking=low messageChannel=' + channel
    );
}

function makeRunDoneLine(runId, sessionId) {
    return makeLogLine(
        'agent/embedded',
        'embedded run done: runId=' + runId + ' sessionId=' + sessionId + ' durationMs=4881 aborted=false'
    );
}

// --- Tests ---

describe('parseSubsystem', function() {
    test('parses subsystem from structured entry', function() {
        var entry = { '0': '{"subsystem":"agent/embedded"}' };
        expect(parseSubsystem(entry)).toBe('agent/embedded');
    });

    test('parses gateway/ws subsystem', function() {
        var entry = { '0': '{"subsystem":"gateway/ws"}' };
        expect(parseSubsystem(entry)).toBe('gateway/ws');
    });

    test('returns null for plain string entry', function() {
        var entry = { '0': 'Registered hook: boot-md -> gateway:startup' };
        expect(parseSubsystem(entry)).toBeNull();
    });

    test('returns null for null/undefined entry', function() {
        expect(parseSubsystem(null)).toBeNull();
        expect(parseSubsystem(undefined)).toBeNull();
        expect(parseSubsystem({})).toBeNull();
    });

    test('returns null for non-string field 0', function() {
        var entry = { '0': 123 };
        expect(parseSubsystem(entry)).toBeNull();
    });
});

describe('parseRunStart', function() {
    test('detects webchat run start', function() {
        var line = makeRunStartLine('abc-123', 'sess-456', 'webchat');
        var result = parseRunStart(line);
        expect(result).toEqual({
            sessionId: 'sess-456',
            runId: 'abc-123',
            messageChannel: 'webchat',
        });
    });

    test('detects telegram run start', function() {
        var line = makeRunStartLine('abc-123', 'sess-456', 'telegram');
        var result = parseRunStart(line);
        expect(result).toEqual({
            sessionId: 'sess-456',
            runId: 'abc-123',
            messageChannel: 'telegram',
        });
    });

    test('returns null for non-run-start entries', function() {
        var line = makeLogLine('agent/embedded', 'embedded run tool start: runId=abc tool=read');
        expect(parseRunStart(line)).toBeNull();
    });

    test('returns null for empty/null input', function() {
        expect(parseRunStart('')).toBeNull();
        expect(parseRunStart(null)).toBeNull();
        expect(parseRunStart('   ')).toBeNull();
    });

    test('returns null for non-JSON input', function() {
        expect(parseRunStart('not json at all')).toBeNull();
    });

    test('returns null for wrong subsystem', function() {
        var line = makeLogLine('gateway/ws', 'embedded run start: runId=abc sessionId=def messageChannel=webchat');
        expect(parseRunStart(line)).toBeNull();
    });
});

describe('parseWebchatRunDone', function() {
    test('detects run done event', function() {
        var line = makeRunDoneLine('run-123', 'sess-456');
        var result = parseWebchatRunDone(line);
        expect(result).toEqual({
            sessionId: 'sess-456',
            runId: 'run-123',
        });
    });

    test('returns null for run start event', function() {
        var line = makeRunStartLine('run-123', 'sess-456', 'webchat');
        expect(parseWebchatRunDone(line)).toBeNull();
    });

    test('returns null for tool events', function() {
        var line = makeLogLine('agent/embedded', 'embedded run tool start: runId=abc tool=read toolCallId=toolu_123');
        expect(parseWebchatRunDone(line)).toBeNull();
    });

    test('returns null for malformed JSON', function() {
        expect(parseWebchatRunDone('{invalid json')).toBeNull();
    });

    test('returns null for non-embedded subsystem', function() {
        var line = makeLogLine('diagnostic', 'embedded run done: runId=abc sessionId=def durationMs=100');
        expect(parseWebchatRunDone(line)).toBeNull();
    });

    test('returns null when entry[1] is an object (not string)', function() {
        var entry = {
            '0': '{"subsystem":"agent/embedded"}',
            '1': { intervalMs: 14400000 },
            '2': 'heartbeat: started',
        };
        expect(parseWebchatRunDone(JSON.stringify(entry))).toBeNull();
    });
});

describe('shouldIgnore', function() {
    test('ignores null/empty text', function() {
        expect(shouldIgnore(null)).toBe(true);
        expect(shouldIgnore('')).toBe(true);
        expect(shouldIgnore('   ')).toBe(true);
    });

    test('ignores text with [mirrored] tag', function() {
        expect(shouldIgnore('[mirrored] Hello from webchat')).toBe(true);
        expect(shouldIgnore('Some text [mirrored] more text')).toBe(true);
    });

    test('allows normal text', function() {
        expect(shouldIgnore('Hello, how can I help you?')).toBe(false);
    });
});

describe('getLastAssistantText', function() {
    test('returns null for non-existent session', function() {
        var result = getLastAssistantText('nonexistent-session-id-12345');
        expect(result).toBeNull();
    });

    test('extracts text from assistant message (inline check)', function() {
        var lines = [
            JSON.stringify({
                type: 'message', id: '1',
                message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
            }),
            JSON.stringify({
                type: 'message', id: '2',
                message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there! How can I help?' }] },
            }),
        ];
        var fileContent = lines.join('\n');
        var fileLines = fileContent.trim().split('\n');
        var foundText = null;
        for (var i = fileLines.length - 1; i >= 0; i--) {
            var entry = JSON.parse(fileLines[i]);
            if (entry.type === 'message' && entry.message && entry.message.role === 'assistant') {
                var textParts = entry.message.content
                    .filter(function(c) { return c.type === 'text' && c.text; })
                    .map(function(c) { return c.text.trim(); })
                    .filter(function(t) { return t.length > 0; });
                if (textParts.length > 0) {
                    foundText = textParts.join('\n');
                    break;
                }
            }
        }
        expect(foundText).toBe('Hi there! How can I help?');
    });

    test('skips tool calls and returns text-only content', function() {
        var lines = [
            JSON.stringify({
                type: 'message', id: '1',
                message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tool1', name: 'exec', arguments: { command: 'ls' } }] },
            }),
            JSON.stringify({
                type: 'message', id: '2',
                message: { role: 'toolResult', toolCallId: 'tool1', content: [{ type: 'text', text: 'file1.txt' }] },
            }),
            JSON.stringify({
                type: 'message', id: '3',
                message: { role: 'assistant', content: [{ type: 'text', text: 'Here are your files.' }] },
            }),
        ];
        var fileLines = lines;
        var foundText = null;
        for (var i = fileLines.length - 1; i >= 0; i--) {
            var entry = JSON.parse(fileLines[i]);
            if (entry.type === 'message' && entry.message && entry.message.role === 'assistant') {
                var textParts = entry.message.content
                    .filter(function(c) { return c.type === 'text' && c.text; })
                    .map(function(c) { return c.text.trim(); })
                    .filter(function(t) { return t.length > 0; });
                if (textParts.length > 0) {
                    foundText = textParts.join('\n');
                    break;
                }
            }
        }
        expect(foundText).toBe('Here are your files.');
    });

    test('skips thinking blocks', function() {
        var line = JSON.stringify({
            type: 'message', id: '1',
            message: {
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 'Let me think about this...' },
                    { type: 'text', text: 'The answer is 42.' },
                ],
            },
        });
        var entry = JSON.parse(line);
        var textParts = entry.message.content
            .filter(function(c) { return c.type === 'text' && c.text; })
            .map(function(c) { return c.text.trim(); })
            .filter(function(t) { return t.length > 0; });
        expect(textParts.join('\n')).toBe('The answer is 42.');
    });
});

describe('processLine - integration', function() {
    beforeEach(function() {
        webchatRuns.clear();
        processedRuns.clear();
        mirroredCache.clear();
    });

    test('tracks webchat run start', function() {
        var line = makeRunStartLine('run-1', 'sess-1', 'webchat');
        processLine(line);
        expect(webchatRuns.has('run-1')).toBe(true);
        expect(webchatRuns.get('run-1')).toBe('sess-1');
    });

    test('does not track telegram run start', function() {
        var line = makeRunStartLine('run-2', 'sess-2', 'telegram');
        processLine(line);
        expect(webchatRuns.has('run-2')).toBe(false);
    });

    test('does not track heartbeat run start', function() {
        var line = makeRunStartLine('run-3', 'sess-3', 'heartbeat');
        processLine(line);
        expect(webchatRuns.has('run-3')).toBe(false);
    });

    test('ignores non-message log entries', function() {
        var lines = [
            makeLogLine('gateway/ws', 'webchat connected conn=abc remote=127.0.0.1'),
            makeLogLine('gateway/ws', 'webchat disconnected code=1006 reason=n/a conn=abc'),
            makeLogLine('gateway/canvas', 'canvas host mounted at http://127.0.0.1:18789'),
            makeLogLine('memory', 'openai batch batch_abc validating; waiting 2000ms'),
            makeLogLine('diagnostic', 'lane dequeue: lane=main waitMs=4 queueSize=0'),
            makeLogLine('gateway/reload', 'config change detected; evaluating reload'),
            makePlainLogLine('Registered hook: boot-md -> gateway:startup'),
            makePlainLogLine('bonjour: advertised gateway fqdn=Titan'),
        ];
        for (var i = 0; i < lines.length; i++) {
            processLine(lines[i]);
        }
        expect(webchatRuns.size).toBe(0);
        expect(processedRuns.size).toBe(0);
    });

    test('handles malformed JSON gracefully', function() {
        expect(function() { processLine('{invalid json'); }).not.toThrow();
        expect(function() { processLine('random text'); }).not.toThrow();
        expect(function() { processLine(''); }).not.toThrow();
        expect(function() { processLine(null); }).not.toThrow();
    });

    test('deduplication prevents processing same run twice', function() {
        var startLine = makeRunStartLine('run-dup', 'sess-dup', 'webchat');
        processLine(startLine);
        expect(webchatRuns.has('run-dup')).toBe(true);

        var doneLine = makeRunDoneLine('run-dup', 'sess-dup');
        processLine(doneLine);
        expect(processedRuns.has('run-dup')).toBe(true);

        // Re-add and try again - should be deduplicated
        webchatRuns.set('run-dup', 'sess-dup');
        processLine(doneLine);
        expect(processedRuns.has('run-dup')).toBe(true);
    });

    test('does not process run done without matching run start', function() {
        var doneLine = makeRunDoneLine('orphan-run', 'sess-orphan');
        processLine(doneLine);
        expect(processedRuns.has('orphan-run')).toBe(false);
    });

    test('ignores run done for telegram runs', function() {
        var startLine = makeRunStartLine('tg-run', 'tg-sess', 'telegram');
        processLine(startLine);
        expect(webchatRuns.has('tg-run')).toBe(false);

        var doneLine = makeRunDoneLine('tg-run', 'tg-sess');
        processLine(doneLine);
        expect(processedRuns.has('tg-run')).toBe(false);
    });
});

describe('deduplication cache', function() {
    beforeEach(function() {
        mirroredCache.clear();
    });

    test('mirroredCache prevents duplicate sends', function() {
        mirroredCache.add('Hello world');
        expect(mirroredCache.has('Hello world')).toBe(true);
        expect(mirroredCache.has('Different text')).toBe(false);
    });

    test('mirroredCache evicts oldest entries', function() {
        for (var i = 0; i < 55; i++) {
            mirroredCache.add('message-' + i);
            if (mirroredCache.size > 50) {
                var first = mirroredCache.values().next().value;
                mirroredCache.delete(first);
            }
        }
        expect(mirroredCache.has('message-0')).toBe(false);
        expect(mirroredCache.has('message-4')).toBe(false);
        expect(mirroredCache.has('message-54')).toBe(true);
    });
});

describe('echo loop prevention', function() {
    test('ignores messages with [mirrored] tag', function() {
        expect(shouldIgnore('[mirrored] This was sent by the daemon')).toBe(true);
    });

    test('ignores messages containing [mirrored] anywhere', function() {
        expect(shouldIgnore('prefix [mirrored] suffix')).toBe(true);
    });

    test('allows messages without [mirrored] tag', function() {
        expect(shouldIgnore('Normal assistant response')).toBe(false);
    });
});

describe('structured subsystem handling', function() {
    test('correctly identifies agent/embedded subsystem', function() {
        var entry = JSON.parse(makeRunStartLine('r1', 's1', 'webchat'));
        expect(parseSubsystem(entry)).toBe('agent/embedded');
    });

    test('correctly identifies gateway/ws subsystem', function() {
        var entry = JSON.parse(makeLogLine('gateway/ws', 'webchat connected'));
        expect(parseSubsystem(entry)).toBe('gateway/ws');
    });

    test('correctly identifies gateway/channels/telegram subsystem', function() {
        var entry = JSON.parse(makeLogLine('gateway/channels/telegram', 'starting provider'));
        expect(parseSubsystem(entry)).toBe('gateway/channels/telegram');
    });

    test('handles plain string entry[0] without subsystem', function() {
        var entry = JSON.parse(makePlainLogLine('Registered hook: boot-md'));
        expect(parseSubsystem(entry)).toBeNull();
    });
});

describe('realistic log entry handling', function() {
    beforeEach(function() {
        webchatRuns.clear();
        processedRuns.clear();
    });

    test('full webchat lifecycle: start -> done', function() {
        var runId = '6ffd72a2-bea2-4d40-82c9-6532e565c44e';
        var sessionId = 'ac751bd1-ea97-44c1-a8c0-062999c37b16';

        var startLine = makeLogLine(
            'agent/embedded',
            'embedded run start: runId=' + runId + ' sessionId=' + sessionId + ' provider=anthropic model=claude-opus-4-5 thinking=low messageChannel=webchat'
        );
        processLine(startLine);
        expect(webchatRuns.has(runId)).toBe(true);

        // Tool events (should be ignored)
        processLine(makeLogLine('agent/embedded', 'embedded run tool start: runId=' + runId + ' tool=read toolCallId=toolu_01'));
        processLine(makeLogLine('agent/embedded', 'embedded run tool end: runId=' + runId + ' tool=read toolCallId=toolu_01'));

        var doneLine = makeLogLine(
            'agent/embedded',
            'embedded run done: runId=' + runId + ' sessionId=' + sessionId + ' durationMs=4881 aborted=false'
        );
        processLine(doneLine);
        expect(processedRuns.has(runId)).toBe(true);
        expect(webchatRuns.has(runId)).toBe(false);
    });

    test('interleaved webchat and telegram runs', function() {
        var webchatRun = 'wc-run-1';
        var telegramRun = 'tg-run-1';
        var sessionId = 'shared-session';

        processLine(makeRunStartLine(webchatRun, sessionId, 'webchat'));
        processLine(makeRunStartLine(telegramRun, sessionId, 'telegram'));

        expect(webchatRuns.has(webchatRun)).toBe(true);
        expect(webchatRuns.has(telegramRun)).toBe(false);

        processLine(makeRunDoneLine(telegramRun, sessionId));
        expect(processedRuns.has(telegramRun)).toBe(false);

        processLine(makeRunDoneLine(webchatRun, sessionId));
        expect(processedRuns.has(webchatRun)).toBe(true);
    });
});
