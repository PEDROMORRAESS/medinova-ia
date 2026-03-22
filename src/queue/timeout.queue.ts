import { Queue, Worker, Job } from 'bullmq';
import { CONFIG } from '../config/constants';
import { redisService } from '../services/redis.service';
import { wtsService } from '../services/wts.service';
import { logger } from '../utils/logger';
import { buildHandoffTags } from '../agents/medinova.agent';

const INACTIVITY_MS = 5 * 60 * 1000; // 5 minutos

const connection = {
  host: CONFIG.REDIS_HOST,
  port: CONFIG.REDIS_PORT,
  password: CONFIG.REDIS_PASSWORD || undefined,
  db: CONFIG.REDIS_DB,
};

const timeoutQueue = new Queue('medinova-timeout', {
  connection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 5,
    attempts: 1,
  },
});

/**
 * Agenda (ou reinicia) o timer de inatividade para uma sessão.
 * Chame após o bot responder ao paciente.
 */
export async function scheduleInactivityTimeout(sessionId: string): Promise<void> {
  // Cancela timer anterior se existir
  const existing = await timeoutQueue.getJob(sessionId);
  if (existing) await existing.remove().catch(() => {});

  await timeoutQueue.add('timeout', { sessionId }, {
    jobId: sessionId,
    delay: INACTIVITY_MS,
  });

  logger.info('Inactivity timeout scheduled', { sessionId, minutes: 5 });
}

/**
 * Cancela o timer de inatividade.
 * Chame quando o paciente enviar uma nova mensagem.
 */
export async function cancelInactivityTimeout(sessionId: string): Promise<void> {
  const existing = await timeoutQueue.getJob(sessionId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'delayed' || state === 'waiting') {
      await existing.remove().catch(() => {});
      logger.info('Inactivity timeout cancelled', { sessionId });
    }
  }
}

/**
 * Worker que processa os timeouts de inatividade.
 */
export function startTimeoutWorker(): Worker {
  const worker = new Worker(
    'medinova-timeout',
    async (job: Job<{ sessionId: string }>) => {
      const { sessionId } = job.data;
      logger.info('Inactivity timeout fired — transferring to team', { sessionId });

      const session = await redisService.getSession(sessionId);

      // Aplica etiquetas com dados coletados até o momento (se sessão ainda existe)
      if (session) {
        const tags = buildHandoffTags(session);
        if (tags.length > 0) {
          await wtsService.tagContact(session.contactId, tags).catch(() => {});
          logger.info('Inactivity timeout: tags applied', { sessionId, count: tags.length });
        }
      } else {
        logger.info('Session expired or not found — transfer without tags', { sessionId });
      }

      // Transfere para Comercial Medinova
      if (CONFIG.WTS_DEPT_COMERCIAL) {
        await wtsService.transferToDepartment(sessionId, CONFIG.WTS_DEPT_COMERCIAL).catch(() => {});
        logger.info('Session transferred after 5min inactivity', { sessionId });
      }
    },
    { connection, concurrency: 10 }
  );

  worker.on('completed', (job) => {
    logger.info('Timeout job completed', { sessionId: job.data.sessionId });
  });

  worker.on('failed', (job, err) => {
    logger.error('Timeout job failed', { sessionId: job?.data?.sessionId, error: (err as Error).message });
  });

  logger.info('BullMQ timeout worker started (medinova-timeout)');
  return worker;
}
