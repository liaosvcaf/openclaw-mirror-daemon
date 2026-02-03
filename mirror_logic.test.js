const MirrorLogLogic = require('./mirror_logic');

describe('MirrorLogLogic', () => {
    let logic;

    beforeEach(() => {
        logic = new MirrorLogLogic('12345');
    });

    test('should identify valid webchat user message', () => {
        const logLine = JSON.stringify({
            0: "Hello Assistant",
            _meta: { name: "gateway/channels/webchat" }
        });
        expect(logic.shouldMirror(logLine)).toBe("Hello Assistant");
    });

    test('should ignore already mirrored messages', () => {
        const logLine = JSON.stringify({
            0: "[mirrored] Hello Assistant",
            _meta: { name: "gateway/channels/webchat" }
        });
        expect(logic.shouldMirror(logLine)).toBeNull();
    });

    test('should ignore system status messages', () => {
        const logLine = JSON.stringify({
            0: "[INFO] Gateway started at http://127.0.0.1",
            _meta: { name: "gateway/channels/webchat" }
        });
        expect(logic.shouldMirror(logLine)).toBeNull();
    });

    test('should deduplicate repeated messages', () => {
        const logLine = JSON.stringify({
            0: "Help me",
            _meta: { name: "gateway/channels/webchat" }
        });
        logic.shouldMirror(logLine);
        logic.sendToTarget("Help me");
        expect(logic.shouldMirror(logLine)).toBeNull();
    });

    test('should ignore non-webchat logs', () => {
        const logLine = JSON.stringify({
            0: "Internal process log",
            _meta: { name: "internal/core" }
        });
        expect(logic.shouldMirror(logLine)).toBeNull();
    });
});
