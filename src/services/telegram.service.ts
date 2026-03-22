import axios from 'axios';
import { logger } from '../utils/logger';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

function nowManaus(): string {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Manaus' });
}

async function send(text: string): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
    });
  } catch (err) {
    logger.error('Telegram notify failed', err);
  }
}

export const telegramService = {
  async notifyError(params: {
    sessionId: string;
    telefone?: string;
    nome?: string;
    funcao: string;
    erro: string;
  }): Promise<void> {
    const { sessionId, telefone, nome, funcao, erro } = params;
    const msg = [
      `🚨 <b>Medinova — Erro no Atendimento</b>`,
      ``,
      `📱 Contato: ${nome || 'Desconhecido'} (${telefone || 'sem telefone'})`,
      `🔧 Função: <code>${funcao}</code>`,
      `❌ Erro: <code>${erro.slice(0, 300)}</code>`,
      `🔑 Sessão: <code>${sessionId.slice(0, 8)}...</code>`,
      `🕐 Hora: ${nowManaus()}`,
    ].join('\n');
    await send(msg);
  },

  async notifyJobFailed(jobId: string, erro: string): Promise<void> {
    const msg = [
      `⚠️ <b>Medinova — Job Falhou</b>`,
      ``,
      `🔑 Job: <code>${jobId.slice(0, 8)}...</code>`,
      `❌ Erro: <code>${erro.slice(0, 300)}</code>`,
      `🕐 Hora: ${nowManaus()}`,
    ].join('\n');
    await send(msg);
  },

  async notifyStartup(): Promise<void> {
    await send(`✅ <b>Medinova Agent iniciado</b> — ${nowManaus()}`);
  },
};
