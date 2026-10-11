import type { ProjectState, Rule } from './types';

export interface DueScheduleEvent {
  ruleId: string;
  occurredAt: string;
  skipped: boolean;
}

const MAX_EVENTS_PER_BATCH = 1000;
const DAY_MS = 86_400_000;

function localParts(timestamp: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(timestamp);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute') };
}

function localDateKey(timestamp: number, timeZone: string): string {
  const part = localParts(timestamp, timeZone);
  return `${part.year.toString().padStart(4, '0')}-${part.month.toString().padStart(2, '0')}-${part.day.toString().padStart(2, '0')}`;
}

function localDateTimeCandidates(date: string, time: string, timeZone: string): number[] {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set<number>();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const sample = naive + hours * 3_600_000;
    const parts = localParts(sample, timeZone);
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    offsets.add(represented - Math.floor(sample / 60_000) * 60_000);
  }
  return [...offsets]
    .map((offset) => naive - offset)
    .filter((candidate) => {
      const parts = localParts(candidate, timeZone);
      return parts.year === year && parts.month === month && parts.day === day && parts.hour === hour && parts.minute === minute;
    })
    .sort((left, right) => left - right);
}

function calendarOccurrences(rule: Rule, after: number, through: number, latestOnly: boolean): number[] {
  if (rule.eventSource.type !== 'calendar') return [];
  const source = rule.eventSource;
  const anchor = Date.parse(source.anchorAt);
  if (!Number.isFinite(anchor) || through <= anchor) return [];
  const lowerDate = localDateKey(Math.max(after, anchor), source.timeZone);
  const upperDate = localDateKey(through, source.timeZone);
  const [startYear, startMonth, startDay] = lowerDate.split('-').map(Number);
  const [endYear, endMonth, endDay] = upperDate.split('-').map(Number);
  let dateCursor = latestOnly ? Date.UTC(endYear, endMonth - 1, endDay) : Date.UTC(startYear, startMonth - 1, startDay) - DAY_MS;
  const earliestDate = Date.UTC(startYear, startMonth - 1, startDay) - DAY_MS;
  const endDate = Date.UTC(endYear, endMonth - 1, endDay);
  const result: number[] = [];
  while (latestOnly ? dateCursor >= earliestDate : dateCursor <= endDate) {
    const date = new Date(dateCursor).toISOString().slice(0, 10);
    const weekday = new Date(dateCursor).getUTCDay();
    const matches = source.recurrence === 'daily'
      || (source.recurrence === 'weekly' && weekday === source.dayOfWeek)
      || (source.recurrence === 'once' && date === source.date);
    if (matches) {
      const candidate = localDateTimeCandidates(date, source.localTime, source.timeZone)[0];
      if (candidate !== undefined && candidate > Math.max(after, anchor) && candidate <= through) {
        result.push(candidate);
        if (latestOnly || result.length >= MAX_EVENTS_PER_BATCH) return result;
      }
    }
    dateCursor += latestOnly ? -DAY_MS : DAY_MS;
    if (source.recurrence === 'once' && result.length) break;
  }
  return result;
}

function dueForRule(state: ProjectState, rule: Rule, through: number): DueScheduleEvent[] {
  const source = rule.eventSource;
  if (source.type !== 'periodic' && source.type !== 'calendar') return [];
  const anchor = Date.parse(source.anchorAt);
  if (!Number.isFinite(anchor) || through <= anchor) return [];
  const cursor = Date.parse(state.runtime.scheduleCursors?.[rule.id] ?? '') || anchor;
  const policy = rule.enabled ? source.missedPolicy : 'skip';
  let occurrences: number[];
  if (source.type === 'periodic') {
    const interval = Number(source.intervalMilliseconds);
    const lastIndex = Math.max(0, Math.floor((cursor - anchor) / interval));
    const endIndex = Math.floor((through - anchor) / interval);
    const startIndex = Math.max(1, lastIndex + 1);
    if (endIndex < startIndex) return [];
    if (policy !== 'all') occurrences = [anchor + endIndex * interval];
    else {
      occurrences = [];
      for (let index = startIndex; index <= endIndex && occurrences.length < MAX_EVENTS_PER_BATCH; index++) occurrences.push(anchor + index * interval);
    }
  } else {
    occurrences = calendarOccurrences(rule, cursor, through, policy !== 'all');
  }
  return occurrences.map((timestamp) => ({
    ruleId: rule.id,
    occurredAt: new Date(timestamp).toISOString(),
    skipped: policy === 'skip',
  }));
}

/** Return the next chronological batch. Each returned item must be committed before asking again. */
export function dueScheduleEvents(state: ProjectState, through = Date.now()): DueScheduleEvent[] {
  const due = state.config.rules.flatMap((rule) => dueForRule(state, rule, through));
  return due.sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt)).slice(0, MAX_EVENTS_PER_BATCH);
}
