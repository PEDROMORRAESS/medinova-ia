import dotenv from 'dotenv';
dotenv.config();

import { app } from './server';
import { redisService } from './services/redis.service';
import { startWebhookWorker } from './queue/webhook.queue';
import { startTimeoutWorker } from './queue/timeout.queue';
import { CONFIG } from './config/constants';
import { logger } from './utils/logger';
import { telegramService } from './services/telegram.service';

async function freePort(port: number): Promise<void> {
  const { execSync } = await import('child_process');
  try {
    const pid = execSync(
      `powershell -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess"`,
      { stdio: 'pipe' }
    ).toString().trim();
    if (pid && !isNaN(Number(pid))) {
      execSync(`powershell -Command "Stop-Process -Id ${pid} -Force"`, { stdio: 'pipe' });
      logger.info(`Freed port ${port} (killed PID ${pid})`);
    }
  } catch {
    // porta já estava livre
  }
}

async function bootstrap(): Promise<void> {
  logger.info('Starting Medinova Agent...');
  await freePort(CONFIG.PORT);

  // Connect Redis (session store)
  try {
    await redisService.connect();
    logger.info('Redis ready');
  } catch (err) {
    logger.error('Redis connection failed — aborting', err);
    process.exit(1);
  }

  // Start BullMQ workers
  const worker = startWebhookWorker();
  const timeoutWorker = startTimeoutWorker();

  // Start HTTP server
  const server = app.listen(CONFIG.PORT, () => {
    telegramService.notifyStartup().catch(() => {});
    logger.info('Medinova Agent running', {
      port: CONFIG.PORT,
      env: CONFIG.NODE_ENV,
      model: CONFIG.AGENT_MODEL,
      webhook: `http://localhost:${CONFIG.PORT}/webhook/wts`,
      health: `http://localhost:${CONFIG.PORT}/health`,
    });
  });

  // Graceful shutdown
  async function shutdown(signal: string): Promise<void> {
    logger.info(`${signal} — shutting down gracefully`);
    await Promise.all([worker.close(), timeoutWorker.close()]);
    server.close(() => process.exit(0));
  }

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}

bootstrap().catch((err: unknown) => {
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
