interface Medico {
  nome: string;
  aceitaConvenio: boolean;
  apenasParticular: boolean;
  observacao?: string;
  equipe?: string[];
}

const MEDICOS: Record<string, Medico[]> = {
  gastroenterologia: [
    { nome: 'Dra. Ana Figueiredo',  aceitaConvenio: true,  apenasParticular: false },
    { nome: 'Dr. Douglas Dias',     aceitaConvenio: true,  apenasParticular: false },
    { nome: 'Dr. Rodrigo Almeida',  aceitaConvenio: true,  apenasParticular: false },
    { nome: 'Dr. Tarick Leite',     aceitaConvenio: true,  apenasParticular: false },
    { nome: 'Dr. Tiago Cardoso',    aceitaConvenio: false,  apenasParticular: true, equipe: ['Dr. João', 'Dra. Thais'] },
    { nome: 'Dra. Thianny Machado', aceitaConvenio: false, apenasParticular: true, observacao: 'apenas particular no momento' },
  ],
  anestesiologia: [
    { nome: 'Dra. Zênia Oliveira',   aceitaConvenio: true, apenasParticular: false },
    { nome: 'Dra. Giselle Afonso',   aceitaConvenio: true, apenasParticular: false },
    { nome: 'Dr. Thiago Monteiro',   aceitaConvenio: true, apenasParticular: false },
    { nome: 'Dr. Victor Hortêncio', aceitaConvenio: true, apenasParticular: false },
  ],
  nefrologista: [
    { nome: 'Dr. Miguel Moura', aceitaConvenio: true, apenasParticular: false },
  ],
  'cirurgiao gastro':    [],
  'cirurgiao toracico':  [],
  psicologa:             [],
  nutricionista:         [],
  'balao intragastrico': [],
  bariatrica:            [],
};

const ESPECIALIDADES = [
  'Gastroenterologista',
  'Nefrologista',
  'Cirurgião Gastro',
  'Cirurgião Torácico',
  'Anestesista',
  'Psicóloga',
  'Nutricionista',
  'Balão Intragástrico',
  'Bariátrica',
];

/** Retorna a lista de especialidades já formatada para WhatsApp */
export function listarEspecialidades(): string {
  const itens = ESPECIALIDADES.map((e, i) => `${i + 1}. ${e}`).join('\n');
  return `Que especialidade você está precisando? Temos:\n\n${itens}`;
}

/** Retorna a lista de médicos já formatada para WhatsApp */
export function listarMedicos(especialidade: string, tipoAtendimento?: 'particular' | 'convenio'): string {
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const key = norm(especialidade);

  const esp = Object.keys(MEDICOS).find(k => {
    const kn = norm(k);
    return key.includes(kn) || kn.includes(key);
  });

  if (!esp) {
    return `[SISTEMA] Especialidade "${especialidade}" não encontrada. Chame listar_especialidades para mostrar as opções ao paciente.`;
  }

  let medicos = MEDICOS[esp];
  if (tipoAtendimento === 'convenio') {
    medicos = medicos.filter(m => m.aceitaConvenio);
  }

  if (medicos.length === 0) {
    return `[SISTEMA] Esta especialidade (${esp}) não tem seleção de médico. Encaminhe diretamente para o time de atendimento.`;
  }

  const linhas = medicos.map((m, i) => {
    let linha = `${i + 1}. ${m.nome}`;
    if (m.apenasParticular && m.observacao) linha += ` (${m.observacao})`;
    else if (m.apenasParticular) linha += ` (apenas particular)`;
    return linha;
  });

  return `Temos os seguintes médicos disponíveis:\n\n${linhas.join('\n')}\n\nTem preferência por algum?`;
}
