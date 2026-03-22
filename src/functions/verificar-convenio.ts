// Lista estática dos convênios aceitos pela Medinova
const CONVENIOS_ACEITOS = [
  'bradesco', 'aeronautica', 'aeronáutica', 'e-vida', 'evida',
  'plena vitta', 'plena vita', 'geap', 'hapvida', 'medservice',
  'med service', 'oab', 'caam', 'samel', 'tre', 'amil', 'afeeam', 'marinha'
];

export function verificarConvenio(convenioInformado: string): { aceito: boolean; nomeNormalizado: string | null } {
  const lower = convenioInformado.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const found = CONVENIOS_ACEITOS.find(c => {
    const cn = c.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return lower.includes(cn) || cn.includes(lower);
  });
  return { aceito: !!found, nomeNormalizado: found || null };
}
