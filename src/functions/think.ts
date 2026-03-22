import { logger } from '../utils/logger';

/**
 * Permite ao agente planejar antes de agir.
 * Apenas loga o pensamento e retorna confirmação.
 */
export function think(pensamento: string): string {
  logger.info('=== MEDINOVA PENSANDO ===', { pensamento });
  return 'Pensamento registrado. Pode prosseguir.';
}
