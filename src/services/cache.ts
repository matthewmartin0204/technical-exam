import Redis from "ioredis";
import { createLogger } from "../main/log";

const log = createLogger("cache");

// Redis configuration
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const CACHE_PREFIX = process.env.CACHE_PREFIX || "bom:warning:";
const DEFAULT_TTL_SECONDS = parseInt(process.env.CACHE_DEFAULT_TTL || "3600", 10); // 1 hour default

let redis: Redis | null = null;
let isConnected = false;

/**
 * Initialize Redis connection
 */
export function getRedisClient(): Redis {
  if (!redis) {
    redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        const delay = Math.min(times * 100, 3000);
        log.warn({ attempt: times, delay }, "Redis connection retry");
        return delay;
      },
      lazyConnect: false,
    });

    redis.on("connect", () => {
      isConnected = true;
      log.info({ url: REDIS_URL }, "Redis connected");
    });

    redis.on("error", (err) => {
      isConnected = false;
      log.error({ err }, "Redis error");
    });

    redis.on("close", () => {
      isConnected = false;
      log.info("Redis connection closed");
    });
  }

  return redis;
}

/**
 * Check if Redis is connected
 */
export function isCacheConnected(): boolean {
  return isConnected;
}

/**
 * Calculate TTL from ISO expiry time string
 */
export function calculateTtlFromExpiry(expiryTimeIso: string): number {
  const expiryTime = new Date(expiryTimeIso).getTime();
  const now = Date.now();
  const ttlMs = expiryTime - now;

  // If already expired or invalid, use default TTL
  if (ttlMs <= 0 || isNaN(ttlMs)) {
    log.debug({ expiryTimeIso }, "Expiry time in past, using default TTL");
    return DEFAULT_TTL_SECONDS;
  }

  // Convert to seconds, with a minimum of 60 seconds
  const ttlSeconds = Math.max(60, Math.floor(ttlMs / 1000));
  return ttlSeconds;
}

/**
 * Cached warning data structure
 */
export interface CachedWarning {
  productType?: string;
  service: string;
  start?: string;
  expiry?: string;
  text: string;
  cachedAt: string;
}

/**
 * Get a warning from cache
 */
export async function getCachedWarning(warningId: string): Promise<CachedWarning | null> {
  try {
    const client = getRedisClient();
    const key = `${CACHE_PREFIX}${warningId}`;
    const data = await client.get(key);

    if (data) {
      log.debug({ warningId }, "Cache hit");
      return JSON.parse(data);
    }

    log.debug({ warningId }, "Cache miss");
    return null;
  } catch (err) {
    log.error({ err, warningId }, "Cache get error");
    return null;
  }
}

/**
 * Store a warning in cache with TTL based on expiry time
 */
export async function setCachedWarning(
  warningId: string,
  warning: CachedWarning
): Promise<void> {
  try {
    const client = getRedisClient();
    const key = `${CACHE_PREFIX}${warningId}`;
    const ttl = warning.expiry 
      ? calculateTtlFromExpiry(warning.expiry) 
      : DEFAULT_TTL_SECONDS;

    await client.setex(key, ttl, JSON.stringify(warning));

    log.debug({ warningId, ttl }, "Cached warning");
  } catch (err) {
    log.error({ err, warningId }, "Cache set error");
    // Don't throw - caching failures shouldn't break the app
  }
}

/**
 * Delete a warning from cache
 */
export async function deleteCachedWarning(warningId: string): Promise<void> {
  try {
    const client = getRedisClient();
    const key = `${CACHE_PREFIX}${warningId}`;
    await client.del(key);
    log.debug({ warningId }, "Deleted cached warning");
  } catch (err) {
    log.error({ err, warningId }, "Cache delete error");
  }
}

/**
 * Get cache statistics
 */
export async function getCacheStats(): Promise<{
  connected: boolean;
  keys?: number;
  memory?: string;
} | null> {
  if (!redis || !isConnected) {
    return { connected: false };
  }

  try {
    const info = await redis.info("memory");
    const memoryMatch = info.match(/used_memory_human:(\S+)/);
    
    const keys = await redis.keys(`${CACHE_PREFIX}*`);

    return {
      connected: true,
      keys: keys.length,
      memory: memoryMatch ? memoryMatch[1] : "unknown",
    };
  } catch (err) {
    log.error({ err }, "Failed to get cache stats");
    return { connected: false };
  }
}

/**
 * Gracefully close Redis connection
 */
export async function closeCache(): Promise<void> {
  if (redis) {
    log.info("Closing Redis connection");
    await redis.quit();
    redis = null;
    isConnected = false;
    log.info("Redis connection closed");
  }
}
