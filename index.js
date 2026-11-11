/**
 * Host half of WorkBuddy 一键打卡.
 *
 * Serves three loopback-only routes for the Client half:
 *   GET  /plugins/dsh-workbuddy-checkin/status   sign-in state + today's outcome (no network write)
 *   POST /plugins/dsh-workbuddy-checkin/checkin  claim today's credits for every CN account
 *   POST /plugins/dsh-workbuddy-checkin/refresh  re-read balance only
 *
 * The check-in itself only runs when the user presses the button (or, when
 * `autoCheckinOnOpen` is enabled, when the panel opens on a new day).
 */
import { signInState } from './credentials.js'
import { checkinStatus, creditBalance, credentialProblem, dailyCheckin } from './upstream.js'
import { hasToday, load, mergeResults, save, statePath, today } from './store.js'

/** Route paths, served under `/plugins/<package name>/…` like the rest of the plugin HTTP surface. */
const STATUS_PATH = '/plugins/dsh-workbuddy-checkin/status'
const CHECKIN_PATH = '/plugins/dsh-workbuddy-checkin/checkin'
const REFRESH_PATH = '/plugins/dsh-workbuddy-checkin/refresh'

/** Config section hash the Client sends back, so a settings change reaches the routes after a hot reload. */
const CONFIG_KEY_HEADER = 'x-workbuddy-checkin-config'

const MAX_BODY_BYTES = 16 * 1024

/** Host names a loopback listener may be reached by. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** Strip a port from a Host/Origin authority and lowercase it. */
function authorityHost(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === '') return ''
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    return end === -1 ? text : text.slice(0, end + 1)
  }
  const colon = text.indexOf(':')
  return colon === -1 ? text : text.slice(0, colon)
}

/**
 * Whether a request came from the local page. A remote page can send requests
 * to a loopback server, so both the Host header and (when present) the Origin
 * must be loopback; a request without Origin is a same-origin navigation or a
 * non-browser client, which still had to guess the port.
 */
export function isTrustedRequest(req) {
  if (!LOOPBACK_HOSTS.has(authorityHost(req.headers.host))) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return LOOPBACK_HOSTS.has(authorityHost(new URL(origin).host))
  } catch {
    return false
  }
}

/** Send one JSON response. */
function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** Drain and decode a small JSON request body (`{}` when empty). */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

/** The panel-facing summary of the sign-in state for a given day. */
export function panelState(signIn, record, settings, day = today()) {
  const sameDay = record?.day === day
  const byUid = new Map((sameDay ? record.results : []).map((row) => [row.uid, row]))
  const accounts = signIn.accounts.map((account) => {
    const row = byUid.get(account.uid)
    const checkable = account.enterprise !== true && account.live !== false
    return {
      uid: account.uid,
      nickname: account.nickname,
      domain: account.domain,
      enterprise: account.enterprise,
      live: account.live !== false,
      problem: account.problem,
      pending: checkable && row === undefined,
      state: row?.state ?? 'pending',
      at: row?.at,
      credit: row?.credit,
      streakDays: row?.streakDays,
      error: row?.error,
      balance: row?.balance,
      balanceCheckedAt: row?.balanceCheckedAt,
      balanceError: row?.balanceError,
    }
  })
  const checkable = accounts.filter((account) => account.enterprise !== true && account.live)
  return {
    login: signIn.state,
    day,
    checkedAt: sameDay ? record.checkedAt : undefined,
    accounts,
    unreadable: signIn.unreadable,
    keyError: signIn.keyError,
    canCheckin: checkable.some((account) => account.pending || account.state === 'failed'),
    ready: checkable.filter((account) => account.state !== 'pending' && account.state !== 'failed').length,
    total: checkable.length,
    autoCheckinOnOpen: settings.autoCheckinOnOpen,
  }
}

/**
 * Decide locally whether each credential may be used at all. A test-host or
 * expired backup is marked `live: false` with its reason and is never sent a
 * bearer, nor offered a check-in; no network request is made for it.
 */
function probeSignIn(signIn) {
  const accounts = signIn.accounts.map((account) => {
    const problem = credentialProblem(account)
    return problem === undefined ? { ...account, live: true } : { ...account, live: false, problem }
  })
  return { ...signIn, accounts }
}

/** Claim today's credits for every discovered account that has not completed today. */
async function runCheckin(options = {}) {
  const day = today()
  const signIn = await probeSignIn(await (options.signInState ?? signInState)(options), options)
  const record = await (options.load ?? load)(options.path ?? statePath())
  const results = []
  for (const account of signIn.accounts) {
    if (account.live === false) continue
    if (hasToday(record, account.uid, day)) continue
    if (account.enterprise) continue
    const at = new Date().toISOString()
    const outcome = await (options.dailyCheckin ?? dailyCheckin)(account, options)
    let streakDays
    if (outcome.state !== 'failed') {
      const status = await (options.checkinStatus ?? checkinStatus)(account, options).catch(() => undefined)
      streakDays = status?.streakDays
    }
    const balance = await (options.creditBalance ?? creditBalance)(account, options).catch(() => undefined)
    results.push({
      uid: account.uid,
      nickname: account.nickname,
      domain: account.domain,
      state: outcome.state,
      at,
      ...(outcome.credit === undefined ? {} : { credit: outcome.credit }),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
      ...(streakDays === undefined ? {} : { streakDays }),
      ...(balance === undefined ? {} : { balance, balanceCheckedAt: at }),
    })
  }
  const merged = results.length === 0
    ? (record ?? { day, checkedAt: new Date().toISOString(), results: [] })
    : mergeResults(record, results, day)
  if (results.length > 0) await (options.save ?? save)(merged, options.path ?? statePath())
  return { signIn, record: merged }
}

/** Re-read the balance for accounts already recorded today; never checks in. */
async function refreshBalances(options = {}) {
  const path = options.path ?? statePath()
  const day = today()
  const signIn = await probeSignIn(await (options.signInState ?? signInState)(options), options)
  const record = await (options.load ?? load)(path)
  if (!record || record.day !== day) return { signIn, record }
  const accountsByUid = new Map(signIn.accounts.map((account) => [account.uid, account]))
  const at = new Date().toISOString()
  const results = []
  for (const row of record.results) {
    const account = accountsByUid.get(row.uid)
    if (account === undefined) {
      results.push({ ...row, balanceError: '未找到登录凭据，显示上次记录' })
      continue
    }
    if (account.live === false) {
      results.push({ ...row, balanceError: '登录已失效，请重新登录该账号' })
      continue
    }
    const balance = await creditBalance(account, options).catch(() => undefined)
    if (balance === undefined) {
      results.push({ ...row, balanceError: '余额查询失败，显示上次记录' })
      continue
    }
    const { balanceError: _stale, ...rest } = row
    results.push({ ...rest, balance, balanceCheckedAt: at })
  }
  const next = { ...record, results }
  await (options.save ?? save)(next, path)
  return { signIn, record: next }
}

/** Resolve the plugin settings with their defaults. */
function resolveSettings(config) {
  return {
    autoCheckinOnOpen: config?.autoCheckinOnOpen === true,
    hideWhenSignedOut: config?.hideWhenSignedOut !== false,
    showBalance: config?.showBalance !== false,
  }
}

/**
 * Host plugin entry. `ctx.webServer` is optional: without a Web carrier the
 * plugin simply has nothing to serve.
 */
export function apply(ctx, config = {}) {
  let settings = resolveSettings(config)
  let inFlight

  /**
   * Adopt the configuration a Client reports. A profile patch change reaches the
   * running entry as a hot reload that re-runs the Client half while these routes
   * stay mounted, so the header is how the new settings get here.
   */
  const settingsFor = (req) => {
    const key = req.headers[CONFIG_KEY_HEADER]
    if (typeof key === 'string' && key !== '' && key !== configKey(settings)) settings = decodeConfigKey(key) ?? settings
    return settings
  }

  /** Serialise check-in runs so a double click cannot send two requests. */
  const runExclusive = async (task) => {
    if (inFlight !== undefined) return inFlight
    inFlight = (async () => {
      try {
        return await task()
      } finally {
        inFlight = undefined
      }
    })()
    return inFlight
  }

  ctx.inject(['webServer'], (webCtx) => webCtx.effect(() => {
    const disposeStatus = webCtx.webServer.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: async (req, res) => {
        if (!isTrustedRequest(req)) {
          json(res, 403, { error: 'request-not-trusted' })
          return
        }
        if (req.method !== 'GET') {
          res.setHeader('allow', 'GET')
          json(res, 405, { error: 'method not allowed' })
          return
        }
        try {
          const current = settingsFor(req)
          const signIn = probeSignIn(await signInState({}))
          const record = await load(statePath())
          const stale = current.autoCheckinOnOpen && signIn.state === 'signed-in' && record?.day !== today()
          if (stale) {
            const run = await runExclusive(() => runCheckin({}))
            json(res, 200, { ...panelState(run.signIn, run.record, current), settings: current, auto: true })
            return
          }
          json(res, 200, { ...panelState(signIn, record, current), settings: current })
        } catch (error) {
          ctx.logger?.warn?.(`workbuddy-checkin status failed: ${String(error?.message ?? error)}`)
          json(res, 500, { error: 'status-failed' })
        }
      },
    })

    const disposeCheckin = webCtx.webServer.register({
      kind: 'exact',
      path: CHECKIN_PATH,
      handler: async (req, res) => {
        if (!isTrustedRequest(req)) {
          json(res, 403, { error: 'request-not-trusted' })
          return
        }
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          json(res, 405, { error: 'method not allowed' })
          return
        }
        try {
          const current = settingsFor(req)
          await readBody(req)
          const run = await runExclusive(() => runCheckin({}))
          json(res, 200, { ...panelState(run.signIn, run.record, current), settings: current })
        } catch (error) {
          ctx.logger?.warn?.(`workbuddy-checkin checkin failed: ${String(error?.message ?? error)}`)
          json(res, 500, { error: 'checkin-failed' })
        }
      },
    })

    const disposeRefresh = webCtx.webServer.register({
      kind: 'exact',
      path: REFRESH_PATH,
      handler: async (req, res) => {
        if (!isTrustedRequest(req)) {
          json(res, 403, { error: 'request-not-trusted' })
          return
        }
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          json(res, 405, { error: 'method not allowed' })
          return
        }
        try {
          const current = settingsFor(req)
          await readBody(req)
          const refreshed = await refreshBalances({})
          json(res, 200, { ...panelState(refreshed.signIn, refreshed.record, current), settings: current })
        } catch (error) {
          ctx.logger?.warn?.(`workbuddy-checkin refresh failed: ${String(error?.message ?? error)}`)
          json(res, 500, { error: 'refresh-failed' })
        }
      },
    })

    return () => {
      disposeStatus()
      disposeCheckin()
      disposeRefresh()
    }
  }, 'workbuddy-checkin: routes'))
}

/** A stable hash of the settings, used only to skip an unchanged header. */
function configKey(settings) {
  return Buffer.from(JSON.stringify(settings)).toString('base64url')
}

/** Decode the settings a Client reports, ignoring anything malformed. */
export function decodeConfigKey(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    return {
      autoCheckinOnOpen: parsed.autoCheckinOnOpen === true,
      hideWhenSignedOut: parsed.hideWhenSignedOut !== false,
      showBalance: parsed.showBalance !== false,
    }
  } catch {
    return undefined
  }
}

export { STATUS_PATH, CHECKIN_PATH, REFRESH_PATH, CONFIG_KEY_HEADER, today }
