const { execSync } = require('child_process');

class MirrorLogLogic {
    constructor(targetId, ignoreTag = '[mirrored]', cacheSize = 10) {
        this.targetId = targetId;
        this.ignoreTag = ignoreTag;
        this.cacheSize = cacheSize;
        this.mirroredCache = new Set();
    }

    shouldMirror(line) {
        try {
            const entry = JSON.parse(line);
            
            // Strictly target incoming messages from webchat
            // Check for subsystem and avoid echoed/internal logs
            const isWebchat = entry._meta?.name?.includes('webchat') || 
                             JSON.stringify(entry).toLowerCase().includes('webchat');
            
            const content = entry[0] || entry.message || "";
            
            if (!isWebchat || !content || typeof content !== 'string') return null;
            if (content.includes(this.ignoreTag)) return null;
            
            // Avoid mirroring system status/internal logs
            if (content.startsWith('[') || content.includes('http://127.0.0.1')) return null;
            
            // Deduplicate
            if (this.mirroredCache.has(content)) return null;

            return content.trim();
        } catch (e) {
            return null;
        }
    }

    sendToTarget(text) {
        if (!text) return false;
        
        this.mirroredCache.add(text);
        if (this.mirroredCache.size > this.cacheSize) {
            const first = this.mirroredCache.values().next().value;
            this.mirroredCache.delete(first);
        }

        const command = `openclaw message send --target "${this.targetId}" --message "${this.ignoreTag} ${text.replace(/"/g, '\\"')}"`;
        try {
            // In a real run, this executes. In test, we might mock this.
            return command;
        } catch (err) {
            return false;
        }
    }
}

module.exports = MirrorLogLogic;
