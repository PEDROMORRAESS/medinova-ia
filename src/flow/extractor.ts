import OpenAI from 'openai';
import { CONFIG } from '../config/constants';
import { logger } from '../utils/logger';

const openai = new OpenAI({ apiKey: CONFIG.OPENAI_API_KEY });

async function extract<T extends Record<string, string>>(
  system: string,
  message: string
): Promise<T | null> {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 60,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: message },
      ],
    });
    const content = res.choices[0].message.content;
    return content ? (JSON.parse(content) as T) : null;
  } catch (err) {
    logger.error('Extractor error', err);
    return null;
  }
}

export async function extractIntent(msg: string): Promise<'consulta' | 'exame' | 'equipe' | null> {
  const r = await extract<{ v: string }>(
    `Analise a mensagem de um paciente de clínica médica. Retorne JSON {"v": "<valor>"}.
Valores possíveis:
- "consulta": quer agendar consulta médica
- "exame": quer agendar exame
- "equipe": quer falar com atendente/equipe/humano
- "unclear": não foi possível identificar
Aceite erros de digitação e abreviações.`,
    msg
  );
  if (!r || r.v === 'unclear') return null;
  return r.v as 'consulta' | 'exame' | 'equipe';
}

const ESPECIALIDADE_MAP: Record<string, string> = {
  '1': 'gastroenterologia', '2': 'nefrologista', '3': 'cirurgiao gastro',
  '4': 'cirurgiao toracico', '5': 'anestesiologia', '6': 'psicologa',
  '7': 'nutricionista', '8': 'balao intragastrico', '9': 'bariatrica',
};

export async function extractEspecialidade(msg: string): Promise<string | null> {
  // Número direto
  const num = msg.trim().replace(/[.)]/g, '');
  if (ESPECIALIDADE_MAP[num]) return ESPECIALIDADE_MAP[num];

  const r = await extract<{ v: string }>(
    `Identifique a especialidade médica. Retorne JSON {"v": "<especialidade>"}.
Especialidades válidas (use exatamente): gastroenterologia, nefrologista, cirurgiao gastro, cirurgiao toracico, anestesiologia, psicologa, nutricionista, balao intragastrico, bariatrica.
Se não identificar, retorne {"v": "unclear"}.`,
    msg
  );
  if (!r || r.v === 'unclear') return null;
  return r.v.toLowerCase();
}

export async function extractMedico(
  msg: string,
  opcoes: string[]
): Promise<string | 'sem_preferencia' | null> {
  const num = msg.trim().replace(/[.)]/g, '');
  const idx = parseInt(num, 10);
  if (!isNaN(idx) && idx >= 1 && idx <= opcoes.length) return opcoes[idx - 1];

  const r = await extract<{ v: string }>(
    `O paciente está escolhendo um médico. Opções: ${opcoes.map((o, i) => `${i + 1}. ${o}`).join(', ')}.
Retorne JSON {"v": "<nome exato>"} ou {"v": "sem_preferencia"} se tanto faz/qualquer um.
Se não identificar, retorne {"v": "unclear"}.`,
    msg
  );
  if (!r || r.v === 'unclear') return null;
  return r.v;
}

export async function extractOrigem(msg: string): Promise<string | null> {
  const r = await extract<{ v: string }>(
    `Como o paciente conheceu a clínica? Retorne JSON {"v": "<origem>"}.
- "indicacao": indicação de alguém
- "google": Google ou pesquisa online
- "instagram": Instagram
- "anuncio": anúncio/propaganda
- "outro": outra forma
Se não identificar, retorne {"v": "unclear"}.`,
    msg
  );
  if (!r || r.v === 'unclear') return null;
  return r.v;
}

export async function extractTipoAtendimento(msg: string): Promise<'particular' | 'convenio' | null> {
  const r = await extract<{ v: string }>(
    `Particular ou convênio? Retorne JSON {"v": "particular" | "convenio" | "unclear"}.
"plano", "plano de saúde", nome de plano = convenio. "sem plano", "direto" = particular.`,
    msg
  );
  if (!r || r.v === 'unclear') return null;
  return r.v as 'particular' | 'convenio';
}

export async function extractConvenio(msg: string): Promise<string | null> {
  const r = await extract<{ v: string }>(
    `Qual convênio/plano o paciente mencionou? Retorne JSON {"v": "<nome do plano>"} ou {"v": "unclear"}.`,
    msg
  );
  if (!r || r.v === 'unclear') return null;
  return r.v;
}

export async function extractConfirm(msg: string): Promise<'sim' | 'nao' | null> {
  const r = await extract<{ v: string }>(
    `O paciente está confirmando ou negando? Retorne JSON {"v": "sim" | "nao" | "unclear"}.
"sim": quer prosseguir, ok, quero, pode ser. "nao": não quer, prefere outra opção.`,
    msg
  );
  if (!r || r.v === 'unclear') return null;
  return r.v as 'sim' | 'nao';
}
