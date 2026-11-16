// Independent validation of the month bounds declared by the Python worker.
const months: Record<string, number> = { январ:1, феврал:2, март:3, апрел:4, ма:5, июн:6, июл:7, август:8, сентябр:9, октябр:10, ноябр:11, декабр:12,
  jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
const datePattern = String.raw`(?:\d{1,2}\.\d{1,2}\.(?:19|20)\d{2}|\d{1,2}[./](?:19|20)\d{2}|[\p{L}]+\s+(?:19|20)\d{2})`;
export function periodBounds(header: string, asOf: string): [number, number] | undefined {
  const match = new RegExp(`^(${datePattern})\\s*[-–—]\\s*(${datePattern}|настоящее\\s+время|по\\s+настоящее\\s+время|н\\.?\\s*в\\.?|present|current)$`, "iu").exec(header);
  if (!match) return;
  const snapshot = new Date(asOf + "T00:00:00Z");
  const snapshotMonth = snapshot.getUTCFullYear()*12 + snapshot.getUTCMonth();
  const endpoint = (value: string, last: boolean): number | undefined => {
    if (/^(настоящее\s+время|по\s+настоящее\s+время|н\.?\s*в\.?|present|current)$/iu.test(value)) return last ? snapshotMonth : undefined;
    let day = 1, month = 0, year = 0, precise = false;
    const full = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/u.exec(value);
    const numeric = /^(\d{1,2})[./](\d{4})$/u.exec(value);
    if (full) { day=Number(full[1]); month=Number(full[2]); year=Number(full[3]); precise=true; }
    else if (numeric) { month=Number(numeric[1]); year=Number(numeric[2]); }
    else {
      const parts = value.toLowerCase().split(/\s+/u);
      year=Number(parts[1]);
      month=Object.entries(months).find(([prefix]) => parts[0].startsWith(prefix))?.[1] || 0;
    }
    const check = new Date(Date.UTC(year, month-1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month-1 || check.getUTCDate() !== day) return;
    const endDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return year*12 + month-1 + (precise ? Number(last ? day === endDay : day > 1) : Number(last));
  };
  const first=endpoint(match[1], false), last=endpoint(match[2], true);
  if (first == null || last == null) return;
  const maximum = snapshotMonth + Number(snapshot.getUTCDate() === new Date(Date.UTC(snapshot.getUTCFullYear(), snapshot.getUTCMonth()+1, 0)).getUTCDate());
  return [first, Math.min(last, maximum)];
}
