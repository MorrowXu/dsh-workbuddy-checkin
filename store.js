/**
 * Durable check-in record, one file per DSH home.
 *
 * Shape: `{ day: 'YYYY-MM-DD' (Asia/Shanghai), checkedAt, results: [{ uid, nickname, state, at, credit, error, balance, balanceCheckedAt }] }`.
 * The file is written atomically (temp file + rename) and only ever holds
 * outcome data: no token, no key.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** The calendar day the check-in belongs to, in the timezone the upstream resets on. */
export function today(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now)
}

/** `<DSH_HOME>/.workbuddy-checkin.json`, falling back to `~/.dsh`. */
export function statePath(env = process.env, home = homedir()) {
  const base = env.DSH_HOME?.trim() || join(home, '.dsh')
  return join(base, '.workbuddy-checkin.json')
}

/** Read the record; a missing or unreadable file is simply "nothing recorded yet". */
export async function load(path = statePath()) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (typeof parsed?.day !== 'string' || !Array.isArray(parsed.results)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** Replace the record atomically, 0600, creating the directory when needed. */
export async function save(record, path = statePath()) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600 })
  await rename(temporary, path)
  return record
}

/** Whether `record` already holds today's outcome for this uid. */
export function hasToday(record, uid, day = today()) {
  if (record?.day !== day) return false
  const row = record.results.find((entry) => entry.uid === uid)
  return row !== undefined && row.state !== 'failed'
}

/** Merge fresh results into today's record, keeping earlier successes. */
export function mergeResults(record, results, day = today(), now = new Date()) {
  const sameDay = record?.day === day
  const previous = sameDay ? record.results : []
  const byUid = new Map(previous.filter((row) => row.state !== 'failed').map((row) => [row.uid, row]))
  for (const row of results) {
    if (row.state !== 'failed' || !byUid.has(row.uid)) byUid.set(row.uid, row)
  }
  return {
    day,
    checkedAt: now.toISOString(),
    results: [...byUid.values()],
  }
}
