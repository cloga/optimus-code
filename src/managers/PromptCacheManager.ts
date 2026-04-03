import * as crypto from 'crypto';

/**
 * Represents a prompt split into shared (cacheable) prefix and unique suffix.
 * The shared prefix is identical across parallel workers in the same batch,
 * enabling LLM prompt caching to avoid re-processing shared context.
 */
export interface PromptParts {
    /** Shared content: system instructions, memory, project context */
    sharedPrefix: string;
    /** Unique content: role name, task-specific text, output path */
    uniqueSuffix: string;
    /** SHA256 hash of sharedPrefix for cache key matching */
    cacheKey: string;
    /** Full prompt as single string (for fallback) */
    fullPrompt: string;
}

/**
 * Cache entry for a prompt prefix.
 */
interface CachedPrefix {
    cacheKey: string;
    prefixByteLength: number;
    createdAt: number;
    hitCount: number;
    /** TTL in ms (default 30 minutes) */
    ttlMs: number;
}

// ── Sentinel that marks the boundary between shared and unique content ──
const CACHE_SPLIT_SENTINEL = '\n\n=== TASK-SPECIFIC CONTENT BELOW ===\n\n';

/**
 * PromptCacheManager splits monolithic prompts into cacheable prefix + unique suffix.
 *
 * When multiple workers are spawned in parallel (e.g. council dispatch),
 * they share identical system instructions, project memory, and user memory.
 * By splitting prompts at a consistent boundary, LLM APIs can cache the
 * shared prefix and only process the unique suffix per worker — saving
 * tokens and reducing latency.
 *
 * Claude API supports this via `cache_control: { type: "ephemeral" }` on
 * content blocks. The AcpAdapter passes this through when available.
 */
export class PromptCacheManager {
    private static cache = new Map<string, CachedPrefix>();

    /**
     * Compute a SHA256 hash of a string for use as cache key.
     */
    static hashPrefix(prefix: string): string {
        return crypto.createHash('sha256').update(prefix, 'utf8').digest('hex').slice(0, 16);
    }

    /**
     * Split a fully-assembled basePrompt into shared prefix and unique suffix.
     *
     * The split happens at the "Task Description:" boundary — everything before
     * it is shared context (system instructions, persona, memory, tracking),
     * everything after is task-specific (role perspective, output path, skills).
     *
     * @param basePrompt - The complete prompt string from delegateTaskSingle()
     * @returns PromptParts with prefix, suffix, cache key, and full fallback
     */
    static splitPromptForCache(basePrompt: string): PromptParts {
        // Find the best split boundary: "Task Description:" marker
        const splitMarkers = [
            'Task Description:\n',
            'Task Description: \n',
            'Goal: Execute the following task.',
        ];

        let splitIndex = -1;
        for (const marker of splitMarkers) {
            const idx = basePrompt.indexOf(marker);
            if (idx !== -1) {
                splitIndex = idx;
                break;
            }
        }

        // If no marker found, fall back to 80% prefix / 20% suffix heuristic
        if (splitIndex === -1) {
            splitIndex = Math.floor(basePrompt.length * 0.8);
            // Try to split on a newline boundary
            const newlineIdx = basePrompt.lastIndexOf('\n', splitIndex);
            if (newlineIdx > splitIndex * 0.5) {
                splitIndex = newlineIdx + 1;
            }
        }

        const sharedPrefix = basePrompt.slice(0, splitIndex);
        const uniqueSuffix = basePrompt.slice(splitIndex);
        const cacheKey = this.hashPrefix(sharedPrefix);

        // Track cache entry
        const existing = this.cache.get(cacheKey);
        if (existing) {
            existing.hitCount++;
        } else {
            this.cache.set(cacheKey, {
                cacheKey,
                prefixByteLength: Buffer.byteLength(sharedPrefix, 'utf8'),
                createdAt: Date.now(),
                hitCount: 1,
                ttlMs: 30 * 60 * 1000, // 30 minutes
            });
        }

        // Evict stale entries
        this.evictStale();

        return {
            sharedPrefix,
            uniqueSuffix,
            cacheKey,
            fullPrompt: basePrompt,
        };
    }

    /**
     * Build a prompt from parts, inserting a split sentinel for debugging.
     * This is the inverse of splitPromptForCache — used when constructing
     * prompts that are designed to be split later.
     */
    static buildSplittablePrompt(sharedContext: string, taskContent: string): string {
        return sharedContext + CACHE_SPLIT_SENTINEL + taskContent;
    }

    /**
     * Get cache statistics for observability.
     */
    static getCacheStats(): { entries: number; totalHits: number; totalBytes: number } {
        let totalHits = 0;
        let totalBytes = 0;
        for (const entry of this.cache.values()) {
            totalHits += entry.hitCount;
            totalBytes += entry.prefixByteLength;
        }
        return { entries: this.cache.size, totalHits, totalBytes };
    }

    /**
     * Check if a prefix with the given key is already cached.
     */
    static isCached(cacheKey: string): boolean {
        const entry = this.cache.get(cacheKey);
        if (!entry) return false;
        if (Date.now() - entry.createdAt > entry.ttlMs) {
            this.cache.delete(cacheKey);
            return false;
        }
        return true;
    }

    /**
     * Get hit count for a specific cache key.
     */
    static getHitCount(cacheKey: string): number {
        return this.cache.get(cacheKey)?.hitCount ?? 0;
    }

    /**
     * Clear all cached entries (for testing).
     */
    static clearCache(): void {
        this.cache.clear();
    }

    /**
     * Remove entries that have exceeded their TTL.
     */
    private static evictStale(): void {
        const now = Date.now();
        for (const [key, entry] of this.cache) {
            if (now - entry.createdAt > entry.ttlMs) {
                this.cache.delete(key);
            }
        }
    }
}
