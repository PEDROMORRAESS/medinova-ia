import dotenv from 'dotenv';
dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// ─── Redis: suporta REDIS_URL (produção) ou vars individuais (dev local) ──────
function parseRedisConfig(): {
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_PASSWORD: string | undefined;
  REDIS_DB: number;
} {
  const url = process.env.REDIS_URL;
  if (url) {
    try {
      const u = new URL(url);
      return {
        REDIS_HOST:     u.hostname,
        REDIS_PORT:     parseInt(u.port) || 6379,
        REDIS_PASSWORD: decodeURIComponent(u.password) || undefined,
        REDIS_DB:       parseInt(u.pathname.slice(1)) || 0,
      };
    } catch {
      throw new Error('Invalid REDIS_URL format');
    }
  }
  return {
    REDIS_HOST:     process.env.REDIS_HOST     || 'localhost',
    REDIS_PORT:     parseInt(process.env.REDIS_PORT || '6379', 10),
    REDIS_PASSWORD: process.env.REDIS_PASSWORD || undefined,
    REDIS_DB:       parseInt(process.env.REDIS_DB  || '1', 10),
  };
}

const _redis = parseRedisConfig();

export const CONFIG = {
  // ─── Server ────────────────────────────────────────────────────────────────
  PORT:     parseInt(process.env.PORT || '3001', 10),
  NODE_ENV: process.env.NODE_ENV || 'development',

  // ─── WTS Chat ──────────────────────────────────────────────────────────────
  WTS_TOKEN: requireEnv('WTS_TOKEN'),

  // ─── OpenAI ────────────────────────────────────────────────────────────────
  OPENAI_API_KEY: requireEnv('OPENAI_API_KEY'),
  AGENT_MODEL:    process.env.AGENT_MODEL || 'gpt-4o-mini',

  // ─── Redis ─────────────────────────────────────────────────────────────────
  REDIS_HOST:        _redis.REDIS_HOST,
  REDIS_PORT:        _redis.REDIS_PORT,
  REDIS_PASSWORD:    _redis.REDIS_PASSWORD,
  REDIS_DB:          _redis.REDIS_DB,
  REDIS_SESSION_TTL: 86400, // 24 horas

  // ─── Optional ──────────────────────────────────────────────────────────────
  WEBHOOK_SECRET:    process.env.WEBHOOK_SECRET    || '',
  TELEGRAM_BOT_TOKEN:process.env.TELEGRAM_BOT_TOKEN|| '',
  TELEGRAM_CHAT_ID:  process.env.TELEGRAM_CHAT_ID  || '',

  // ─── WTS Departments (hardcoded) ───────────────────────────────────────────
  WTS_DEPT_COMERCIAL: '488f05e2-8bbb-496c-8d34-a6fadfb958fd',
  WTS_DEPT_THIANNY:   '18747dd5-82df-4a0d-a64c-fd4f8bd4d6c9',

  // ─── WTS Chatbot Keys (hardcoded) ──────────────────────────────────────────
  WTS_BOT_KEY_THIANNY: 'a320a54c-7ad3-41d8-8b16-d91e2ab2abc3',

  // ─── WTS Tags: tipo de agendamento (hardcoded) ─────────────────────────────
  WTS_TAG_CONSULTA: '98267805-835c-4311-9bb7-e9e6018571ba',
  WTS_TAG_EXAME:    '50e4f528-512a-482b-ba8e-49aa917a6bf0',

  // ─── WTS Tags: tipo de atendimento (hardcoded) ─────────────────────────────
  WTS_TAG_PARTICULAR: '0c226208-a133-4035-a324-d142d28e1d0e',
  WTS_TAG_CONVENIO:   '', // criar no WTS se quiser

  // ─── WTS Tags: origem do contato (hardcoded) ───────────────────────────────
  WTS_TAG_ORIGEM_GOOGLE:    '5c7c192e-3c25-41eb-898a-d97b53ffe086',
  WTS_TAG_ORIGEM_INSTAGRAM: '16592984-fb82-4d79-9dc3-ba9df105b941',
  WTS_TAG_ORIGEM_ANUNCIO:   '998a26c9-b44b-4502-9946-e1bb1205c6d5',
  WTS_TAG_ORIGEM_INDICACAO: 'a4f5b531-930f-43b0-9f68-a123af30f54f',

  // ─── WTS Tags: médicos Gastroenterologia (hardcoded) ───────────────────────
  WTS_TAG_DR_ANA_FIGUEIREDO:  'cd47e7c0-3b5f-42b3-a55f-2dcc0dfe220a',
  WTS_TAG_DR_DOUGLAS_DIAS:    'aa928682-7198-4779-b4ed-b7e1f2f48dd3',
  WTS_TAG_DR_RODRIGO_ALMEIDA: 'af94df07-a6e2-4c72-a9a5-70141b5bb472',
  WTS_TAG_DR_TARICK_LEITE:    '13c4ed14-deb2-4fb7-a5cd-c5a6e930c3a9',
  WTS_TAG_DR_TIAGO_CARDOSO:   '3322243c-3fad-4be7-aa62-b7c11d9fa6ec',
  WTS_TAG_DRA_THIANNY:        'e647130a-a88a-4b7a-b665-48dfcd4bc844',
  WTS_TAG_DR_JOAO:            '6eab6144-aef1-48de-8045-0bb907c0bed8',
  WTS_TAG_DRA_THAIS:          '0ac6837e-e705-45ff-84df-419b03690549',

  // ─── WTS Tags: médicos Nefrologia (hardcoded) ──────────────────────────────
  WTS_TAG_DR_MIGUEL_MOURA: '66c767fd-a9da-4936-8e00-aef663ad3556',

  // ─── WTS Tags: médicos Anestesiologia (criar no WTS se quiser) ─────────────
  WTS_TAG_DRA_ZENIA:          '',
  WTS_TAG_DRA_GISELLE:        '',
  WTS_TAG_DR_THIAGO_MONTEIRO: '',
  WTS_TAG_DR_VICTOR:          '',

  // ─── WTS Tags: especialidades (hardcoded) ──────────────────────────────────
  WTS_TAG_NEFROLOGISTA:       'ac53b7a7-9515-419a-81a8-9aa865efcad5',
  WTS_TAG_ANESTESISTA:        '41d68411-baaf-4569-8a0e-b8d10d679715',
  WTS_TAG_NUTRICIONISTA:      '65dce1dd-291b-4f1a-a528-4e3aa3bf2b5d',
  WTS_TAG_PSICOLOGA:          '4e7da2df-c271-4aeb-9091-7e87932c1059',
  WTS_TAG_BALAO:              'afc42dcc-9863-49e6-a5a5-090fa1228eb5',
  WTS_TAG_BARIATRICA:         '5e624f37-b8a6-4f1b-9950-e4e0d8f840bf',
  WTS_TAG_CIRURGIAO_GASTRO:   '',
  WTS_TAG_CIRURGIAO_TORACICO: '',

  // ─── WTS Tags: tipo de paciente (hardcoded) ────────────────────────────────
  WTS_TAG_JA_E_PACIENTE:   '2f780046-b6b3-4deb-9a33-1beb7ca6590e',
  WTS_TAG_EQUIPE_INTERNA:  '64df8baf-a5cf-4600-9283-53f6008d4370',
  WTS_TAG_TRAFEGO_THIANNY: '',

  // ─── WTS Tags: controle do bot (hardcoded) ─────────────────────────────────
  WTS_TAG_BOT_TRIAGEM: '',
} as const;

// WTS API base URL
export const WTS_BASE_URL = 'https://api.wts.chat';

// Debounce (ms)
export const DEBOUNCE_MS = 8000;

// Delay entre segmentos de mensagem (ms)
export const MESSAGE_DELAY_MS = 2000;

// Máximo de segmentos por resposta
export const MAX_SEGMENTS = 5;

// Máximo de chars por segmento
export const MAX_CHARS_PER_SEGMENT = 800;

// Timeout para chamadas à API WTS (ms)
export const WTS_REQUEST_TIMEOUT_MS = 10000;

// Modelos
export const AGENT_MODEL   = process.env.AGENT_MODEL || 'gpt-4o-mini';
export const SUMMARY_MODEL = 'gpt-4o-mini';

// Compressão de histórico
export const SUMMARY_THRESHOLD  = 40;
export const SUMMARY_KEEP_RECENT = 20;

// Retry
export const RETRY_MAX           = 3;
export const RETRY_BASE_DELAY_MS = 1000;

// Custo estimado (USD por 1M tokens)
export const COST_INPUT_PER_M  = 0.15;
export const COST_OUTPUT_PER_M = 0.60;

// Fuso horário (America/Manaus — UTC-4, sem horário de verão)
export const BUSINESS_TIMEZONE = 'America/Manaus';

// Horário de atendimento:
//   Seg-Sex: 08:00 - 18:00
//   Sáb:     08:00 - 12:00
//   Dom:     fechado
export const BUSINESS_SCHEDULE: Record<number, { start: number; end: number } | null> = {
  0: null,                    // Domingo — fechado
  1: { start: 8, end: 18 },  // Segunda
  2: { start: 8, end: 18 },  // Terça
  3: { start: 8, end: 18 },  // Quarta
  4: { start: 8, end: 18 },  // Quinta
  5: { start: 8, end: 18 },  // Sexta
  6: { start: 8, end: 12 },  // Sábado
};

// Rate limiting (por sessão)
export const RATE_LIMIT_MAX      = 40;   // mensagens por janela
export const RATE_LIMIT_WINDOW_S = 3600; // 1 hora
