import Redis from 'ioredis';
import { CONFIG, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_S } from '../config/constants';
import { SessionContext } from '../types';
import { logger } from '../utils/logger';

class RedisService {
  private client: Redis;

  constructor() {
    this.client = new Redis({
      host: CONFIG.REDIS_HOST,
      port: CONFIG.REDIS_PORT,
      db: CONFIG.REDIS_DB,
      password: CONFIG.REDIS_PASSWORD || undefined,
      lazyConnect: true,
    });

    this.client.on('connect', () => logger.info('Redis connected'));
    this.client.on('error', (err: Error) => logger.error('Redis error', err.message));
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  // ─── Session ────────────────────────────────────────────────────────────────

  private sessionKey(sessionId: string): string {
    return `medinova:session:${sessionId}`;
  }

  async getSession(sessionId: string): Promise<SessionContext | null> {
    try {
      const data = await this.client.get(this.sessionKey(sessionId));
      if (!data) return null;
      return JSON.parse(data) as SessionContext;
    } catch (err) {
      logger.error('Redis getSession error', err);
      return null;
    }
  }

  async saveSession(session: SessionContext): Promise<void> {
    try {
      session.lastActivity = Date.now();
      await this.client.setex(
        this.sessionKey(session.sessionId),
        CONFIG.REDIS_SESSION_TTL,
        JSON.stringify(session)
      );
    } catch (err) {
      logger.error('Redis saveSession error', err);
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    try {
      await this.client.del(this.sessionKey(sessionId));
    } catch (err) {
      logger.error('Redis deleteSession error', err);
    }
  }

  // ─── Processing Lock ──────────────────────────────────────────────────────
  // Prevents duplicate processing when WTS fires the same webhook twice

  /** Returns true if lock was acquired, false if already locked */
  async setLock(key: string, ttlSeconds: number): Promise<boolean> {
    try {
      const result = await this.client.set(key, '1', 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch (err) {
      logger.error('Redis setLock error', err);
      return true; // allow processing on Redis error
    }
  }

  async deleteLock(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (err) {
      logger.error('Redis deleteLock error', err);
    }
  }

  // ─── Rate Limiting ────────────────────────────────────────────────────────────

  async checkRateLimit(sessionId: string): Promise<{ allowed: boolean; remaining: number }> {
    try {
      const key = `medinova:ratelimit:${sessionId}`;
      const count = await this.client.incr(key);
      if (count === 1) await this.client.expire(key, RATE_LIMIT_WINDOW_S);
      const remaining = Math.max(0, RATE_LIMIT_MAX - count);
      return { allowed: count <= RATE_LIMIT_MAX, remaining };
    } catch {
      return { allowed: true, remaining: RATE_LIMIT_MAX }; // permite em caso de erro Redis
    }
  }
}

export const redisService = new RedisService();
