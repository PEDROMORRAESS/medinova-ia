import OpenAI from 'openai';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse') as (buffer: Buffer) => Promise<{ text: string }>;
import { CONFIG, AGENT_MODEL, SUMMARY_MODEL, COST_INPUT_PER_M, COST_OUTPUT_PER_M } from '../config/constants';
import { ConversationMessage } from '../types';
import { logger } from '../utils/logger';
import { withRetry } from '../utils/retry';

const openai = new OpenAI({ apiKey: CONFIG.OPENAI_API_KEY });

/** Log token usage and estimated cost */
function logUsage(model: string, usage: OpenAI.CompletionUsage | undefined): void {
  if (!usage) return;
  const inputCost = (usage.prompt_tokens / 1_000_000) * COST_INPUT_PER_M;
  const outputCost = (usage.completion_tokens / 1_000_000) * COST_OUTPUT_PER_M;
  logger.info('Token usage', {
    model,
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    cached_tokens: (usage as { prompt_tokens_details?: { cached_tokens?: number } })
      .prompt_tokens_details?.cached_tokens ?? 0,
    cost_usd: parseFloat((inputCost + outputCost).toFixed(6)),
  });
}

export const openaiService = {
  /** Transcribe audio file (URL) using OpenAI Whisper */
  async transcribeAudio(audioUrl: string): Promise<string> {
    return withRetry(
      async () => {
        logger.info('Transcribing audio', { url: audioUrl });
        const response = await axios.get<ArrayBuffer>(audioUrl, { responseType: 'arraybuffer' });

        const tmpFile = path.join(os.tmpdir(), `medinova_audio_${Date.now()}.ogg`);
        fs.writeFileSync(tmpFile, Buffer.from(response.data));

        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tmpFile) as unknown as File,
          model: 'whisper-1',
          language: 'pt',
        });

        fs.unlinkSync(tmpFile);
        logger.info('Audio transcribed', { preview: transcription.text.substring(0, 80) });
        return transcription.text;
      },
      { label: 'transcribeAudio' }
    ).catch((err) => {
      logger.error('transcribeAudio failed after retries', err);
      return '[Áudio não transcrito]';
    });
  },

  /** Extract text from a PDF document (URL) */
  async extractDocument(docUrl: string): Promise<string> {
    return withRetry(
      async () => {
        logger.info('Extracting document', { url: docUrl });
        const response = await axios.get<ArrayBuffer>(docUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data);

        // Tenta extrair texto do PDF
        const parsed = await pdfParse(buffer);
        const text = parsed.text.trim();

        if (text.length < 10) {
          // PDF sem texto extraível (escaneado) — analisa como imagem via GPT-4o Vision
          logger.info('PDF sem texto — tentando Vision', { url: docUrl });
          const base64 = buffer.toString('base64');
          const mimeType = 'application/pdf';
          const visionResponse = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'Extraia todo o texto ou informações relevantes deste documento.' },
                  { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
                ],
              },
            ],
            max_tokens: 500,
          });
          logUsage('gpt-4o-vision-pdf', visionResponse.usage);
          return visionResponse.choices[0]?.message?.content || '[Documento não lido]';
        }

        logger.info('Document extracted', { chars: text.length });
        return text.slice(0, 2000); // limita para não explodir o contexto
      },
      { label: 'extractDocument' }
    ).catch((err) => {
      logger.error('extractDocument failed', err);
      return '[Documento recebido mas não foi possível ler. Peça para o paciente digitar.]';
    });
  },

  /** Describe image using GPT-4o Vision */
  async analyzeImage(imageUrl: string): Promise<string> {
    return withRetry(
      async () => {
        logger.info('Analyzing image', { url: imageUrl });
        const response = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Descreva brevemente o que está nesta imagem enviada pelo paciente.' },
                { type: 'image_url', image_url: { url: imageUrl } },
              ],
            },
          ],
          max_tokens: 300,
        });
        logUsage('gpt-4o-vision', response.usage);
        return response.choices[0]?.message?.content || '[Imagem não analisada]';
      },
      { label: 'analyzeImage' }
    ).catch((err) => {
      logger.error('analyzeImage failed after retries', err);
      return '[Imagem não analisada]';
    });
  },

  /**
   * Summarize old conversation messages to keep context window lean.
   * Uses gpt-4o-mini (cheap + fast).
   */
  async summarizeHistory(messages: ConversationMessage[]): Promise<string> {
    return withRetry(
      async () => {
        const text = messages
          .filter((m) => m.content)
          .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
          .join('\n');

        const response = await openai.chat.completions.create({
          model: SUMMARY_MODEL,
          messages: [
            {
              role: 'system',
              content:
                'Você resume conversas de atendimento médico. Preserve: nome do paciente, especialidade desejada, tipo de atendimento (particular/convênio), convênio informado, médico preferido, motivo da consulta e qualquer decisão tomada. Seja conciso.',
            },
            { role: 'user', content: `Resuma esta conversa:\n\n${text}` },
          ],
          max_tokens: 500,
        });
        logUsage(SUMMARY_MODEL, response.usage);
        return response.choices[0]?.message?.content || '';
      },
      { label: 'summarizeHistory' }
    );
  },

  /** Run the agent with function calling tools. */
  async runAgent(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: OpenAI.Chat.ChatCompletionTool[]
  ): Promise<OpenAI.Chat.ChatCompletionMessage> {
    return withRetry(
      async () => {
        const response = await openai.chat.completions.create({
          model: AGENT_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            ...(messages as OpenAI.Chat.ChatCompletionMessageParam[]),
          ],
          tools,
          tool_choice: 'auto',
          max_tokens: 2048,
        });
        logUsage(AGENT_MODEL, response.usage);
        return response.choices[0].message;
      },
      { label: 'runAgent' }
    );
  },
};
