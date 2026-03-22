import { MAX_SEGMENTS } from '../config/constants';
import { MAX_CHARS_PER_SEGMENT } from '../config/constants';
const MAX_CHARS = MAX_CHARS_PER_SEGMENT;

function sanitize(text: string): string {
  return text.replace(/—/g, '-').trim();
}

/**
 * Verifica se uma linha individual é item de lista
 */
function isListLine(line: string): boolean {
  if (!line) return true;
  if (/^\d+[.)]\s*$/.test(line)) return true;      // número órfão: "9." ou "9)"
  if (/^\d+[.)]\s*\S/.test(line)) return true;     // "1. Item" ou "1) Item"
  if (/^[-•]\s*\S/.test(line)) return true;         // "- Item" ou "• Item"
  if (line.length < 60 && !/[.!?]$/.test(line)) return true; // linha curta sem pontuação
  return false;
}

/**
 * Verifica se um parágrafo inteiro é um bloco de lista (todas as linhas são itens)
 */
function isListItem(para: string): boolean {
  const trimmed = para.trim();
  return trimmed.split('\n').every(line => isListLine(line.trim()));
}

/**
 * Repara listas quebradas: "9.\n\nBariátrica" → "9. Bariátrica"
 * O GPT às vezes gera o número e o texto em parágrafos separados.
 */
function repairBrokenList(paragraphs: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const cur = paragraphs[i].trim();
    const next = paragraphs[i + 1]?.trim();
    // Se o parágrafo atual é só um número ("9." ou "9)") e o próximo existe, cola os dois
    if (/^\d+[.)]\s*$/.test(cur) && next) {
      result.push(`${cur} ${next}`);
      i++; // pula o próximo
    } else {
      result.push(cur);
    }
  }
  return result;
}

/**
 * Divide o texto em segmentos para envio no WhatsApp.
 * Estratégia (por prioridade):
 *   1. Texto <= MAX_CHARS → envia como bloco único
 *   2. Repara listas quebradas pelo GPT (número órfão + texto separado)
 *   3. Divide em parágrafos (\n\n) — agrupa itens de lista consecutivos num mesmo bloco
 *   4. Dentro de parágrafos longos, corta em frases (. ! ?)
 *   5. Último recurso: corta em palavra
 */
export function splitIntoSegments(text: string): string[] {
  const cleaned = sanitize(text);

  // Bloco único
  if (cleaned.length <= MAX_CHARS) return [cleaned];

  // Divide em parágrafos e repara listas quebradas
  const raw = cleaned.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
  const paragraphs = repairBrokenList(raw);

  // Agrupa itens de lista consecutivos para evitar que cada opção vire mensagem separada
  const merged: string[] = [];
  let listBuffer: string[] = [];

  const flushList = () => {
    if (listBuffer.length === 0) return;
    merged.push(listBuffer.join('\n'));
    listBuffer = [];
  };

  for (const para of paragraphs) {
    if (isListItem(para)) {
      listBuffer.push(para);
    } else {
      flushList();
      merged.push(para);
    }
  }
  flushList();

  // Agora gera segmentos a partir dos blocos mesclados
  const segments: string[] = [];

  for (const block of merged) {
    if (segments.length >= MAX_SEGMENTS) break;

    if (block.length <= MAX_CHARS) {
      segments.push(block);
      continue;
    }

    // Bloco longo: corta em frases
    let remaining = block;
    while (remaining.length > 0 && segments.length < MAX_SEGMENTS) {
      if (remaining.length <= MAX_CHARS) {
        segments.push(remaining.trim());
        break;
      }

      const chunk = remaining.substring(0, MAX_CHARS);
      const boundary = Math.max(
        chunk.lastIndexOf('. '),
        chunk.lastIndexOf('! '),
        chunk.lastIndexOf('? '),
        chunk.lastIndexOf('\n')
      );

      let cutAt: number;
      if (boundary > MAX_CHARS * 0.5) {
        cutAt = boundary + 1;
      } else {
        const lastSpace = chunk.lastIndexOf(' ');
        cutAt = lastSpace > MAX_CHARS * 0.4 ? lastSpace : MAX_CHARS;
      }

      segments.push(remaining.substring(0, cutAt).trim());
      remaining = remaining.substring(cutAt).trim();
    }
  }

  return segments.filter(s => s.length > 0);
}
