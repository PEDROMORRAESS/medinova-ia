import axios, { AxiosError } from 'axios';
import { CONFIG, WTS_BASE_URL, WTS_REQUEST_TIMEOUT_MS } from '../config/constants';
import { WTSMessage } from '../types';
import { logger } from '../utils/logger';

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${CONFIG.WTS_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

/** Extrai número limpo do formato WTS: "+55|41920003599" → "5541920003599" */
export function parsePhone(raw: string): string {
  return raw.replace(/[^\d]/g, '');
}

/** Retry com backoff exponencial para chamadas críticas */
async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 3
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as AxiosError)?.response?.status;
      // Não retenta erros 4xx (client errors)
      if (status && status >= 400 && status < 500) throw err;
      if (attempt < maxAttempts) {
        const delay = 500 * 2 ** (attempt - 1);
        logger.warn(`${label} attempt ${attempt} failed, retrying in ${delay}ms`, { status });
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

export const wtsService = {
  // ─── Messages ───────────────────────────────────────────────────────────────

  async fetchNewMessages(sessionId: string, after: string): Promise<WTSMessage[]> {
    try {
      const response = await axios.get(
        `${WTS_BASE_URL}/chat/v1/session/${sessionId}/message`,
        {
          headers: headers(),
          timeout: WTS_REQUEST_TIMEOUT_MS,
          params: {
            'CreatedAt.After': after,
            OrderBy: 'createdAt',
            OrderDirection: 'ASCENDING',
          },
        }
      );
      const items: WTSMessage[] = response.data?.items || [];
      return items.filter(
        (msg) => msg.direction === 'FROM_HUB' && msg.origin === 'GATEWAY'
      );
    } catch (err) {
      logger.error('wtsService.fetchNewMessages error', err);
      return [];
    }
  },

  async sendMessage(from: string, to: string, texto: string): Promise<void> {
    const toClean = parsePhone(to);
    const fromClean = parsePhone(from);
    logger.info('Sending message', { from: fromClean, to: toClean, chars: texto.length });
    await withRetry(async () => {
      const res = await axios.post(
        `${WTS_BASE_URL}/chat/v1/message/send`,
        { from: fromClean, to: toClean, body: { text: texto } },
        { headers: headers(), timeout: WTS_REQUEST_TIMEOUT_MS }
      );
      logger.info('Message sent', { status: res.status });
    }, 'sendMessage');
  },

  async sendInternalNote(sessionId: string, text: string): Promise<void> {
    try {
      await axios.post(
        `${WTS_BASE_URL}/chat/v1/session/${sessionId}/note`,
        { text },
        { headers: { ...headers(), 'Content-Type': 'application/*+json' }, timeout: WTS_REQUEST_TIMEOUT_MS }
      );
      logger.info('Internal note sent', { sessionId });
    } catch (err) {
      logger.error('sendInternalNote error', err);
    }
  },

  async transferToDepartment(sessionId: string, departmentId: string): Promise<void> {
    if (!departmentId) {
      logger.warn('transferToDepartment: departmentId not configured, skipping');
      return;
    }
    try {
      await withRetry(async () => {
        await axios.put(
          `${WTS_BASE_URL}/chat/v1/session/${sessionId}/transfer`,
          { type: 'DEPARTMENT', newDepartmentId: departmentId, options: { stopBotInExecution: true } },
          { headers: { ...headers(), 'content-type': 'application/*+json' }, timeout: WTS_REQUEST_TIMEOUT_MS }
        );
      }, 'transferToDepartment');
      logger.info('Session transferred', { sessionId, departmentId });
    } catch (err: unknown) {
      const e = err as AxiosError;
      logger.error('transferToDepartment error', { sessionId, status: e.response?.status, data: e.response?.data });
    }
  },

  async sendToChatbot(botKey: string, sessionId: string, from: string, to: string): Promise<void> {
    if (!botKey) {
      logger.warn('sendToChatbot: botKey not configured, skipping');
      return;
    }
    const fromClean = parsePhone(from);
    const toClean = parsePhone(to);
    logger.info('sendToChatbot request', { botKey, sessionId, from: fromClean, to: toClean });
    try {
      await withRetry(async () => {
        const res = await axios.post(
          `${WTS_BASE_URL}/chat/v1/chatbot/send`,
          {
            botKey,
            from: fromClean,
            to: toClean,
            options: {
              skipIfBotInExecution: false,
              skipIfInProgress: false,
              forceStartSession: false,
            },
          },
          { headers: { ...headers(), 'content-type': 'application/*+json' }, timeout: WTS_REQUEST_TIMEOUT_MS }
        );
        logger.info('sendToChatbot response', { status: res.status, data: res.data });
      }, 'sendToChatbot');
      logger.info('Session sent to chatbot', { botKey, sessionId });
    } catch (err: unknown) {
      const e = err as AxiosError;
      logger.error('sendToChatbot error', {
        botKey, sessionId, from: fromClean, to: toClean,
        status: e.response?.status, data: e.response?.data,
        message: e.message,
      });
    }
  },

  async tagContact(contactId: string, tagIds: string[]): Promise<void> {
    const validIds = tagIds.filter(Boolean);
    if (validIds.length === 0) return;
    try {
      await withRetry(async () => {
        await axios.post(
          `${WTS_BASE_URL}/core/v1/contact/${contactId}/tags`,
          { tagIds: validIds },
          { headers: { ...headers(), 'content-type': 'application/*+json' }, timeout: WTS_REQUEST_TIMEOUT_MS }
        );
      }, 'tagContact');
      logger.info('Contact tagged', { contactId, count: validIds.length });
    } catch (err: unknown) {
      const e = err as AxiosError;
      logger.error('tagContact error', { contactId, status: e.response?.status, data: e.response?.data });
    }
  },
};
