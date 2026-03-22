/** Returns current Date object adjusted to Manaus timezone */
export function nowManaus(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Manaus' }));
}

/** Format a Date to YYYY-MM-DD */
export function formatDateYYYYMMDD(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Add N days to a Date */
export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/** Build human-readable current date/time string for the context block */
export function getCurrentDateTimeContext(): string {
  const now = nowManaus();
  const days = [
    'domingo',
    'segunda-feira',
    'terça-feira',
    'quarta-feira',
    'quinta-feira',
    'sexta-feira',
    'sábado',
  ];
  const months = [
    'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
    'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
  ];

  const dayName = days[now.getDay()];
  const day = now.getDate();
  const month = months[now.getMonth()];
  const year = now.getFullYear();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');

  return `${dayName}, ${day} de ${month} de ${year} às ${hours}:${minutes} (Manaus)`;
}

/** Returns today and today+7 days as YYYY-MM-DD strings */
export function getSearchDateRange(): { dataInicio: string; dataFim: string } {
  const now = nowManaus();
  return {
    dataInicio: formatDateYYYYMMDD(now),
    dataFim: formatDateYYYYMMDD(addDays(now, 7)),
  };
}
