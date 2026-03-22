// ─── WTS Webhook Payload (formato real WTS) ──────────────────────────────────

export interface WTSWebhookPayload {
  companyId: string;
  sessionId: string;
  session: {
    id: string;
    createdAt: string;
    departmentId: string;
    userId: string;
    number: string;
    utm: string | null;
  };
  channel: {
    id: string;
    key: string;         // ← WTS_FROM dinâmico (ex: "554136041400")
    platform: string;
    displayName: string;
  };
  contact: {
    id: string;
    name: string;
    'first-name': string;
    phonenumber: string; // formato: "+55|41920003599" — precisa tratar pipe
    'display-phonenumber': string;
    email: string | null;
    instagram: string | null;
    tags: string[] | null;  // array de nomes de tags, ex: ["já é paciente", "google"]
    annotation: string | null;
    metadata: Record<string, unknown>;
  };
  lastMessage: {
    id: string;
    createdAt: string;
    type: 'TEXT' | 'AUDIO' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';
    text: string | null;
    fileId: string | null;
    file: {
      publicUrl: string;
      mimeType: string;
    } | null;
  };
  lastContactMessage: string;
  lastMessagesAggregated: {
    text: string;
    files: Array<{
      publicUrl: string;
      mimeType: string;
    }>;
  };
  questions: Record<string, unknown>;
  menus: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

// ─── WTS Message (fetched from API) ─────────────────────────────────────────

export interface WTSMessage {
  id: string;
  type: 'TEXT' | 'AUDIO' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  text: string | null;
  direction: string;
  origin: string;
  createdAt: string;
  file?: {
    publicUrl: string;
    mimeType: string;
  } | null;
}

// ─── Flow Step ───────────────────────────────────────────────────────────────

export type FlowStep =
  | 'init'               // first message — send greeting
  | 'intent'             // waiting: consulta | exame | equipe
  | 'especialidade'      // waiting for specialty choice
  | 'medico'             // waiting for doctor preference
  | 'thianny_confirm'    // Thianny is particular — confirm proceed
  | 'origem'             // waiting: how did they find the clinic
  | 'exame_atendimento'  // exam: particular or convenio?
  | 'exame_convenio'     // exam: which plan?
  | 'done';              // handoff complete — no more processing

// ─── Session Context (stored in Redis) ──────────────────────────────────────

export interface MedinovaSession {
  sessionId: string;
  contactId: string;
  nome?: string;
  telefone: string;               // digits only, sem pipe
  from: string;                   // channel.key — número que recebeu a mensagem
  conversationHistory: ConversationMessage[];
  lastActivity: number;
  pacienteRetornante: boolean;    // true se paciente já tem histórico anterior
  tipoAgendamento?: 'consulta' | 'exame';    // o que o paciente quer fazer
  especialidade?: string;         // ex: 'gastroenterologia', 'anestesiologia'
  tipoAtendimento?: 'particular' | 'convenio';
  convenio?: string;              // nome do convênio informado pelo paciente
  medicoPreferido?: string;       // médico escolhido pelo paciente
  origemContato?: string;         // como conheceu: indicação, google, instagram, anúncio, outro
  flowStep: FlowStep;             // current position in the conversation state machine
  retryCount: number;             // consecutive failed extractions for current step
  thiannyPath: boolean;           // patient is going to Thianny's chatbot
  redirectChatbotKey?: string;    // set when chatbot redirect is needed
}

export type SessionContext = MedinovaSession;

// ─── OpenAI Conversation Messages ────────────────────────────────────────────

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}
