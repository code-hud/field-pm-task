/**
 * Exchange session clock. The demo exchange keeps US equity hours in
 * America/New_York, DST included — resolved via Intl so there's no tz dependency.
 */

const ET_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour12: false,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const PRE_MARKET_OPEN = 4 * 60; // 04:00 ET
const REGULAR_OPEN = 9 * 60 + 30; // 09:30 ET
const REGULAR_CLOSE = 16 * 60; // 16:00 ET
const AFTER_HOURS_CLOSE = 20 * 60; // 20:00 ET

function easternTime(now = new Date()) {
  const parts = ET_FORMATTER.formatToParts(now);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  // Midnight formats as "24" with hour12: false in some ICU versions.
  const hour = Number.parseInt(lookup.hour, 10) % 24;
  const minute = Number.parseInt(lookup.minute, 10);
  return {
    weekday: WEEKDAY_INDEX[lookup.weekday] ?? 0,
    hour,
    minute,
    minuteOfDay: hour * 60 + minute,
  };
}

/**
 * @returns {{ phase: 'regular'|'pre-market'|'after-hours'|'closed', isOpen: boolean,
 *   label: string, volatilityFactor: number, minutesIntoSession: number }}
 */
function sessionState(now = new Date()) {
  const { weekday, minuteOfDay } = easternTime(now);
  const isWeekday = weekday >= 1 && weekday <= 5;

  if (isWeekday && minuteOfDay >= REGULAR_OPEN && minuteOfDay < REGULAR_CLOSE) {
    return {
      phase: 'regular',
      isOpen: true,
      label: 'Market open',
      volatilityFactor: 1,
      minutesIntoSession: minuteOfDay - REGULAR_OPEN,
    };
  }

  if (isWeekday && minuteOfDay >= PRE_MARKET_OPEN && minuteOfDay < REGULAR_OPEN) {
    return {
      phase: 'pre-market',
      isOpen: false,
      label: 'Pre-market',
      volatilityFactor: 0.35,
      minutesIntoSession: 0,
    };
  }

  if (isWeekday && minuteOfDay >= REGULAR_CLOSE && minuteOfDay < AFTER_HOURS_CLOSE) {
    return {
      phase: 'after-hours',
      isOpen: false,
      label: 'After hours',
      volatilityFactor: 0.35,
      minutesIntoSession: REGULAR_CLOSE - REGULAR_OPEN,
    };
  }

  return {
    phase: 'closed',
    isOpen: false,
    label: 'Market closed',
    // Overnight quotes still drift a little so a demo at any hour looks alive.
    volatilityFactor: 0.12,
    minutesIntoSession: isWeekday && minuteOfDay >= AFTER_HOURS_CLOSE ? REGULAR_CLOSE - REGULAR_OPEN : 0,
  };
}

const REGULAR_SESSION_MINUTES = REGULAR_CLOSE - REGULAR_OPEN;

module.exports = { easternTime, sessionState, REGULAR_SESSION_MINUTES };
