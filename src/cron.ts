// Cron expressions with Cloudflare Cron Triggers semantics, so a schedule fires at the same minutes on Workers and
// on Node (`startScheduler()` in `@ghuri/core/node`). Five fields, evaluated in UTC:
//
//   minute 0-59 · hour 0-23 · day of month 1-31 · month 1-12 or JAN-DEC · day of week 1-7 or SUN-SAT (1 = Sunday)
//
// Every field takes `*`, lists (`,`), ranges (`-`) and steps (`/`). Day of month also takes `L` (last day), `LW`
// (last weekday) and `<n>W` (weekday nearest the n-th); day of week takes `<d>L` (last <d> of the month) and
// `<d>#<n>` (n-th <d> of the month). Note that day of week is NOT Unix numbering (0 = Sunday).
// When both day fields are restricted, a day matches if either matches (as in Vixie cron).

import { ImproperlyConfigured } from './errors'

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

type DayRule =
  | { kind: 'last' } // L (day of month)
  | { kind: 'lastWeekday' } // LW
  | { kind: 'nearestWeekday'; day: number } // 15W
  | { kind: 'lastDow'; dow: number } // 6L (day of week, 1-7)
  | { kind: 'nthDow'; dow: number; nth: number } // 6#3

interface CronField {
  values: Set<number>
  rules: DayRule[]
  any: boolean
}

/** A parsed cron expression. */
export interface CronExpression {
  readonly source: string
  /** Does the expression fire at this minute (UTC; seconds are ignored)? */
  matches(date: Date): boolean
  /** The first minute strictly after `after` at which the expression fires (searches up to 5 years ahead). */
  next(after?: Date): Date | null
}

function invalid(source: string, why: string): never {
  throw new ImproperlyConfigured(`Invalid cron expression '${source}': ${why}.`)
}

function parseValue(token: string, names: string[] | null, offset: number, source: string): number {
  const upper = token.toUpperCase()
  if (names) {
    const i = names.indexOf(upper)
    if (i >= 0) return i + offset
  }
  if (!/^\d+$/.test(token)) invalid(source, `'${token}' is not a number`)
  return Number(token)
}

function parseField(
  text: string,
  min: number,
  max: number,
  names: string[] | null,
  nameOffset: number,
  source: string,
  kind: 'plain' | 'dom' | 'dow',
): CronField {
  const field: CronField = { values: new Set(), rules: [], any: false }
  if (text === '*' || text === '?') {
    field.any = true
    for (let v = min; v <= max; v++) field.values.add(v)
    return field
  }
  for (const part of text.split(',')) {
    if (!part) invalid(source, 'empty list item')
    const upper = part.toUpperCase()
    if (kind === 'dom') {
      if (upper === 'L') {
        field.rules.push({ kind: 'last' })
        continue
      }
      if (upper === 'LW') {
        field.rules.push({ kind: 'lastWeekday' })
        continue
      }
      const w = /^(\d+)W$/.exec(upper)
      if (w) {
        const day = Number(w[1])
        if (day < 1 || day > 31) invalid(source, `day '${w[1]}' out of range 1-31`)
        field.rules.push({ kind: 'nearestWeekday', day })
        continue
      }
    }
    if (kind === 'dow') {
      if (upper === 'L') {
        field.values.add(7) // Quartz: L alone is the last day of the week, Saturday
        continue
      }
      const last = /^([A-Z]{3}|\d)L$/.exec(upper)
      if (last) {
        field.rules.push({ kind: 'lastDow', dow: checkRange(parseValue(last[1], names, nameOffset, source)) })
        continue
      }
      const nth = /^([A-Z]{3}|\d)#([1-5])$/.exec(upper)
      if (nth) {
        field.rules.push({
          kind: 'nthDow',
          dow: checkRange(parseValue(nth[1], names, nameOffset, source)),
          nth: Number(nth[2]),
        })
        continue
      }
    }
    const [range, stepText] = part.split('/')
    if (part.split('/').length > 2) invalid(source, `'${part}' has more than one '/'`)
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) invalid(source, `step '${stepText}' must be a positive integer`)
    let lo: number
    let hi: number
    if (range === '*') {
      lo = min
      hi = max
    } else if (range.includes('-')) {
      const [a, b] = range.split('-')
      lo = checkRange(parseValue(a, names, nameOffset, source))
      hi = checkRange(parseValue(b, names, nameOffset, source))
      if (lo > hi) invalid(source, `range '${range}' runs backwards`)
    } else {
      lo = checkRange(parseValue(range, names, nameOffset, source))
      hi = stepText === undefined ? lo : max
    }
    for (let v = lo; v <= hi; v += step) field.values.add(v)
  }
  return field

  function checkRange(v: number): number {
    if (v < min || v > max) invalid(source, `${v} is out of range ${min}-${max}`)
    return v
  }
}

function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate()
}

function isWeekday(year: number, month0: number, day: number): boolean {
  const dow = new Date(Date.UTC(year, month0, day)).getUTCDay()
  return dow !== 0 && dow !== 6
}

function nearestWeekday(year: number, month0: number, day: number): number {
  const last = daysInMonth(year, month0)
  const d = Math.min(day, last)
  const dow = new Date(Date.UTC(year, month0, d)).getUTCDay()
  if (dow === 6) return d === 1 ? 3 : d - 1 // Saturday → Friday (or Monday the 3rd)
  if (dow === 0) return d === last ? d - 2 : d + 1 // Sunday → Monday (or Friday before the last day)
  return d
}

function domMatches(field: CronField, date: Date): boolean {
  const y = date.getUTCFullYear()
  const m = date.getUTCMonth()
  const d = date.getUTCDate()
  if (field.values.has(d)) return true
  const last = daysInMonth(y, m)
  for (const rule of field.rules) {
    if (rule.kind === 'last' && d === last) return true
    if (rule.kind === 'lastWeekday') {
      let lw = last
      while (!isWeekday(y, m, lw)) lw--
      if (d === lw) return true
    }
    if (rule.kind === 'nearestWeekday' && d === nearestWeekday(y, m, rule.day)) return true
  }
  return false
}

function dowMatches(field: CronField, date: Date): boolean {
  const dow = date.getUTCDay() + 1 // Cloudflare: 1 = Sunday … 7 = Saturday
  if (field.values.has(dow)) return true
  const d = date.getUTCDate()
  const last = daysInMonth(date.getUTCFullYear(), date.getUTCMonth())
  for (const rule of field.rules) {
    if (rule.kind === 'lastDow' && rule.dow === dow && d + 7 > last) return true
    if (rule.kind === 'nthDow' && rule.dow === dow && Math.ceil(d / 7) === rule.nth) return true
  }
  return false
}

/** Parse a Cloudflare-style cron expression. Throws `ImproperlyConfigured` when it is invalid. */
export function parseCron(source: string): CronExpression {
  const parts = source.trim().split(/\s+/)
  if (parts.length !== 5) invalid(source, `expected 5 fields, got ${parts.length}`)
  const minute = parseField(parts[0], 0, 59, null, 0, source, 'plain')
  const hour = parseField(parts[1], 0, 23, null, 0, source, 'plain')
  const dom = parseField(parts[2], 1, 31, null, 0, source, 'dom')
  const month = parseField(parts[3], 1, 12, MONTHS, 1, source, 'plain')
  const dow = parseField(parts[4], 1, 7, DAYS, 1, source, 'dow')

  function dayMatches(date: Date): boolean {
    if (dom.any && dow.any) return true
    if (dom.any) return dowMatches(dow, date)
    if (dow.any) return domMatches(dom, date)
    return domMatches(dom, date) || dowMatches(dow, date)
  }

  function matches(date: Date): boolean {
    return (
      minute.values.has(date.getUTCMinutes()) &&
      hour.values.has(date.getUTCHours()) &&
      month.values.has(date.getUTCMonth() + 1) &&
      dayMatches(date)
    )
  }

  function next(after: Date = new Date()): Date | null {
    const t = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000)
    const limit = after.getTime() + 5 * 366 * 24 * 3600_000
    while (t.getTime() <= limit) {
      if (!month.values.has(t.getUTCMonth() + 1)) {
        t.setUTCMonth(t.getUTCMonth() + 1, 1)
        t.setUTCHours(0, 0, 0, 0)
        continue
      }
      if (!dayMatches(t)) {
        t.setUTCDate(t.getUTCDate() + 1)
        t.setUTCHours(0, 0, 0, 0)
        continue
      }
      if (!hour.values.has(t.getUTCHours())) {
        t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0)
        continue
      }
      if (!minute.values.has(t.getUTCMinutes())) {
        t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0)
        continue
      }
      return new Date(t)
    }
    return null
  }

  return { source, matches, next }
}

/** Is `source` a valid cron expression? */
export function isValidCron(source: string): boolean {
  try {
    parseCron(source)
    return true
  } catch {
    return false
  }
}
