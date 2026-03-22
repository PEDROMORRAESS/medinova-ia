import OpenAI from 'openai';
import { WTSWebhookPayload, WTSMessage, MedinovaSession } from '../types';
import { redisService } from '../services/redis.service';
import { wtsService, parsePhone } from '../services/wts.service';
import { openaiService } from '../services/openai.service';
import { verificarConvenio } from '../functions/verificar-convenio';
import { splitIntoSegments } from '../utils/message-formatter';
import { CONFIG, MESSAGE_DELAY_MS, MAX_SEGMENTS, BUSINESS_TIMEZONE } from '../config/constants';
import { logger } from '../utils/logger';
import { telegramService } from '../services/telegram.service';
import { scheduleInactivityTimeout, cancelInactivityTimeout } from '../queue/timeout.queue';

// ─── OpenAI client ────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: CONFIG.OPENAI_API_KEY });

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Você é a assistente virtual da Clínica Medinova em Manaus. Converse de forma 100% NATURAL como um atendente humano real. ZERO listas numeradas — tudo fluido e conversacional.

**SAUDAÇÃO:**
Use o horário fornecido em [HORÁRIO] para escolher:
- 05h-12h: "Bom dia, [nome]! 😊"
- 12h-18h: "Boa tarde, [nome]! 😊"
- 18h-05h: "Boa noite, [nome]! 😊"
Depois: "Como posso te ajudar hoje? Consulta, exame ou prefere falar com a equipe?"
Use a saudação APENAS na primeira mensagem da conversa.

**TOM:**
- Natural, amigável, sem parecer robô. Faça UMA pergunta por vez.
- Use: "Perfeito!", "Ótimo!", "Ah, entendi!", "Que legal!"
- Nunca confirme horários, valores ou dê orientações médicas.

VARIAÇÕES DE FRASES NATURAIS (alterne entre elas):

Perguntando sobre médico:
→ "Tem preferência por algum dos nossos médicos?"
→ "Já conhece algum dos nossos médicos ou quer que a equipe escolha o melhor horário?"
→ "Tem algum médico de preferência ou deixa com a equipe?"

Quando paciente não tem preferência de médico:
→ "Tranquilo! A equipe vai verificar a melhor disponibilidade pra você. 😊"
→ "Perfeito! Vou passar pro time e eles agendam com quem tiver mais próximo. 😊"

Confirmando médico escolhido:
→ "Ótimo! Vou agendar com [médico] então. 😊"
→ "Perfeito! [Médico] é ótimo, pode deixar. 😊"

Confirmando convênio aceito:
→ "Seu [plano] é aceito sim! 😊"
→ "Que bom, trabalhamos com [plano]! 😊"

Perguntando origem:
→ "Ah, e como você conheceu a Medinova?"
→ "Só pra gente saber, como você ficou sabendo da gente?"

Ao finalizar (antes do handoff):
→ "Prontinho! Já vou te passar pro time pra confirmar o horário. Um momento!"
→ "Tudo certo! Deixa eu te conectar com o time agora. Só um segundo! 😊"

**FLUXO CONSULTA:**

1. Paciente quer consulta → pergunte APENAS: "Perfeito! Qual especialidade você precisa?"
   AGUARDE a resposta. NÃO liste especialidades automaticamente.

2. Quando paciente responder:

   CASO A — Especialidade válida → salvar_dados("especialidade", valor normalizado):
   - "gastro" / "gastroenterologia" → "gastroenterologia"
   - "nefro" / "nefrologista" → "nefrologista"
   - "cirurgião gastro" / "cirurgiao gastro" → "cirurgiao gastro"
   - "cirurgião torácico" → "cirurgiao toracico"
   - "anestesio" / "anestesiologia" → "anestesiologia"
   - "psicóloga" / "psicologia" → "psicologa"
   - "nutricionista" / "nutri" → "nutricionista"
   - "balão" / "balão intragástrico" → "balao intragastrico"
   - "bariátrica" / "bariatrica" → "bariatrica"

   CASO B — Especialidade NÃO existe (ex: ortopedia, cardiologia, dermatologia):
   → "Infelizmente não temos [especialidade] aqui na Medinova. Temos gastroenterologia, nefrologista, cirurgião gastro, cirurgião torácico, anestesiologia, psicóloga, nutricionista, balão intragástrico e bariátrica. Qual delas te interessa?"

   CASO C — Paciente pede as opções ("Quais são?", "O que vocês têm?", "Me fala"):
   → "Temos gastroenterologia, nefrologista, cirurgião gastro, cirurgião torácico, anestesiologia, psicóloga, nutricionista, balão intragástrico e bariátrica."

3. Após salvar especialidade:
   - Gastroenterologia, anestesiologia ou nefrologista → pergunte: "Ah, [especialidade]! Tem preferência por algum dos nossos médicos ou deixa a equipe escolher o melhor horário disponível?"
   - Cirurgião gastro, cirurgião torácico, psicóloga, nutricionista, balão intragástrico, bariátrica → NÃO pergunte sobre médico, vá direto para origem.

4. MÉDICOS (apenas Gastro, Anestesio, Nefro):

Gastroenterologia: Dra. Ana Figueiredo, Dr. Douglas Dias, Dr. Rodrigo Almeida, Dr. Tarick Leite, Dr. Tiago Cardoso (só particular), Dra. Thianny Machado (só particular)
Anestesiologia: Dra. Zênia Oliveira, Dra. Giselle Afonso, Dr. Thiago Monteiro, Dr. Victor Hortêncio
Nefrologista: Dr. Miguel Moura

NÃO liste médicos automaticamente. Aguarde a resposta do paciente:
- "Não tenho" / "tanto faz" / "qualquer um" / "pode ser qualquer" → salvar_dados("medico", "sem preferência") → "Tranquilo! Nossa equipe vai verificar quem tem horário disponível. 😊" → origem
- Menciona nome → valide se é da especialidade → salvar_dados("medico", "Nome completo") → confirme → origem
- Pede opções ("quais são?", "quem tem?") → liste conversacionalmente: "Temos a Dra. Ana Figueiredo, Dr. Douglas Dias..." → aguarde escolha

**REGRAS ESPECIAIS:**

Dra. Thianny — só particular:
Se escolher → "A Dra. Thianny atende só particular. Tudo bem?"
Se NÃO → volte para médicos. Se SIM → salvar_dados("medico", "Dra. Thianny Machado") → origem.

Dr. Tiago — só particular:
Se paciente já disse convênio antes de escolher Tiago → "O Dr. Tiago é só particular. Como você quer convênio, posso agendar com o Dr. João ou Dra. Thaís da equipe dele. Qual prefere? Ou quer particular com Dr. Tiago?"
- Se João → salvar_dados("medico", "Dr. João")
- Se Thaís → salvar_dados("medico", "Dra. Thais")
- Se insistir em Tiago → salvar_dados("tipoAtendimento", "particular") + salvar_dados("medico", "Dr. Tiago Cardoso")

**FLUXO EXAME:**

Paciente quer exame → "Vai ser particular ou pelo convênio?"
- Particular → salvar_dados("tipoAtendimento", "particular") → origem → handoff
- Convênio → "Qual o nome do plano?" → verificar_convenio(plano)
  - Aceito → salvar_dados("convenio", nome) → "Ótimo, seu plano [nome] é aceito! 😊" → origem → handoff
  - Não aceito → "Infelizmente não trabalhamos com [plano]. Quer agendar particular ou prefere falar com a equipe?"

**CONVÊNIOS ACEITOS:**
Bradesco, Aeronáutica, E-Vida, Plena Vitta, GEAP, Hapvida, MedService, OAB, CAAM, Samel, TRE, Amil, AFEEAM, Marinha.

**ORIGEM:**
Pergunte: "Ah, e como você conheceu a gente?"
NÃO liste opções. Identifique e salve automaticamente:
- "indicação", "amigo", "familiar" → salvar_dados("origem", "indicacao")
- "google", "pesquisei", "busquei" → salvar_dados("origem", "google")
- "instagram", "insta", "IG" → salvar_dados("origem", "instagram")
- "anúncio", "propaganda", "facebook" → salvar_dados("origem", "anuncio")
- Qualquer outra → salvar_dados("origem", "outro")

**FINALIZAÇÃO:**
Após salvar origem, envie uma mensagem natural de despedida, por exemplo:
- "Prontinho! Já vou te passar pro time pra confirmar o horário. Um momento! 😊"
- "Tudo certo! Deixa eu te conectar com o time agora. Só um segundo! 😊"
NÃO precisa chamar nenhuma ferramenta para finalizar — apenas envie a mensagem.

**HORÁRIO:**
Seg-Sex 08h-18h | Sáb 08h-12h | Manaus UTC-4
Fora do horário: avise mas continue coletando.

**FERRAMENTAS:**
- verificar_convenio(plano) → valida convênio
- salvar_dados(campo, valor) → registra informação`;

// ─── Tools ────────────────────────────────────────────────────────────────────

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'verificar_convenio',
      description: 'Verifica se a clínica aceita o plano de saúde informado pelo paciente.',
      parameters: {
        type: 'object',
        properties: {
          plano: { type: 'string', description: 'Nome do plano de saúde informado pelo paciente' },
        },
        required: ['plano'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'salvar_dados',
      description: 'Salva uma informação coletada do paciente na sessão.',
      parameters: {
        type: 'object',
        properties: {
          campo: {
            type: 'string',
            enum: ['tipoAgendamento', 'especialidade', 'medico', 'tipoAtendimento', 'convenio', 'origem'],
            description: 'Campo a salvar',
          },
          valor: { type: 'string', description: 'Valor a salvar' },
        },
        required: ['campo', 'valor'],
      },
    },
  },
];

// ─── Especialidades com seleção de médico ─────────────────────────────────────

const ESPECIALIDADES_COM_MEDICO = ['gastroenterologia', 'nefrologista', 'anestesiologia'];

// ─── Patient type ─────────────────────────────────────────────────────────────

type PatientType = 'novo' | 'retornante' | 'interna' | 'thianny';

function detectPatientType(tags: string[] | null, firstMessage?: string): PatientType {
  // Cobre variações: thianny, thiany, thiani, tianny, tiany, thianhy, thiane, tianhi...
  if (firstMessage && /thi?ann?[yhie]*/i.test(firstMessage)) return 'thianny';
  if (!tags || tags.length === 0) return 'novo';

  const tagLower = tags.map(x => String(x).toLowerCase());

  if (tagLower.some(x => x === 'equipe interna')) return 'interna';
  if (tags.includes(CONFIG.WTS_TAG_DRA_THIANNY)) return 'thianny';
  if (tagLower.some(x => /thi?an/i.test(x))) return 'thianny';
  if (tagLower.some(x => x === 'já é paciente' || x === 'ja e paciente')) return 'retornante';

  return 'novo';
}

// ─── Resolve message text ─────────────────────────────────────────────────────

async function resolveText(msg: WTSMessage): Promise<string | null> {
  if (msg.type === 'TEXT' && msg.text) return msg.text;
  const fileUrl = msg.file?.publicUrl;
  if (msg.type === 'AUDIO') {
    if (fileUrl) return `[Áudio]: ${await openaiService.transcribeAudio(fileUrl)}`;
    return '[Áudio não transcrito. Peça para digitar.]';
  }
  if (msg.type === 'IMAGE') {
    if (fileUrl) return `[Imagem]: ${await openaiService.analyzeImage(fileUrl)}`;
    return '[Imagem recebida. Peça para descrever por texto.]';
  }
  if (msg.type === 'DOCUMENT') return '[Documento recebido. Peça para digitar o que precisa.]';
  if (msg.type === 'VIDEO') return '[Vídeo recebido. Peça para descrever por texto.]';
  return null;
}

// ─── Prompt injection guard ───────────────────────────────────────────────────

const INJECTION_PATTERNS = [
  /ignore\s+(previous|all|prior|your)\s+(instructions?|rules?|prompts?)/i,
  /you are now/i,
  /forget\s+(everything|your|all)/i,
  /\bDAN\b/,
  /act as (if you are|an?\s)/i,
  /jailbreak/i,
  /pretend (you|to be)/i,
];
function isPromptInjection(text: string): boolean {
  return INJECTION_PATTERNS.some(p => p.test(text));
}

// ─── Handoff validation (deterministic) ──────────────────────────────────────

function validateHandoff(session: MedinovaSession): boolean {
  const missing: string[] = [];
  if (!session.tipoAgendamento) missing.push('tipoAgendamento');
  if (!session.origemContato) missing.push('origemContato');
  if (session.tipoAgendamento === 'consulta' && !session.especialidade) missing.push('especialidade');
  if (session.tipoAgendamento === 'exame') {
    if (!session.tipoAtendimento) missing.push('tipoAtendimento');
    if (session.tipoAtendimento === 'convenio' && !session.convenio) missing.push('convenio');
  }
  if (missing.length > 0) {
    logger.info('validateHandoff: not ready', { sessionId: session.sessionId, missing });
    return false;
  }
  return true;
}

// ─── Agent loop ───────────────────────────────────────────────────────────────

async function runAgent(
  patientMessage: string,
  session: MedinovaSession,
  currentHour: number,
  afterHours: boolean,
): Promise<{ response: string; shouldHandoff: boolean }> {

  const dadosColetados = {
    tipo: session.tipoAgendamento || 'não informado',
    especialidade: session.especialidade || 'não informado',
    medico: session.medicoPreferido || 'não informado',
    atendimento: session.tipoAtendimento || 'não informado',
    convenio: session.convenio || 'não informado',
    origem: session.origemContato || 'não informado',
  };

  const horarioCtx = afterHours
    ? `FORA DO HORÁRIO. Avise o paciente mas continue coletando.`
    : `Dentro do horário de atendimento.`;

  const userContent = `${patientMessage}

[HORÁRIO]: ${currentHour}h (Manaus) — ${horarioCtx}
[DADOS COLETADOS]: ${JSON.stringify(dadosColetados)}
[PACIENTE]: ${session.nome?.split(' ')[0] || 'não identificado'}`;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...session.conversationHistory
      .filter(m => m.content !== null)
      .map(m => ({ role: m.role, content: m.content ?? '' }) as OpenAI.Chat.ChatCompletionMessageParam),
    { role: 'user', content: userContent },
  ];

  let finalResponse = '';

  for (let i = 0; i < 5; i++) {
    logger.info('Agent loop', { sessionId: session.sessionId, iteration: i + 1 });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.7,
      max_tokens: 500,
    });

    const choice = completion.choices[0];
    const finishReason = choice.finish_reason;

    logger.info('Agent response', {
      sessionId: session.sessionId,
      finish: finishReason,
      tools: choice.message.tool_calls?.map(t => t.function.name) ?? [],
    });

    if (!choice.message.tool_calls || finishReason === 'stop') {
      finalResponse = choice.message.content || '';
      break;
    }

    messages.push(choice.message);

    for (const tc of choice.message.tool_calls) {
      const { name, arguments: argsStr } = tc.function;
      let args: Record<string, string> = {};
      try { args = JSON.parse(argsStr); } catch { /* ignore */ }

      let result = '';

      if (name === 'verificar_convenio') {
        const cvResult = verificarConvenio(args.plano || '');
        result = cvResult.aceito
          ? `Aceito: ${cvResult.nomeNormalizado}`
          : `Não aceito: ${args.plano}`;
        logger.info('Tool: verificar_convenio', { sessionId: session.sessionId, plano: args.plano, aceito: cvResult.aceito });

      } else if (name === 'salvar_dados') {
        const { campo, valor } = args;
        switch (campo) {
          case 'tipoAgendamento':
            if (valor === 'consulta' || valor === 'exame') session.tipoAgendamento = valor;
            break;
          case 'especialidade':
            session.especialidade = valor;
            // Auto: especialidade salva → tipo é consulta
            if (!session.tipoAgendamento) session.tipoAgendamento = 'consulta';
            // Auto: especialidades sem médico → marcar "sem preferência" automaticamente
            if (!ESPECIALIDADES_COM_MEDICO.includes(valor.toLowerCase())) {
              session.medicoPreferido = 'sem preferência';
            }
            break;
          case 'medico':
            session.medicoPreferido = valor;
            break;
          case 'tipoAtendimento':
            if (valor === 'particular' || valor === 'convenio') session.tipoAtendimento = valor;
            break;
          case 'convenio':
            session.convenio = valor;
            // Auto: se convenio salvo → tipoAtendimento é convenio
            if (!session.tipoAtendimento) session.tipoAtendimento = 'convenio';
            break;
          case 'origem':
            session.origemContato = valor;
            break;
        }
        result = `Salvo: ${campo} = "${valor}"`;
        logger.info('Tool: salvar_dados', { sessionId: session.sessionId, campo, valor });

      }

      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }

  // ═══ VALIDAÇÃO AUTOMÁTICA (determinística — não depende do GPT) ═══
  const shouldHandoff = validateHandoff(session);
  if (shouldHandoff) {
    logger.info('Auto-handoff validated', {
      sessionId: session.sessionId,
      tipoAgendamento: session.tipoAgendamento,
      especialidade: session.especialidade,
      tipoAtendimento: session.tipoAtendimento,
      origemContato: session.origemContato,
    });
  }

  // Atualiza histórico (mantém últimas 20 mensagens)
  session.conversationHistory.push(
    { role: 'user', content: patientMessage },
    { role: 'assistant', content: finalResponse },
  );
  if (session.conversationHistory.length > 20) {
    session.conversationHistory = session.conversationHistory.slice(-20);
  }

  return { response: finalResponse, shouldHandoff };
}

// ─── Handoff tags builder ─────────────────────────────────────────────────────

export function buildHandoffTags(session: MedinovaSession): string[] {
  const tags: string[] = [];

  if (session.tipoAgendamento === 'consulta') tags.push(CONFIG.WTS_TAG_CONSULTA);
  if (session.tipoAgendamento === 'exame') tags.push(CONFIG.WTS_TAG_EXAME);
  if (session.tipoAtendimento === 'particular') tags.push(CONFIG.WTS_TAG_PARTICULAR);
  if (session.tipoAtendimento === 'convenio' && CONFIG.WTS_TAG_CONVENIO) tags.push(CONFIG.WTS_TAG_CONVENIO);

  const origemMap: Record<string, string> = {
    google: CONFIG.WTS_TAG_ORIGEM_GOOGLE,
    instagram: CONFIG.WTS_TAG_ORIGEM_INSTAGRAM,
    anuncio: CONFIG.WTS_TAG_ORIGEM_ANUNCIO,
    indicacao: CONFIG.WTS_TAG_ORIGEM_INDICACAO,
  };
  if (session.origemContato && origemMap[session.origemContato]) {
    tags.push(origemMap[session.origemContato]);
  }

  const medicoMap: Record<string, string> = {
    'dra. ana figueiredo': CONFIG.WTS_TAG_DR_ANA_FIGUEIREDO,
    'dr. douglas dias': CONFIG.WTS_TAG_DR_DOUGLAS_DIAS,
    'dr. rodrigo almeida': CONFIG.WTS_TAG_DR_RODRIGO_ALMEIDA,
    'dr. tarick leite': CONFIG.WTS_TAG_DR_TARICK_LEITE,
    'dr. tiago cardoso': CONFIG.WTS_TAG_DR_TIAGO_CARDOSO,
    'dra. thianny machado': CONFIG.WTS_TAG_DRA_THIANNY,
    'dr. joão': CONFIG.WTS_TAG_DR_JOAO,
    'dra. thais': CONFIG.WTS_TAG_DRA_THAIS,
    'dr. miguel moura': CONFIG.WTS_TAG_DR_MIGUEL_MOURA,
  };
  const medLower = (session.medicoPreferido || '').toLowerCase();
  if (medicoMap[medLower]) tags.push(medicoMap[medLower]);

  // Especialidade sem médico específico
  const espMap: Record<string, string> = {
    nefrologista: CONFIG.WTS_TAG_NEFROLOGISTA,
    anestesiologia: CONFIG.WTS_TAG_ANESTESISTA,
    nutricionista: CONFIG.WTS_TAG_NUTRICIONISTA,
    psicologa: CONFIG.WTS_TAG_PSICOLOGA,
    'balao intragastrico': CONFIG.WTS_TAG_BALAO,
    bariatrica: CONFIG.WTS_TAG_BARIATRICA,
    'cirurgiao gastro': CONFIG.WTS_TAG_CIRURGIAO_GASTRO,
    'cirurgiao toracico': CONFIG.WTS_TAG_CIRURGIAO_TORACICO,
  };
  if (!session.medicoPreferido || session.medicoPreferido === 'sem preferência') {
    const espKey = (session.especialidade || '').toLowerCase();
    if (espMap[espKey]) tags.push(espMap[espKey]);
  }

  return tags.filter(Boolean);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function processWithMedinova(
  payload: WTSWebhookPayload,
  messages: WTSMessage[]
): Promise<void> {
  const { sessionId, contact, channel } = payload;
  const from = channel.key;
  const telefone = parsePhone(contact.phonenumber);

  try {
    // Cancela timer de inatividade (nova mensagem recebida)
    await cancelInactivityTimeout(sessionId).catch(() => {});

    // Resolve textos das mensagens
    const texts: string[] = [];
    for (const msg of messages) {
      const t = await resolveText(msg);
      if (t) texts.push(t);
    }
    if (texts.length === 0) {
      logger.warn('No text to process', { sessionId });
      return;
    }
    const fullText = texts.join('\n');

    // Detecta tipo de paciente (antes do rate limit para Thianny keyword)
    const patientType = detectPatientType(contact.tags, fullText);
    logger.info('Patient type detected', { sessionId, type: patientType });

    // Pré-routing Thianny (tag ou palavra-chave)
    if (patientType === 'thianny') {
      logger.info('Thianny pre-routing → transfer dept + chatbot', { sessionId });
      if (CONFIG.WTS_DEPT_THIANNY) {
        await wtsService.transferToDepartment(sessionId, CONFIG.WTS_DEPT_THIANNY).catch(() => {});
      }
      await wtsService.sendToChatbot(CONFIG.WTS_BOT_KEY_THIANNY, sessionId, from, telefone);
      return;
    }

    // Pré-routing equipe interna e retornantes
    if (patientType === 'interna') {
      logger.info('Internal team → transfer', { sessionId });
      await wtsService.transferToDepartment(sessionId, CONFIG.WTS_DEPT_COMERCIAL);
      return;
    }

    // Rate limit
    const { allowed } = await redisService.checkRateLimit(sessionId);
    if (!allowed) {
      await wtsService.sendMessage(from, telefone, 'Muitas mensagens em pouco tempo. Aguarde alguns minutos.');
      return;
    }

    // Prompt injection guard
    if (isPromptInjection(fullText)) {
      await wtsService.sendMessage(from, telefone, 'Só consigo ajudar com agendamentos da Medinova.');
      return;
    }

    // Carrega ou cria sessão
    let session = await redisService.getSession(sessionId);
    if (!session) {
      session = {
        sessionId,
        contactId: contact.id,
        nome: contact.name || undefined,
        telefone,
        from,
        conversationHistory: [],
        lastActivity: Date.now(),
        pacienteRetornante: patientType === 'retornante',
        flowStep: 'intent',
        retryCount: 0,
        thiannyPath: false,
      } as MedinovaSession;
      logger.info('New session created', { sessionId, nome: session.nome, patientType });
    }

    // Retornante: saudação + transfer direto
    if (patientType === 'retornante' && session.conversationHistory.length === 0) {
      const nome = session.nome?.split(' ')[0] || '';
      await wtsService.sendMessage(from, telefone,
        `Olá${nome ? `, ${nome}` : ''}! Bem-vindo de volta à Medinova. Um momento que nossa equipe já te atende. 😊`
      );
      await wtsService.tagContact(contact.id, [CONFIG.WTS_TAG_JA_E_PACIENTE].filter(Boolean)).catch(() => {});
      await wtsService.transferToDepartment(sessionId, CONFIG.WTS_DEPT_COMERCIAL).catch(() => {});
      session.flowStep = 'done';
      await redisService.saveSession(session);
      return;
    }

    session.lastActivity = Date.now();

    // Calcula hora atual em Manaus
    const currentHour = parseInt(
      new Date().toLocaleString('en-US', { timeZone: BUSINESS_TIMEZONE, hour: 'numeric', hour12: false }),
      10
    );
    const afterHours = (() => {
      const day = new Date(new Date().toLocaleString('en-US', { timeZone: BUSINESS_TIMEZONE })).getDay();
      if (day === 0) return true; // domingo
      if (day === 6) return currentHour < 8 || currentHour >= 12; // sábado
      return currentHour < 8 || currentHour >= 18; // seg-sex
    })();

    // Executa agente
    const { response, shouldHandoff } = await runAgent(fullText, session, currentHour, afterHours);

    // Envia resposta segmentada
    if (response) {
      const segments = splitIntoSegments(response).slice(0, MAX_SEGMENTS);
      for (let i = 0; i < segments.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, MESSAGE_DELAY_MS));
        await wtsService.sendMessage(from, telefone, segments[i]);
      }
    }

    // Handoff
    if (shouldHandoff) {
      const tags = buildHandoffTags(session);
      await wtsService.tagContact(contact.id, tags).catch(() => {});
      logger.info('Handoff: tagged', { sessionId, contactId: contact.id, count: tags.length });

      await wtsService.transferToDepartment(sessionId, CONFIG.WTS_DEPT_COMERCIAL).catch(() => {});
      logger.info('Handoff: transferred', { sessionId });

      session.flowStep = 'done';
    }

    // Salva sessão
    await redisService.saveSession(session);

    // Agenda timeout de inatividade (5 min sem resposta → transfer)
    if (session.flowStep !== 'done') {
      await scheduleInactivityTimeout(sessionId).catch(() => {});
    }

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error('processWithMedinova error', { sessionId, error: errMsg });
    telegramService.notifyError({ sessionId, telefone, funcao: 'processWithMedinova', erro: errMsg }).catch(() => {});
    try {
      await wtsService.sendMessage(from ?? '', telefone, 'Desculpe, tive um problema técnico. Tente novamente em instantes!');
    } catch { /* ignore */ }
  }
}
