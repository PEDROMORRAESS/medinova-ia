import { FlowStep, MedinovaSession } from '../types';
import { listarEspecialidades, listarMedicos } from '../functions/listar-medicos';
import { verificarConvenio } from '../functions/verificar-convenio';
import * as ext from './extractor';
import { CONFIG } from '../config/constants';
import { logger } from '../utils/logger';

// Specialties that have doctor selection
const HAS_DOCTORS = ['gastroenterologia', 'nefrologista', 'anestesiologia'];
const MAX_RETRIES = 3;

export interface EngineResult {
  nextStep: FlowStep;
  sessionUpdates: Partial<MedinovaSession>;
  response: string;
  action?: 'handoff' | 'chatbot_thianny';
}

function nome(session: MedinovaSession): string {
  return session.nome?.split(' ')[0] || '';
}

// ─── Response templates ────────────────────────────────────────────────────

function tplGreeting(nomePaciente: string, afterHours: boolean): string {
  const saudacao = `Olá${nomePaciente ? `, ${nomePaciente}` : ''}! Seja bem-vindo à Clínica Medinova.`;
  const horario = afterHours
    ? `\n\nEstamos fora do horário de atendimento agora, mas posso coletar suas informações para agilizar quando retornarmos.`
    : '';
  return `${saudacao}${horario}\n\nPosso te ajudar a agendar uma consulta, um exame, ou te conectar com nossa equipe. O que você precisa?`;
}

function tplRetornante(nomePaciente: string): string {
  return `Olá${nomePaciente ? `, ${nomePaciente}` : ''}! Bem-vindo de volta à Medinova. Como posso te ajudar hoje?`;
}

function tplReask(question: string): string {
  const prefixes = ['Desculpe, não entendi. ', 'Pode repetir? ', 'Não consegui identificar. '];
  return prefixes[Math.floor(Math.random() * prefixes.length)] + question;
}

function tplMaxRetry(): string {
  return `Deixa eu te conectar com nossa equipe, eles podem te ajudar melhor!`;
}

function tplEquipeTransfer(): string {
  return `Claro! Um momento que nossa equipe já te atende.`;
}

function tplIntentQuestion(): string {
  return `Posso te ajudar a agendar uma consulta, um exame, ou prefere falar diretamente com nossa equipe?`;
}

function tplOrigemQuestion(): string {
  return `Ah, e como você ficou sabendo da Medinova?\n\n1. Indicação de amigo/familiar\n2. Google\n3. Instagram\n4. Anúncio\n5. Outro`;
}

function tplThiannyConfirm(): string {
  return `A Dra. Thianny no momento atende apenas particular. Gostaria de agendar assim mesmo ou prefere outro médico?`;
}

function tplTiagoInfo(): string {
  return `O Dr. Tiago Cardoso atende apenas particular. Na equipe dele também temos o Dr. João e a Dra. Thais. Qual você prefere?`;
}

function tplConvenioNaoAceito(plano: string): string {
  return `O plano ${plano} não está na nossa lista de convênios aceitos. Gostaria de agendar como particular, ou prefere aguardar nossa equipe verificar?`;
}

function tplHandoffFinal(): string {
  return `Ótimo! Já vou te passar pro nosso time, eles te ajudam com o horário.`;
}

function tplThiannyHandoff(): string {
  return `Perfeito! Vou te encaminhar para o atendimento exclusivo da Dra. Thianny.`;
}

// ─── State machine ─────────────────────────────────────────────────────────

export async function runEngine(
  patientMessage: string,
  session: MedinovaSession,
  isAfterHours: boolean
): Promise<EngineResult> {
  const step = session.flowStep;
  const n = nome(session);

  logger.info('Engine step', { step, sessionId: session.sessionId });

  // ── init: first message → send greeting, move to intent ───────────────────
  if (step === 'init') {
    const response = session.pacienteRetornante
      ? tplRetornante(n)
      : tplGreeting(n, isAfterHours);
    return {
      nextStep: 'intent',
      sessionUpdates: { retryCount: 0 },
      response,
    };
  }

  // ── done: should not be processing, ignore ────────────────────────────────
  if (step === 'done') {
    return { nextStep: 'done', sessionUpdates: {}, response: '' };
  }

  // ── intent ────────────────────────────────────────────────────────────────
  if (step === 'intent') {
    if (session.pacienteRetornante) {
      // Retornante: any message → transfer to team
      return {
        nextStep: 'done',
        sessionUpdates: {},
        response: tplEquipeTransfer(),
        action: 'handoff',
      };
    }

    const intent = await ext.extractIntent(patientMessage);

    if (!intent) {
      if ((session.retryCount || 0) >= MAX_RETRIES) {
        return { nextStep: 'done', sessionUpdates: {}, response: tplMaxRetry(), action: 'handoff' };
      }
      return {
        nextStep: 'intent',
        sessionUpdates: { retryCount: (session.retryCount || 0) + 1 },
        response: tplReask(tplIntentQuestion()),
      };
    }

    if (intent === 'equipe') {
      return {
        nextStep: 'done',
        sessionUpdates: { tipoAgendamento: undefined },
        response: tplEquipeTransfer(),
        action: 'handoff',
      };
    }

    if (intent === 'exame') {
      return {
        nextStep: 'exame_atendimento',
        sessionUpdates: { tipoAgendamento: 'exame', retryCount: 0 },
        response: `Vai ser pelo convênio ou particular?`,
      };
    }

    // consulta
    const lista = listarEspecialidades();
    return {
      nextStep: 'especialidade',
      sessionUpdates: { tipoAgendamento: 'consulta', retryCount: 0 },
      response: lista,
    };
  }

  // ── especialidade ─────────────────────────────────────────────────────────
  if (step === 'especialidade') {
    const esp = await ext.extractEspecialidade(patientMessage);

    if (!esp) {
      if ((session.retryCount || 0) >= MAX_RETRIES) {
        return { nextStep: 'done', sessionUpdates: {}, response: tplMaxRetry(), action: 'handoff' };
      }
      return {
        nextStep: 'especialidade',
        sessionUpdates: { retryCount: (session.retryCount || 0) + 1 },
        response: tplReask(`Qual das especialidades você precisa?`),
      };
    }

    const sessionUpdates: Partial<MedinovaSession> = { especialidade: esp, retryCount: 0 };

    if (HAS_DOCTORS.includes(esp)) {
      const lista = listarMedicos(esp);
      return { nextStep: 'medico', sessionUpdates, response: lista };
    }

    // Sem seleção de médico → vai direto para origem
    return { nextStep: 'origem', sessionUpdates, response: tplOrigemQuestion() };
  }

  // ── medico ────────────────────────────────────────────────────────────────
  if (step === 'medico') {
    const esp = session.especialidade || 'gastroenterologia';
    const medicosRaw = listarMedicos(esp);

    // Parse doctor names from the formatted string
    const doctorNames = medicosRaw
      .split('\n')
      .filter(l => /^\d+\./.test(l.trim()))
      .map(l => l.replace(/^\d+\.\s*/, '').replace(/\s*\(.*?\)/, '').trim());

    const escolha = await ext.extractMedico(patientMessage, doctorNames);

    if (!escolha) {
      if ((session.retryCount || 0) >= MAX_RETRIES) {
        return { nextStep: 'done', sessionUpdates: {}, response: tplMaxRetry(), action: 'handoff' };
      }
      return {
        nextStep: 'medico',
        sessionUpdates: { retryCount: (session.retryCount || 0) + 1 },
        response: tplReask(`Tem preferência por algum médico da lista?`),
      };
    }

    // Thianny special case
    if (escolha.toLowerCase().includes('thianny')) {
      return {
        nextStep: 'thianny_confirm',
        sessionUpdates: { medicoPreferido: 'Dra. Thianny Machado', retryCount: 0 },
        response: tplThiannyConfirm(),
      };
    }

    // Tiago special case
    if (escolha.toLowerCase().includes('tiago')) {
      return {
        nextStep: 'medico',
        sessionUpdates: { retryCount: 0 },
        response: tplTiagoInfo(),
      };
    }

    return {
      nextStep: 'origem',
      sessionUpdates: { medicoPreferido: escolha === 'sem_preferencia' ? 'sem preferência' : escolha, retryCount: 0 },
      response: tplOrigemQuestion(),
    };
  }

  // ── thianny_confirm ────────────────────────────────────────────────────────
  if (step === 'thianny_confirm') {
    const confirm = await ext.extractConfirm(patientMessage);

    if (!confirm) {
      if ((session.retryCount || 0) >= MAX_RETRIES) {
        return { nextStep: 'done', sessionUpdates: {}, response: tplMaxRetry(), action: 'handoff' };
      }
      return {
        nextStep: 'thianny_confirm',
        sessionUpdates: { retryCount: (session.retryCount || 0) + 1 },
        response: tplReask(`Quer agendar com a Dra. Thianny mesmo assim (particular) ou prefere outro médico?`),
      };
    }

    if (confirm === 'nao') {
      // Back to doctor list
      const lista = listarMedicos(session.especialidade || 'gastroenterologia');
      return {
        nextStep: 'medico',
        sessionUpdates: { medicoPreferido: undefined, retryCount: 0 },
        response: lista,
      };
    }

    // sim → collect origem, then go to Thianny chatbot
    return {
      nextStep: 'origem',
      sessionUpdates: { thiannyPath: true, retryCount: 0 },
      response: tplOrigemQuestion(),
    };
  }

  // ── origem ────────────────────────────────────────────────────────────────
  if (step === 'origem') {
    const origem = await ext.extractOrigem(patientMessage);

    if (!origem) {
      if ((session.retryCount || 0) >= MAX_RETRIES) {
        // Don't block the flow — proceed with 'outro'
        const action = session.thiannyPath ? 'chatbot_thianny' : 'handoff';
        return {
          nextStep: 'done',
          sessionUpdates: { origemContato: 'outro' },
          response: session.thiannyPath ? tplThiannyHandoff() : tplHandoffFinal(),
          action,
        };
      }
      return {
        nextStep: 'origem',
        sessionUpdates: { retryCount: (session.retryCount || 0) + 1 },
        response: tplReask(`Como você ficou sabendo da nossa clínica?`),
      };
    }

    const action = session.thiannyPath ? 'chatbot_thianny' : 'handoff';
    return {
      nextStep: 'done',
      sessionUpdates: { origemContato: origem, retryCount: 0 },
      response: session.thiannyPath ? tplThiannyHandoff() : tplHandoffFinal(),
      action,
    };
  }

  // ── exame_atendimento ─────────────────────────────────────────────────────
  if (step === 'exame_atendimento') {
    const tipo = await ext.extractTipoAtendimento(patientMessage);

    if (!tipo) {
      if ((session.retryCount || 0) >= MAX_RETRIES) {
        return { nextStep: 'done', sessionUpdates: {}, response: tplMaxRetry(), action: 'handoff' };
      }
      return {
        nextStep: 'exame_atendimento',
        sessionUpdates: { retryCount: (session.retryCount || 0) + 1 },
        response: tplReask(`Vai ser pelo convênio ou particular?`),
      };
    }

    if (tipo === 'particular') {
      return {
        nextStep: 'done',
        sessionUpdates: { tipoAtendimento: 'particular', retryCount: 0 },
        response: tplHandoffFinal(),
        action: 'handoff',
      };
    }

    return {
      nextStep: 'exame_convenio',
      sessionUpdates: { tipoAtendimento: 'convenio', retryCount: 0 },
      response: `Qual é o seu plano de saúde?`,
    };
  }

  // ── exame_convenio ────────────────────────────────────────────────────────
  if (step === 'exame_convenio') {
    const plano = await ext.extractConvenio(patientMessage);

    if (!plano) {
      if ((session.retryCount || 0) >= MAX_RETRIES) {
        return { nextStep: 'done', sessionUpdates: {}, response: tplMaxRetry(), action: 'handoff' };
      }
      return {
        nextStep: 'exame_convenio',
        sessionUpdates: { retryCount: (session.retryCount || 0) + 1 },
        response: tplReask(`Qual o nome do seu plano de saúde?`),
      };
    }

    const resultado = verificarConvenio(plano);

    if (resultado.aceito && resultado.nomeNormalizado) {
      return {
        nextStep: 'done',
        sessionUpdates: { convenio: resultado.nomeNormalizado, retryCount: 0 },
        response: tplHandoffFinal(),
        action: 'handoff',
      };
    }

    // Not accepted
    return {
      nextStep: 'exame_convenio',
      sessionUpdates: { retryCount: 0 },
      response: tplConvenioNaoAceito(plano),
    };
  }

  // Fallback
  logger.error('Unknown flow step', { step });
  return { nextStep: 'done', sessionUpdates: {}, response: tplEquipeTransfer(), action: 'handoff' };
}

// ─── Tag builder ──────────────────────────────────────────────────────────

export function buildHandoffTags(session: MedinovaSession): string[] {
  const tags: string[] = [];
  if (CONFIG.WTS_TAG_BOT_TRIAGEM) tags.push(CONFIG.WTS_TAG_BOT_TRIAGEM);

  if (session.tipoAgendamento === 'consulta') tags.push(CONFIG.WTS_TAG_CONSULTA);
  if (session.tipoAgendamento === 'exame') tags.push(CONFIG.WTS_TAG_EXAME);
  if (session.tipoAtendimento === 'particular') tags.push(CONFIG.WTS_TAG_PARTICULAR);
  if (session.tipoAtendimento === 'convenio' && CONFIG.WTS_TAG_CONVENIO) tags.push(CONFIG.WTS_TAG_CONVENIO);

  const origemMap: Record<string, string> = {
    google: CONFIG.WTS_TAG_ORIGEM_GOOGLE, instagram: CONFIG.WTS_TAG_ORIGEM_INSTAGRAM,
    anuncio: CONFIG.WTS_TAG_ORIGEM_ANUNCIO, indicacao: CONFIG.WTS_TAG_ORIGEM_INDICACAO,
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

  if (!session.medicoPreferido || session.medicoPreferido === 'sem preferência') {
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
    if (session.especialidade && espMap[session.especialidade]) {
      tags.push(espMap[session.especialidade]);
    }
  }

  return tags.filter(Boolean);
}
