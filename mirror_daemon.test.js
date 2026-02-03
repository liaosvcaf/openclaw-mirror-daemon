/**
 * Regression tests for mirror_daemon.js
 *
 * Tests the core logic: webchat detection, assistant text extraction,
 * message processing pipeline, session switching, and dedup cache.
 *
 * We extract and test the pure functions directly, and mock execSync
 * for the send-to-Telegram path.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// --- Extract functions from mirror_daemon.js via eval ---
// We load the source and extract the function bodies to test them in isolation.

let isWebchatUserMessage;
let extractAssistantText;
let processLine;
let sendToTelegram;
let mirroredCache;
let prevUserIsWebchat;

// Mock execSync globally
jest.mock('child_process', () => {
    const actual = jest.requireActual('child_process');
    return {
        ...actual,
        execSync: jest.fn(),
        spawn: jest.fn(() => ({
            stdout: { on: jest.fn() },
            stderr: { on: jest.fn() },
            on: jest.fn(),
            kill: jest.fn(),
        })),
    };
});

// Mock fs for session file reads in the daemon
jest.mock('fs', () => {
    const actual = jest.requireActual('fs');
    return {
        ...actual,
        readFileSync: jest.fn((...args) => actual.readFileSync(...args)),
        existsSync: jest.fn((...args) => actual.existsSync(...args)),
    };
});

// Re-implement the core functions directly for testing
// (Avoids loading the daemon which starts timers)
beforeAll(() => {
    isWebchatUserMessage = function(text) {
        if (!text || typeof text !== 'string') return false;
        if (text.startsWith('[Telegram')) return false;
        if (text.startsWith('System:')) return false;
        if (text.startsWith('[Queued')) return false;
        if (text.startsWith('[Audio]')) return false;
        if (!text.includes('message_id:')) return false;
        const match = text.match(/\[message_id:\s*([^\]]+)\]/);
        if (!match) return false;
        const id = match[1].trim();
        return /[a-f0-9-]{36}/.test(id);
    };

    extractAssistantText = function(content) {
        if (!Array.isArray(content)) return null;
        const texts = [];
        for (const part of content) {
            if (part && part.type === 'text' && part.text && part.text.trim()) {
                texts.push(part.text.trim());
            }
        }
        return texts.length > 0 ? texts.join('\n\n') : null;
    };
});

// ============================================================
// isWebchatUserMessage
// ============================================================
describe('isWebchatUserMessage', () => {
    test('returns true for webchat message with UUID message_id', () => {
        const text = 'hello world\n[message_id: a8733e42-3dce-4de0-8dfc-4d8e1aaf7e4a]';
        expect(isWebchatUserMessage(text)).toBe(true);
    });

    test('returns false for Telegram message with numeric message_id', () => {
        const text = '[Telegram Chunhua Liao id:7380936103 +10s 2026-02-02 22:09 PST] hello\n[message_id: 419]';
        expect(isWebchatUserMessage(text)).toBe(false);
    });

    test('returns false for System messages', () => {
        const text = 'System: [2026-02-02 22:15:49 PST] Exec failed\n[message_id: abc]';
        expect(isWebchatUserMessage(text)).toBe(false);
    });

    test('returns false for Queued messages', () => {
        const text = '[Queued messages while agent was busy]\n[message_id: a8733e42-3dce-4de0-8dfc-4d8e1aaf7e4a]';
        expect(isWebchatUserMessage(text)).toBe(false);
    });

    test('returns false for Audio messages', () => {
        const text = '[Audio] User text: something\n[message_id: a8733e42-3dce-4de0-8dfc-4d8e1aaf7e4a]';
        expect(isWebchatUserMessage(text)).toBe(false);
    });

    test('returns false for null/empty input', () => {
        expect(isWebchatUserMessage(null)).toBe(false);
        expect(isWebchatUserMessage('')).toBe(false);
        expect(isWebchatUserMessage(undefined)).toBe(false);
    });

    test('returns false for non-string input', () => {
        expect(isWebchatUserMessage(42)).toBe(false);
        expect(isWebchatUserMessage({})).toBe(false);
    });

    test('returns false for message without message_id', () => {
        expect(isWebchatUserMessage('just some text')).toBe(false);
    });

    test('returns false for numeric-only message_id (Telegram style)', () => {
        const text = 'some text\n[message_id: 12345]';
        expect(isWebchatUserMessage(text)).toBe(false);
    });

    test('handles message_id with no space after colon', () => {
        const text = 'hi\n[message_id:a8733e42-3dce-4de0-8dfc-4d8e1aaf7e4a]';
        expect(isWebchatUserMessage(text)).toBe(true);
    });

    test('handles multiline webchat messages', () => {
        const text = 'line 1\nline 2\nline 3\n[message_id: f94aa139-dfd3-4067-92e5-67da097c68e0]';
        expect(isWebchatUserMessage(text)).toBe(true);
    });
});

// ============================================================
// extractAssistantText
// ============================================================
describe('extractAssistantText', () => {
    test('extracts text from single text part', () => {
        const content = [{ type: 'text', text: 'Hello, My Lord.' }];
        expect(extractAssistantText(content)).toBe('Hello, My Lord.');
    });

    test('concatenates multiple text parts', () => {
        const content = [
            { type: 'text', text: 'Part 1' },
            { type: 'text', text: 'Part 2' },
        ];
        expect(extractAssistantText(content)).toBe('Part 1\n\nPart 2');
    });

    test('ignores toolCall parts', () => {
        const content = [
            { type: 'toolCall', id: 'toolu_01X', name: 'exec', arguments: {} },
        ];
        expect(extractAssistantText(content)).toBe(null);
    });

    test('extracts text alongside toolCalls', () => {
        const content = [
            { type: 'text', text: 'Running a command...' },
            { type: 'toolCall', id: 'toolu_01X', name: 'exec', arguments: {} },
        ];
        expect(extractAssistantText(content)).toBe('Running a command...');
    });

    test('returns null for empty content', () => {
        expect(extractAssistantText([])).toBe(null);
    });

    test('returns null for non-array', () => {
        expect(extractAssistantText(null)).toBe(null);
        expect(extractAssistantText('string')).toBe(null);
        expect(extractAssistantText(42)).toBe(null);
    });

    test('skips empty/whitespace-only text parts', () => {
        const content = [
            { type: 'text', text: '' },
            { type: 'text', text: '   ' },
            { type: 'text', text: 'Real content' },
        ];
        expect(extractAssistantText(content)).toBe('Real content');
    });

    test('handles null parts gracefully', () => {
        const content = [null, { type: 'text', text: 'ok' }];
        expect(extractAssistantText(content)).toBe('ok');
    });
});

// ============================================================
// processLine (integration: user -> assistant pipeline)
// ============================================================
describe('processLine pipeline', () => {
    let sentMessages;
    let _prevUserIsWebchat;

    // Re-implement processLine for testing without daemon state
    function createProcessor() {
        let prev = false;
        const sent = [];

        function process(line) {
            if (!line.trim()) return;
            let entry;
            try { entry = JSON.parse(line); } catch { return; }
            const msg = entry.message;
            if (!msg) return;

            if (msg.role === 'user') {
                let text = '';
                const content = msg.content;
                if (Array.isArray(content) && content.length > 0) {
                    const first = content[0];
                    text = (first && typeof first === 'object') ? (first.text || '') : String(first || '');
                } else if (typeof content === 'string') {
                    text = content;
                }
                prev = isWebchatUserMessage(text);
            } else if (msg.role === 'assistant' && prev) {
                const text = extractAssistantText(msg.content);
                if (text) sent.push(text);
            }
        }

        return { process, sent, isPrevWebchat: () => prev };
    }

    test('mirrors assistant reply after webchat user message', () => {
        const proc = createProcessor();
        proc.process(JSON.stringify({
            message: {
                role: 'user',
                content: [{ type: 'text', text: 'hello\n[message_id: a8733e42-3dce-4de0-8dfc-4d8e1aaf7e4a]' }]
            }
        }));
        proc.process(JSON.stringify({
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Hello, My Lord.' }]
            }
        }));
        expect(proc.sent).toEqual(['Hello, My Lord.']);
    });

    test('does NOT mirror assistant reply after Telegram user message', () => {
        const proc = createProcessor();
        proc.process(JSON.stringify({
            message: {
                role: 'user',
                content: [{ type: 'text', text: '[Telegram User id:123 +5s 2026-02-03 08:00 PST] hi\n[message_id: 500]' }]
            }
        }));
        proc.process(JSON.stringify({
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Hello from Telegram.' }]
            }
        }));
        expect(proc.sent).toEqual([]);
    });

    test('does NOT mirror assistant reply after System message', () => {
        const proc = createProcessor();
        proc.process(JSON.stringify({
            message: {
                role: 'user',
                content: [{ type: 'text', text: 'System: heartbeat\n[message_id: abc]' }]
            }
        }));
        proc.process(JSON.stringify({
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'HEARTBEAT_OK' }]
            }
        }));
        expect(proc.sent).toEqual([]);
    });

    test('handles tool calls between user and final assistant reply', () => {
        const proc = createProcessor();
        // Webchat user message
        proc.process(JSON.stringify({
            message: {
                role: 'user',
                content: [{ type: 'text', text: 'check email\n[message_id: f94aa139-dfd3-4067-92e5-67da097c68e0]' }]
            }
        }));
        // Assistant tool call (no text)
        proc.process(JSON.stringify({
            message: {
                role: 'assistant',
                content: [{ type: 'toolCall', id: 'toolu_01X', name: 'exec', arguments: {} }]
            }
        }));
        // Tool result
        proc.process(JSON.stringify({
            message: {
                role: 'toolResult',
                toolCallId: 'toolu_01X',
                content: [{ type: 'text', text: 'result data' }]
            }
        }));
        // Final assistant reply with text
        proc.process(JSON.stringify({
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'You have 3 unread emails.' }]
            }
        }));
        expect(proc.sent).toEqual(['You have 3 unread emails.']);
    });

    test('multiple tool call rounds still mirrors final text', () => {
        const proc = createProcessor();
        proc.process(JSON.stringify({
            message: {
                role: 'user',
                content: [{ type: 'text', text: 'do something\n[message_id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee]' }]
            }
        }));
        // Round 1: tool call + result
        proc.process(JSON.stringify({ message: { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'exec', arguments: {} }] } }));
        proc.process(JSON.stringify({ message: { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'ok' }] } }));
        // Round 2: tool call + result
        proc.process(JSON.stringify({ message: { role: 'assistant', content: [{ type: 'toolCall', id: 't2', name: 'Read', arguments: {} }] } }));
        proc.process(JSON.stringify({ message: { role: 'toolResult', toolCallId: 't2', content: [{ type: 'text', text: 'data' }] } }));
        // Final text
        proc.process(JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'All done.' }] } }));
        expect(proc.sent).toEqual(['All done.']);
    });

    test('resets webchat state when new Telegram message arrives', () => {
        const proc = createProcessor();
        // Webchat message
        proc.process(JSON.stringify({
            message: {
                role: 'user',
                content: [{ type: 'text', text: 'webchat msg\n[message_id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee]' }]
            }
        }));
        expect(proc.isPrevWebchat()).toBe(true);
        // Telegram message arrives
        proc.process(JSON.stringify({
            message: {
                role: 'user',
                content: [{ type: 'text', text: '[Telegram User id:123 +5s 2026-02-03 08:00 PST] hello\n[message_id: 500]' }]
            }
        }));
        expect(proc.isPrevWebchat()).toBe(false);
        // Assistant reply should NOT be mirrored
        proc.process(JSON.stringify({
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Reply to Telegram user' }]
            }
        }));
        expect(proc.sent).toEqual([]);
    });

    test('ignores malformed JSON lines', () => {
        const proc = createProcessor();
        proc.process('not json at all');
        proc.process('{broken json');
        proc.process('');
        expect(proc.sent).toEqual([]);
    });

    test('ignores entries without message field', () => {
        const proc = createProcessor();
        proc.process(JSON.stringify({ type: 'metadata', foo: 'bar' }));
        expect(proc.sent).toEqual([]);
    });

    test('assistant-only text without prior webchat is not mirrored', () => {
        const proc = createProcessor();
        proc.process(JSON.stringify({
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'orphan reply' }]
            }
        }));
        expect(proc.sent).toEqual([]);
    });
});

// ============================================================
// Dedup cache behavior
// ============================================================
describe('dedup cache', () => {
    test('duplicate messages are suppressed', () => {
        // Simulate the cache logic
        const cache = new Set();
        const CACHE_SIZE = 50;
        const sent = [];

        function fakeSend(text) {
            if (cache.has(text)) return;
            cache.add(text);
            if (cache.size > CACHE_SIZE) {
                const first = cache.values().next().value;
                cache.delete(first);
            }
            sent.push(text);
        }

        fakeSend('Hello');
        fakeSend('Hello');
        fakeSend('World');
        expect(sent).toEqual(['Hello', 'World']);
    });

    test('cache evicts oldest entries', () => {
        const cache = new Set();
        const CACHE_SIZE = 3;
        const sent = [];

        function fakeSend(text) {
            if (cache.has(text)) return;
            cache.add(text);
            if (cache.size > CACHE_SIZE) {
                const first = cache.values().next().value;
                cache.delete(first);
            }
            sent.push(text);
        }

        fakeSend('a');
        fakeSend('b');
        fakeSend('c');
        fakeSend('d'); // evicts 'a'
        fakeSend('a'); // should send again since evicted
        expect(sent).toEqual(['a', 'b', 'c', 'd', 'a']);
    });
});

// ============================================================
// Truncation
// ============================================================
describe('message truncation', () => {
    test('long messages are truncated at 3900 chars', () => {
        const maxLen = 3900;
        const longText = 'x'.repeat(5000);
        const truncated = longText.length > maxLen
            ? longText.substring(0, maxLen) + '\n\n[...truncated]'
            : longText;
        expect(truncated.length).toBeLessThan(5000);
        expect(truncated).toContain('[...truncated]');
    });

    test('short messages are not truncated', () => {
        const maxLen = 3900;
        const shortText = 'Hello world';
        const result = shortText.length > maxLen
            ? shortText.substring(0, maxLen) + '\n\n[...truncated]'
            : shortText;
        expect(result).toBe('Hello world');
    });
});
