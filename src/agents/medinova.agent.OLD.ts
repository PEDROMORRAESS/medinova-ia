import { WTSWebhookPayload, WTSMessage, MedinovaSession } from '../types';
import { redisService } from '../services/redis.service';
import { wtsService, parsePhone } from '../services/wts.service';
import { openaiService } from '../services/openai.service';
import { splitIntoSegments } from '../utils/message-formatter';
import { runEngine, buildHandoffTags } from '../flow/engine';
import {
  MESSAGE_DELAY_MS, MAX_SEGMENTS, BUSINESS_TIMEZONE, BUSINESS_SCHEDULE, CONFIG,
} from '../config/constants';
import { logger } from '../utils/logger';
import { telegramService } from '../services/telegram.service';

// ─── Prompt injection guard ────────────────────────────────────────────────

const INJECTION_PATTERNS = [
  /ignore\s+(previous|all|prior|your)\s+(instructions?|rules?|prompts?)/i,
  /you are now/i, /forget\s+(everything|your|all)/i,
  /\bDAN\b/, /act as (if you are|an?\s)/i,
  /jailbreak/i, /pretend (you|to be)/i,
];
function detectPromptInjection(text: string): boolean {
  return INJECTION_PATTERNS.some(p => p.test(text));
}

// ─── Business hours ────────────────────────────────────────────────────────

function isAfterHours(): boolean {
  const now = new Date();
  const dayOfWeek = new Date(
    now.toLocaleString('en-US', { timeZone: BUSINESS_TIMEZONE })
  ).getDay();
  const hour = parseInt(
    now.toLocaleString('en-US', { timeZone: BUSINESS_TIMEZONE, hour: 'numeric', hour12: false }),
    10
  );
  const schedule = BUSINESS_SCHEDULE[dayOfWeek];
  if (!schedule) return true;
  return hour < schedule.start || hour >= schedule.end;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function sendSegmented(from: string, to: string, text: string): Promise<void> {
  if (!text?.trim()) return;
  const segments = splitIntoSegments(text).slice(0, MAX_SEGMENTS);
  for (let i = 0; i < segments.length; i++) {
    if (i > 0) await delay(MESSAGE_DELAY_MS);
    await wtsService.sendMessage(from, to, segments[i]);
  }
}

// ─── Patient type detection ────────────────────────────────────────────────

type PatientType = 'novo' | 'retornante' | 'interna' | 'thianny';

function detectPatientType(tags: string[] | null): PatientType {
  if (!tags || tags.length === 0) return 'novo';
  const t = tags.map(x => x.toLowerCase());
  if (t.some(x => x === 'equipe interna')) return 'interna';
  if (t.some(x => x.includes('thianny') && (x.includes('tráfego') || x.includes('trafego')))) return 'thianny';
  if (t.some(x => x === 'já é paciente' || x === 'ja e paciente')) return 'retornante';
  return 'novo';
}

// ─── Resolve message text ──────────────────────────────────────────────────

async function resolveText(msg: WTSMessage): Promise<string | null> {
  if (msg.type === 'TEXT' && msg.text) return msg.text;
  const fileUrl = msg.file?.publicUrl;
  if (msg.type === 'AUDIO') {
    if (fileUrl) return `[Áudio]: ${await openaiService.transcribeAudio(fileUrl)}`;
    return '[Áudio não transcrito. Peça para digitar.]';
  }
  if (msg.type === 'IMAGE') {
    if (fileUrl) return `[Imagem]: ${await openaiService.analyzeImage(fileUrl)}`;
    return '[Imagem não processada. Peça para descrever.]';
  }
  if (msg.type === 'DOCUMENT') {
    if (fileUrl) return `[Documento]: ${await openaiService.extractDocument(fileUrl)}`;
    return '[Documento não processado. Peça para digitar.]';
  }
  if (msg.type === 'VIDEO') return '[Vídeo recebido. Peça para descrever por texto.]';
  return null;
}

// ─── Entry point ──────────────────────────────────────────────────────────

export async function processWithMedinova(
  payload: WTSWebhookPayload,
  messages: WTSMessage[]
): Promise<void> {
  const { sessionId, contact, channel } = payload;
  const from = channel.key;
  const telefone = parsePhone(contact.phonenumber);

  try {
    // ── Pre-routing by contact tags ─────────────────────────────────────────
    const patientType = detectPatientType(contact.tags);

    if (patientType === 'thianny') {
      logger.info('Thianny tag → chatbot', { sessionId });
      await wtsService.sendToChatbot(CONFIG.WTS_BOT_KEY_THIANNY, sessionId, from, telefone);
      return;
    }
    if (patientType === 'interna') {
      logger.info('Internal team → transfer', { sessionId });
      await wtsService.transferToDepartment(sessionId, CONFIG.WTS_DEPT_COMERCIAL);
      return;
    }

    // ── Rate limiting ────────────────────────────────────────────────────────
    const { allowed } = await redisService.checkRateLimit(sessionId);
    if (!allowed) {
      await sendSegmented(from, telefone, 'Muitas mensagens em pouco tempo. Aguarde alguns minutos.');
      return;
    }

    // ── Resolve message text ─────────────────────────────────────────────────
    const texts: string[] = [];
    for (const msg of messages) {
      const t = await resolveText(msg);
      if (t) texts.push(t);
    }
    if (texts.length === 0) { logger.warn('No text to process', { sessionId }); return; }

    const fullText = texts.join('\n');

    // ── Guardrails ───────────────────────────────────────────────────────────
    if (detectPromptInjection(fullText)) {
      await sendSegmented(from, telefone, 'Só consigo ajudar com agendamentos da Medinova.');
      return;
    }

    // ── Session load / init ──────────────────────────────────────────────────
    let session = await redisService.getSession(sessionId);
    if (!session) {
      session = {
        sessionId, contactId: contact.id,
        nome: contact.name || undefined,
        telefone, from,
        conversationHistory: [],
        lastActivity: Date.now(),
        pacienteRetornante: patientType === 'retornante',
        flowStep: 'init',
        retryCount: 0,
        thiannyPath: false,
      } as MedinovaSession;
      logger.info('New session', { sessionId, patientType });
    }

    // If already done, ignore further messages (team is handling)
    if (session.flowStep === 'done') {
      logger.info('Session done — ignoring message', { sessionId });
      return;
    }

    session.lastActivity = Date.now();

    // ── Run state machine ────────────────────────────────────────────────────
    const afterHours = isAfterHours();
    const result = await runEngine(fullText, session, afterHours);

    logger.info('Engine result', {
      sessionId,
      from: session.flowStep,
      to: result.nextStep,
      action: result.action,
    });

    // Apply session updates
    Object.assign(session, result.sessionUpdates, { flowStep: result.nextStep });

    // Send response
    if (result.response) {
      await sendSegmented(from, telefone, result.response);
    }

    // ── Handle actions ───────────────────────────────────────────────────────
    if (result.action === 'handoff') {
      const tags = buildHandoffTags(session);
      await wtsService.tagContact(session.contactId, tags).catch(() => {});
      logger.info('Handoff: tagged', { contactId: session.contactId, count: tags.length });
      await wtsService.transferToDepartment(sessionId, CONFIG.WTS_DEPT_COMERCIAL).catch(() => {});
      logger.info('Handoff: transferred', { sessionId });
    }

    if (result.action === 'chatbot_thianny') {
      if (CONFIG.WTS_BOT_KEY_THIANNY) {
        await wtsService.sendToChatbot(CONFIG.WTS_BOT_KEY_THIANNY, sessionId, from, telefone).catch(() => {});
        logger.info('Thianny chatbot redirect', { sessionId });
      }
    }

    await redisService.saveSession(session);

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error('processWithMedinova error', err);
    telegramService.notifyError({ sessionId, telefone, funcao: 'processWithMedinova', erro: errMsg }).catch(() => {});
    try {
      await sendSegmented(from ?? '', telefone, 'Desculpe, tive um problema técnico. Tente novamente em instantes!');
    } catch { /* ignore */ }
  }
}
