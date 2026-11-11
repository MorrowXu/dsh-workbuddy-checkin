/**
 * The WorkBuddy (CN) billing calls this plugin makes: the daily check-in, the
 * check-in activity status, and the credit balance. Endpoints follow the
 * WorkBuddy desktop/web client as captured by the workbuddy2api projects.
 *
 * Every call is best-effort except the check-in itself; status and balance
 * failures degrade the panel instead of blocking the check-in result.
 */

const CHECKIN_PATH = '/v2/billing/meter/daily-checkin'
const CHECKIN_STATUS_PATH = '/v2/billing/meter/checkin-activity-status'
const RESOURCE_PATH = '/v2/billing/meter/get-user-resource'
const RESOURCE_SUMMARY_PATH = '/billing/meter/get-user-resource-summary'

/** The daily check-in's own timeout: the panel waits on it, so keep it short. */
const CHECKIN_TIMEOUT_MS = 15_000
const STATUS_TIMEOUT_MS = 8_000
const BALANCE_TIMEOUT_MS = 10_000

/** Credit package product code the desktop client asks for. */
const PRODUCT_CODE = 'p_tcaca'

/** Headers the billing endpoints expect: the bearer plus the account's identity. */
export function billingHeaders(account) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/plain, */*',
    authorization: `Bearer ${account.token}`,
    'x-user-id': account.uid,
    'x-domain': account.domain,
  }
  return headers
}

/** Build an absolute URL for one path on the account's own domain. */
function endpoint(account, path) {
  const host = String(account.domain || '').replace(/^https?:\/\//u, '').replace(/\/+$/u, '')
  return `https://${host}${path}`
}

/** Hosts that are not the customer-facing environment, whatever their DNS looks like. */
const NON_PRODUCTION_HOST = /^(?:staging|pre|preview|dev|test|qa|sandbox|beta)\./u

/** Whether a host name is reachable from the public internet (not a loopback or LAN test host). */
export function isProductionDomain(domain) {
  let host = String(domain || '').replace(/^https?:\/\//u, '').replace(/[/?#].*$/u, '').toLowerCase()
  // Drop the port so `localhost:8787` is classified by its host name, not its exact text.
  if (!host.startsWith('[')) host = host.replace(/:\d+$/u, '')
  if (host === '') return false
  if (NON_PRODUCTION_HOST.test(host)) return false
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.test') || host.endsWith('.local')) return false
  if (/^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/u.test(host)) {
    const [a, b] = host.split('.').map(Number)
    if (a === 10 || a === 127) return false
    if (a === 192 && b === 168) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    return true
  }
  return true
}

/** POST JSON and decode the body; non-JSON bodies and network errors become `{ ok:false }`. */
async function postJson(url, account, payload, timeoutMs, fetchImpl) {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: billingHeaders(account),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    let body
    try {
      body = text === '' ? {} : JSON.parse(text)
    } catch {
      body = undefined
    }
    return { ok: response.ok, status: response.status, body }
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

/** The upstream message, preferring its own `msg` over a generic HTTP description. */
function describe(result, fallback) {
  const msg = result.body && typeof result.body.msg === 'string' ? result.body.msg : ''
  if (msg) return msg
  if (result.error) return result.error
  return result.status ? `${fallback}（HTTP ${result.status}）` : fallback
}

/** Whether an upstream answer means "today's check-in is already done". */
function looksSigned(result) {
  const body = result.body ?? {}
  if (body.code === 0) return 'signed'
  if (body.code === 10001) return 'already'
  const msg = typeof body.msg === 'string' ? body.msg : ''
  if (msg.includes('已签到')) return 'already'
  return undefined
}

/**
 * Claim today's credits for one account.
 *
 * Returns `{ state, credit?, streakDays?, error? }` where state is
 * `signed` (freshly claimed), `already` (the upstream says done), or `failed`.
 * An HTTP 401 is reported as `needRelogin` so the panel can point at the app.
 */
export async function dailyCheckin(account, options = {}) {
  if (account.enterprise) {
    return { state: 'failed', error: '企业账号不支持每日签到' }
  }
  const fetchImpl = options.fetch ?? fetch
  const result = await postJson(endpoint(account, CHECKIN_PATH), account, {}, CHECKIN_TIMEOUT_MS, fetchImpl)
  if (result.status === 401) {
    return { state: 'needRelogin', error: '登录已过期，请在 WorkBuddy 里重新登录该账号' }
  }
  const verdict = result.body === undefined ? undefined : looksSigned(result)
  if (verdict === undefined) {
    return { state: 'failed', error: describe(result, '签到失败') }
  }
  const credit = typeof result.body?.data?.credit === 'number' ? result.body.data.credit : undefined
  return { state: verdict, ...(credit === undefined ? {} : { credit }) }
}

/**
 * Today's check-in activity: `{ todayCheckedIn, streakDays, dailyCredit, todayCredit }`.
 * Returns undefined when the upstream answer cannot be read.
 */
export async function checkinStatus(account, options = {}) {
  const fetchImpl = options.fetch ?? fetch
  const result = await postJson(endpoint(account, CHECKIN_STATUS_PATH), account, {}, STATUS_TIMEOUT_MS, fetchImpl)
  const data = result.body?.data
  if (!result.ok || !data || typeof data !== 'object') return undefined
  if (typeof result.body?.code === 'number' && result.body.code !== 0) return undefined
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
  return {
    todayCheckedIn: data.today_checked_in === true,
    streakDays: number(data.streak_days),
    dailyCredit: number(data.daily_credit),
    todayCredit: number(data.today_credit),
    active: data.active !== false,
  }
}

/**
 * Whether this credential still authenticates: one read-only status call.
 * A stale backup left by an earlier sign-in of another account fails here
 * (the upstream answers 401), so the panel never offers it a check-in.
 */
export async function probeAccount(account, options = {}) {
  const fetchImpl = options.fetch ?? fetch
  const result = await postJson(endpoint(account, CHECKIN_STATUS_PATH), account, {}, STATUS_TIMEOUT_MS, fetchImpl)
  return result.ok && result.body !== undefined && (result.body.code === undefined || result.body.code === 0)
}

/**
 * Why this account's credential is not usable, or undefined when it is.
 * Checked locally before any panel or check-in runs, so a backup left by an
 * earlier sign-in against a test host can never send a bearer to the internet
 * or be offered a check-in against the wrong domain.
 */
export function credentialProblem(account) {
  if (!isProductionDomain(account.domain)) {
    return `凭据指向非生产环境（${account.domain}），不会使用；请在 WorkBuddy 里重新登录该账号`
  }
  const expiry = jwtExpiry(account.token)
  if (expiry !== undefined && expiry * 1000 <= Date.now()) {
    return '登录已过期，请在 WorkBuddy 里重新登录该账号'
  }
  return undefined
}

/** The `exp` claim of a JWT, when it has one. */
function jwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1] ?? '', 'base64url').toString('utf8'))
    return typeof payload.exp === 'number' ? payload.exp : undefined
  } catch {
    return undefined
  }
}

/** Sum the remaining capacity of every credit package the account owns. */
export async function creditBalance(account, options = {}) {
  const fetchImpl = options.fetch ?? fetch
  const payload = { PageNumber: 1, PageSize: 100, ProductCode: PRODUCT_CODE, Status: [0, 3] }
  const result = await postJson(endpoint(account, RESOURCE_PATH), account, payload, BALANCE_TIMEOUT_MS, fetchImpl)
  if (!result.ok || result.body === undefined) return undefined
  // A rejected request may still answer HTTP 200 with a non-zero business code.
  if (typeof result.body.code === 'number' && result.body.code !== 0) return undefined
  const accounts = result.body?.data?.Response?.Data?.Accounts
  if (!Array.isArray(accounts)) return undefined
  let total = 0
  for (const row of accounts) {
    const remain = row?.CycleCapacityRemain ?? row?.CapacityRemain
    if (typeof remain === 'number' && Number.isFinite(remain)) total += remain
  }
  return total
}

/**
 * The check-in related display facts for one account in a single pass:
 * the credit status block and the balance. Both are optional.
 */
export async function readCreditFacts(account, options = {}) {
  const [status, balance] = await Promise.all([
    checkinStatus(account, options).catch(() => undefined),
    creditBalance(account, options).catch(() => undefined),
  ])
  return { status, balance }
}

export { CHECKIN_PATH, CHECKIN_STATUS_PATH, RESOURCE_PATH, RESOURCE_SUMMARY_PATH }
