import express, { Request, Response, NextFunction } from 'express';
import { WTSWebhookPayload } from './types';
import { enqueueWebhook } from './queue/webhook.queue';
import { logger } from './utils/logger';
import { CONFIG } from './config/constants';

const app = express();
app.use(express.json({ limit: '1mb' }));

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    env: CONFIG.NODE_ENV,
  });
});

// ─── WTS Webhook ──────────────────────────────────────────────────────────────

app.post('/webhook/wts', (req: Request, res: Response) => {
  // Basic token auth — WTS sends Authorization header or query param
  const authHeader = req.headers['authorization'];
  const tokenFromHeader = authHeader?.replace('Bearer ', '').trim();
  const tokenFromQuery = req.query.token as string | undefined;
  const receivedToken = tokenFromHeader || tokenFromQuery;

  if (CONFIG.WEBHOOK_SECRET && receivedToken !== CONFIG.WEBHOOK_SECRET) {
    logger.warn('Webhook rejected — invalid token', { ip: req.ip });
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const payload = req.body as WTSWebhookPayload;

  if (!payload.sessionId) {
    res.status(400).json({ error: 'Invalid payload' });
    return;
  }

  // Respond immediately (< 1s) — WTS expects fast ACK
  res.status(200).json({ received: true });

  // Enqueue with debounce — BullMQ handles dedup via jobId = sessionId
  enqueueWebhook(payload).catch((err: unknown) => {
    logger.error('enqueueWebhook error', err);
  });
});

// ─── 404 ──────────────────────────────────────────────────────────────────────

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Error handler ────────────────────────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled Express error', err);
  res.status(500).json({ error: 'Internal server error' });
});

export { app };
