import { Queue, Worker, Job } from 'bullmq';
import { CONFIG, DEBOUNCE_MS } from '../config/constants';
import { WTSWebhookPayload, WTSMessage } from '../types';
import { wtsService } from '../services/wts.service';
import { processWithMedinova } from '../agents/medinova.agent';
import { scheduleInactivityTimeout, cancelInactivityTimeout } from './timeout.queue';
import { logger } from '../utils/logger';
import { telegramService } from '../services/telegram.service';

const connection = {
  host: CONFIG.REDIS_HOST,
  port: CONFIG.REDIS_PORT,
  password: CONFIG.REDIS_PASSWORD || undefined,
  db: CONFIG.REDIS_DB,
};

export const webhookQueue = new Queue('medinova-webhook', {
  connection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 10,
    attempts: 1,
  },
});

/**
 * Enqueue com debounce por sessionId.
 * Se chegar nova mensagem da mesma sessão antes do job rodar,
 * o job anterior é removido e o delay é resetado.
 */
export async function enqueueWebhook(payload: WTSWebhookPayload): Promise<void> {
  const jobId = payload.sessionId;

  // Paciente respondeu — cancela timer de inatividade
  await cancelInactivityTimeout(jobId);

  const existing = await webhookQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'delayed' || state === 'waiting' || state === 'failed') {
      await existing.remove();
      logger.info('Debounce: replaced existing job', { sessionId: jobId, state });
    }
  }

  await webhookQueue.add('process', payload, {
    jobId,
    delay: DEBOUNCE_MS,
  });

  logger.info('Job enqueued', { sessionId: jobId, delayMs: DEBOUNCE_MS });
}

/**
 * Worker que processa os jobs.
 * Busca mensagens novas da API WTS e passa para o agente.
 */
export function startWebhookWorker(): Worker {
  const worker = new Worker(
    'medinova-webhook',
    async (job: Job<WTSWebhookPayload>) => {
      const payload = job.data;
      const { sessionId, lastMessage } = payload;

      logger.info('Processing job', { sessionId, msgId: lastMessage?.id });

      // Timestamp de referência para buscar mensagens novas
      const since = lastMessage?.createdAt
        ? lastMessage.createdAt
        : new Date(Date.now() - 60_000).toISOString();

      // Tenta buscar mensagens via API WTS
      let messages = await wtsService.fetchNewMessages(sessionId, since);

      // Enriquece mensagens sem file (API nem sempre retorna publicUrl para áudio/imagem)
      if (messages.length > 0 && lastMessage?.file) {
        messages = messages.map(msg =>
          msg.id === lastMessage.id && !msg.file
            ? { ...msg, file: lastMessage.file }
            : msg
        );
      }

      // Fallback: usa a mensagem do próprio payload se API não retornar nada
      if (messages.length === 0 && lastMessage) {
        logger.info('API sem mensagens — usando payload fallback', { sessionId });
        messages = [
          {
            id: lastMessage.id,
            type: lastMessage.type,
            text: lastMessage.text,
            direction: 'FROM_HUB',
            origin: 'GATEWAY',
            createdAt: lastMessage.createdAt,
            file: lastMessage.file,
          } as WTSMessage,
        ];
      }

      // Segunda opção de fallback: lastMessagesAggregated do payload
      if (messages.length === 0 && payload.lastMessagesAggregated?.text) {
        logger.info('Usando lastMessagesAggregated como fallback', { sessionId });
        messages = [
          {
            id: 'aggregated',
            type: 'TEXT',
            text: payload.lastMessagesAggregated.text,
            direction: 'FROM_HUB',
            origin: 'GATEWAY',
            createdAt: new Date().toISOString(),
            file: null,
          } as WTSMessage,
        ];
      }

      if (messages.length === 0) {
        logger.info('Nenhuma mensagem para processar', { sessionId });
        return;
      }

      await processWithMedinova(payload, messages);

      // Agenda timer de inatividade: se paciente não responder em 5min → transfere para equipe
      await scheduleInactivityTimeout(sessionId).catch(() => {});
    },
    {
      connection,
      concurrency: 10,
    }
  );

  worker.on('completed', (job) => {
    logger.info('Job completed', { jobId: job.id, sessionId: job.data.sessionId });
  });

  worker.on('failed', (job, err) => {
    const errMsg = (err as Error).message;
    logger.error('Job failed', { jobId: job?.id, error: errMsg });
    telegramService.notifyJobFailed(job?.id || 'unknown', errMsg).catch(() => {});
  });

  logger.info('BullMQ worker started (medinova-webhook)');
  return worker;
}
