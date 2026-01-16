// test/mocks/redis-mock.ts
import { EventEmitter } from 'events';

type RedisValue = string | number | Buffer | null;
type RedisHash = Record<string, RedisValue>;
type RedisSet = Set<string>;

interface MockEntry {
    value: RedisValue | RedisHash | RedisSet;
    ttl?: NodeJS.Timeout;
}

class MockRedis extends EventEmitter {
    private store: Map<string, MockEntry> = new Map(); // Made non-private for sharing
    private subscribers: Map<string, Set<(message: string, channel: string) => void>> = new Map(); // Made non-private for sharing

    // Connect (no-op)
    async connect() {
        return Promise.resolve();
    }

    // Quit (clear state)
    async quit() {
        this.store.clear();
        this.subscribers.clear();
    }

    // Duplicate: New client sharing the same store/subscribers
    duplicate() {
        const dup = new MockRedis();
        dup.store = this.store;
        dup.subscribers = this.subscribers;
        return dup;
    }

    // Keys (list keys matching pattern, e.g., 'stream:meta:*')
    async keys(pattern: string): Promise<string[]> {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return Array.from(this.store.keys()).filter(key => regex.test(key));
    }

    // Hashes
    async hSet(key: string, fieldValues: Record<string, RedisValue>) {
        let entry = this.store.get(key) || { value: {} as RedisHash };
        if (!(entry.value instanceof Object && !Array.isArray(entry.value) && !(entry.value instanceof Set))) {
            entry.value = {} as RedisHash;
        }
        Object.assign(entry.value, fieldValues);
        this.store.set(key, entry);
    }

    async hGetAll(key: string): Promise<RedisHash> {
        const entry = this.store.get(key);
        if (entry && entry.value && typeof entry.value === 'object' && !(entry.value instanceof Set)) {
            return entry.value as RedisHash;
        }
        return {};
    }

    // Sets
    async sAdd(key: string, ...members: string[]) {
        let entry = this.store.get(key) || { value: new Set<string>() };
        if (!(entry.value instanceof Set)) {
            entry.value = new Set<string>();
        }
        members.forEach(m => (entry.value as Set<string>).add(m));
        this.store.set(key, entry);
    }

    async sRem(key: string, ...members: string[]) {
        const entry = this.store.get(key);
        if (entry && entry.value instanceof Set) {
            members.forEach(m => (entry.value as Set<string>).delete(m));
        }
    }

    async sMembers(key: string): Promise<string[]> {
        const entry = this.store.get(key);
        if (entry && entry.value instanceof Set) {
            return Array.from(entry.value);
        }
        return [];
    }

    async sCard(key: string): Promise<number> {
        const entry = this.store.get(key);
        if (entry && entry.value instanceof Set) {
            return entry.value.size;
        }
        return 0;
    }

    // TTL / Expiration
    async expire(key: string, seconds: number) {
        const entry = this.store.get(key);
        if (entry) {
            if (entry.ttl) clearTimeout(entry.ttl);
            entry.ttl = setTimeout(() => this.del(key), seconds * 1000);
        }
    }

    async persist(key: string) {
        const entry = this.store.get(key);
        if (entry && entry.ttl) {
            clearTimeout(entry.ttl);
            entry.ttl = undefined;
        }
    }

    async ttl(key: string): Promise<number> {
        // Simplified: Return approximate remaining seconds if TTL set
        // For precise, you'd need to track start time, but this is fine for tests
        const entry = this.store.get(key);
        if (!entry) return -2; // Key doesn't exist
        if (!entry.ttl) return -1; // Persistent
        return 60; // Arbitrary positive for "has TTL"
    }

    // Delete
    async del(key: string) {
        const entry = this.store.get(key);
        if (entry?.ttl) clearTimeout(entry.ttl);
        this.store.delete(key);
    }

    // Pub/Sub
    async publish(channel: string, message: string) {
        const subs = this.subscribers.get(channel) || new Set();
        for (const cb of subs) {
            cb(message, channel);
        }
    }

    pSubscribe(pattern: string, callback: (message: string, channel: string) => void) {
        // Simplified for your 'updates:*' usage (treat as exact match)
        const channel = pattern;
        if (!this.subscribers.has(channel)) {
            this.subscribers.set(channel, new Set());
        }
        this.subscribers.get(channel)!.add(callback);
    }

    // Reset for tests
    reset() {
        this.store.clear();
        this.subscribers.clear();
        // No need to clear timeouts; they'll reference cleared store
    }
}

// Export singleton
export const mockRedis = new MockRedis();