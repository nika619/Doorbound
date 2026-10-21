// Clock time in a household's own time zone (an IANA name such as "Asia/Kolkata"), not the server's.
// A server on AWS runs in UTC while the family is in Ohio or Pune: "leave at 7:40" means their 7:40.
// No zone means the server's own (the TZ variable), which is right for a one-household server at home.

const formats = new Map<string, Intl.DateTimeFormat>();
function format(tz?: string): Intl.DateTimeFormat {
  let f = formats.get(tz ?? '');
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formats.set(tz ?? '', f);
  }
  return f;
}
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** What a wall clock and calendar in `tz` show at the instant `ms` (month 1-12, weekday 0 = Sunday). */
export function wall(ms: number, tz?: string) {
  const p = Object.fromEntries(format(tz).formatToParts(ms).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, wd: DAYS.indexOf(p.weekday) };
}

/** How far `tz` is ahead of UTC at the instant `ms`, in ms. */
function offset(ms: number, tz?: string): number {
  const w = wall(ms, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - (ms - (((ms % 1000) + 1000) % 1000));
}

/**
 * The instant a clock in `tz` reads h:mi on that day. Days past the month's end roll over (d + 1 is
 * tomorrow). A time a clock change skips (2:30 on a spring-forward night) comes out an hour later.
 */
export function at(y: number, mo: number, d: number, h: number, mi: number, tz?: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - offset(guess, tz);
  const second = guess - offset(first, tz);
  const w = wall(second, tz);
  return w.h === h && w.mi === mi ? second : Math.max(first, second); // in a skipped hour, the later reading
}

/** A real IANA zone this runtime knows. */
export function isZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz.length <= 64;
  } catch {
    return false;
  }
}
