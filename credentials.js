/**
 * WorkBuddy desktop-app sign-in discovery and at-rest credential decryption.
 *
 * The desktop app keeps its credentials in
 *   <base>\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
 * with one timestamped backup per sign-in. Since WorkBuddy 5.6 the token is
 * sealed into a `{$wbEncrypted:1, envelope:<base64>}` document; the machine's
 * key is fetched from the app's own Electron through a private binding and is
 * only ever held in memory.
 *
 * This module is deliberately node-only and read-only: it reads the auth
 * directory, spawns the app's Electron at most once per process, and never
 * writes a credential, a key, or a token anywhere.
 */
import { execFile } from 'node:child_process'
import { createDecipheriv, createHash } from 'node:crypto'
import { accessSync, constants, existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/** The realm this plugin can check in. The international build has no check-in endpoint. */
export const CN_REALM = 'cn'

/** Auth-file basenames. The `-ai` suffix is the international (WorkBuddy AI) build. */
const CN_AUTH_FILE = 'workbuddy-desktop.info'
const CN_AUTH_BACKUP = /^workbuddy-desktop\.\d{4}-\d{2}-\d{2}T/u

/** Env override for a client installed somewhere the defaults do not cover. */
export const ELECTRON_BIN_ENV = 'WORKBUDDY_ELECTRON_BIN'

/** Electron `version` file shape, e.g. `37.10.3-24`. */
const ELECTRON_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u

/** The one-off helper: writes the sealed at-rest secret as JSON on stdout. */
const HELPER_SCRIPT =
  'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))'

/** Auth directories to probe, in order. Windows writes under Local, older builds under Roaming. */
export function authDirs(platform = process.platform, env = process.env, home = homedir()) {
  const local = env.LOCALAPPDATA?.trim() || join(home, 'AppData', 'Local')
  const roaming = env.APPDATA?.trim() || join(home, 'AppData', 'Roaming')
  const bases = platform === 'win32'
    ? [local, roaming]
    : platform === 'darwin'
      ? [join(home, 'Library', 'Application Support')]
      : [env.XDG_CONFIG_HOME?.trim() || join(home, '.config'), env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share')]
  return [...new Set(bases.map((base) => join(base, 'CodeBuddyExtension', 'Data', 'Public', 'auth')))]
}

/** Candidate Electron binaries for the CN app, most specific first. */
export function electronCandidates(platform = process.platform, env = process.env, home = homedir()) {
  const configured = env[ELECTRON_BIN_ENV]?.trim()
  if (configured) return [configured]
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA?.trim() || join(home, 'AppData', 'Local')
    return [join(local, 'Programs', 'WorkBuddy', 'WorkBuddy.exe')]
  }
  if (platform === 'darwin') return ['/Applications/WorkBuddy.app/Contents/MacOS/Electron']
  return []
}

/** True when `path` names a file the process may execute. */
function isExecutableFile(path) {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The Electron binary to spawn, or undefined. An explicit env override is used
 * as-is; a discovered Windows install must also show the Electron layout
 * (`version` beside the exe), so a stale registry or install record cannot
 * make this plugin execute an unrelated binary.
 */
export function resolveElectron(platform = process.platform, env = process.env, home = homedir()) {
  const configured = env[ELECTRON_BIN_ENV]?.trim()
  if (configured) return isExecutableFile(configured) ? configured : undefined
  for (const candidate of electronCandidates(platform, env, home)) {
    if (!isExecutableFile(candidate)) continue
    if (platform === 'win32') {
      const versionFile = join(dirname(candidate), 'version')
      if (!existsSync(versionFile)) continue
      try {
        if (!ELECTRON_VERSION_PATTERN.test(readFileSync(versionFile, 'utf8').trim())) continue
      } catch {
        continue
      }
    }
    return candidate
  }
  return undefined
}

/** Decode one field envelope: `{$wbEncrypted:1, envelope:<base64 of {suite,keyId,nonce,authTag,ciphertext}>}`. */
export function parseEnvelope(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const wrapped = value
  if (wrapped.$wbEncrypted !== 1 || typeof wrapped.envelope !== 'string') return undefined
  let inner
  try {
    inner = JSON.parse(Buffer.from(wrapped.envelope, 'base64').toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof inner !== 'object' || inner === null) return undefined
  const nonce = Buffer.from(String(inner.nonce ?? ''), 'base64')
  const authTag = Buffer.from(String(inner.authTag ?? ''), 'base64')
  const ciphertext = Buffer.from(String(inner.ciphertext ?? ''), 'base64')
  if (nonce.length !== 12 || authTag.length !== 16 || ciphertext.length === 0) return undefined
  if (inner.suite !== 1 || typeof inner.keyId !== 'string' || !/^[0-9a-f]{16}$/u.test(inner.keyId)) return undefined
  return { suite: inner.suite, keyId: inner.keyId, nonce, authTag, ciphertext }
}

/** The authenticated context the desktop app seals credential fields with (WBEV1 / suite 1). */
export function buildAad(keyId, suite) {
  const lengthPrefixed = (text) => {
    const bytes = Buffer.from(text, 'utf8')
    const header = Buffer.allocUnsafe(4)
    header.writeUInt32BE(bytes.length)
    return Buffer.concat([header, bytes])
  }
  const suiteBytes = Buffer.allocUnsafe(4)
  suiteBytes.writeUInt32BE(suite)
  return Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'), Buffer.from([1]),
    lengthPrefixed('WBEV1'), lengthPrefixed('sym-v1'), suiteBytes, lengthPrefixed(keyId),
    Buffer.from([2, 0, 0]),
  ])
}

/** Open one envelope; undefined when the key does not match or the tag fails. */
export function openEnvelope(key, envelope) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce, { authTagLength: 16 })
    decipher.setAAD(buildAad(envelope.keyId, envelope.suite))
    decipher.setAuthTag(envelope.authTag)
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return undefined
  }
}

/** The protector key from the app's `atRestSecretKey` (sha256 over the STRING, not its bytes). */
export function deriveProtectorKey(secret) {
  return createHash('sha256').update(secret, 'utf8').digest()
}

/** The id envelopes name for a key: the first 16 hex characters of sha256(key). */
export function keyIdOf(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/** Validate the helper payload `{version:1, atRestSecretKey}`. */
export function parseAtRestPayload(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || parsed.version !== 1) return undefined
  const secret = parsed.atRestSecretKey
  if (typeof secret !== 'string' || secret === '') return undefined
  const decoded = Buffer.from(secret, 'base64')
  if (decoded.length !== 32 || decoded.toString('base64') !== secret) return undefined
  return { atRestSecretKey: secret }
}

/** Why a credential could not be read, in the words the panel shows. */
export const KEY_ERROR = {
  noElectron: '未找到 WorkBuddy 客户端（可用 WORKBUDDY_ELECTRON_BIN 指定其可执行文件）',
  spawnFailed: '无法从 WorkBuddy 客户端取得解密密钥（客户端可能已被卸载或正在升级）',
}

/** In-memory key cache. Success sticks; a failure is retried after a short cool-off. */
const keyCache = { key: undefined, at: 0 }
const KEY_RETRY_MS = 30_000

/** Spawn the app's Electron once and read its at-rest payload. */
function spawnPayload(electronPath, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    execFile(
      electronPath,
      ['-e', HELPER_SCRIPT],
      {
        timeout: timeoutMs,
        maxBuffer: 1 << 20,
        windowsHide: true,
        // The app's Electron runs as plain Node only when this flag is set.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      },
      (error, stdout) => {
        if (error) {
          resolve(undefined)
          return
        }
        resolve(String(stdout).trim())
      },
    )
  })
}

/**
 * The machine's protector key, or an error code. Never throws: every failure
 * becomes `{ reason }` so the caller can show "encrypted, no key" instead of
 * mistaking it for "signed out".
 */
export async function protectorKey(options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const now = Date.now()
  if (keyCache.key && now - keyCache.at < 24 * 60 * 60 * 1000) return { key: keyCache.key }
  if (keyCache.failureAt && now - keyCache.failureAt < KEY_RETRY_MS) return { reason: keyCache.failureReason }
  const electronPath = options.electronPath ?? resolveElectron(platform, env, home)
  if (!electronPath) return remember({ reason: KEY_ERROR.noElectron })
  const spawn = options.spawn ?? ((path) => spawnPayload(path))
  const payload = await spawn(electronPath)
  const parsed = payload === undefined ? undefined : parseAtRestPayload(payload)
  if (!parsed) return remember({ reason: KEY_ERROR.spawnFailed })
  const key = deriveProtectorKey(parsed.atRestSecretKey)
  keyCache.key = key
  keyCache.at = Date.now()
  keyCache.failureAt = 0
  delete keyCache.failureReason
  return { key }
}

/** Record a failure so a missing client does not spawn once per panel open. */
function remember(outcome) {
  keyCache.failureAt = Date.now()
  keyCache.failureReason = outcome.reason
  return outcome
}

/** Forget the cached key (tests, and the "re-check sign-in" affordance). */
export function forgetKey() {
  keyCache.key = undefined
  keyCache.at = 0
  keyCache.failureAt = 0
  delete keyCache.failureReason
}

/** Read every CN auth file in one directory as `{ name, uid, domain, token, envelope, nickname }`. */
function readCandidates(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (name !== CN_AUTH_FILE && !(CN_AUTH_BACKUP.test(name) && name.endsWith('.info'))) continue
    let doc
    try {
      doc = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch {
      continue
    }
    const account = doc?.account
    const auth = doc?.auth
    const uid = typeof account?.uid === 'string' ? account.uid : ''
    const domain = typeof auth?.domain === 'string' ? auth.domain : (typeof account?.domain === 'string' ? account.domain : '')
    if (!uid || !domain) continue
    const raw = auth?.accessToken
    const token = typeof raw === 'string' && raw !== '' ? raw : undefined
    const envelope = token === undefined ? parseEnvelope(raw) : undefined
    const nickname = typeof account?.nickname === 'string' ? account.nickname : undefined
    const nicknameEnvelope = nickname === undefined ? parseEnvelope(account?.nickname) : undefined
    out.push({ name, uid, domain, token, envelope, nickname, nicknameEnvelope, account })
  }
  // `workbuddy-desktop.info` sorts above every timestamped backup, so descending name order is newest-first.
  out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
  return out
}

/** Whether the account record marks an enterprise workspace (which has no daily check-in). */
export function isEnterprise(account) {
  if (!account || typeof account !== 'object') return false
  if (typeof account.enterpriseId === 'string' && account.enterpriseId !== '') return true
  return account.isCurrentOneIdEnterprise === true
}

/**
 * Discover the CN accounts signed in on this machine, newest usable credential
 * per uid. Returns `{ accounts, unreadable }`; `accounts` is empty when nobody
 * is signed in, and `unreadable` explains accounts whose credential exists but
 * cannot be opened.
 */
export async function discoverAccounts(options = {}) {
  const dirs = options.dirs ?? authDirs(options.platform, options.env, options.home)
  const accounts = []
  const unreadable = []
  const seen = new Set()
  let keyState
  let firstKeyError
  for (const dir of dirs) {
    const candidates = readCandidates(dir)
    if (candidates.length === 0) continue
    for (const candidate of candidates) {
      if (seen.has(candidate.uid)) continue
      if (candidate.token !== undefined) {
        accounts.push({
          uid: candidate.uid,
          nickname: candidate.nickname,
          domain: candidate.domain,
          token: candidate.token,
          enterprise: isEnterprise(candidate.account),
        })
        seen.add(candidate.uid)
        continue
      }
      if (candidate.envelope === undefined) {
        unreadable.push({ uid: candidate.uid, reason: '凭据文件格式无法识别；请在 WorkBuddy 里重新登录该账号' })
        seen.add(candidate.uid)
        continue
      }
      if (keyState === undefined) keyState = await protectorKey(options)
      if (keyState.key === undefined) {
        // A later directory may still hold an older plaintext file for this uid. Remember
        // why this one cannot be opened so an account is never reported as signed out.
        firstKeyError ??= keyState.reason
        unreadable.push({ uid: candidate.uid, reason: keyState.reason })
        continue
      }
      if (keyIdOf(keyState.key) !== candidate.envelope.keyId) continue
      const token = openEnvelope(keyState.key, candidate.envelope)
      if (token === undefined || token === '') continue
      const nickname = candidate.nicknameEnvelope === undefined
        ? candidate.nickname
        : openEnvelope(keyState.key, candidate.nicknameEnvelope)
      accounts.push({
        uid: candidate.uid,
        nickname,
        domain: candidate.domain,
        token,
        enterprise: isEnterprise(candidate.account),
      })
      seen.add(candidate.uid)
    }
  }
  const covered = new Set(accounts.map((account) => account.uid))
  const pending = unreadable.filter((entry) => !covered.has(entry.uid))
  // A credential that was selected but would not open (its envelope names a key other than
  // this machine's) hides a real sign-in, so the panel must say "unreadable" rather than
  // "signed out" — the latter would silently drop that account's daily credits.
  const keyError = pending.length === 0
    ? undefined
    : firstKeyError ?? '凭据由其他密钥加密（可能在 WorkBuddy 升级或重装之前留下）；请在 WorkBuddy 里重新登录该账号'
  return { accounts, unreadable: pending, keyError }
}

/** Read-only summary of the sign-in state, without any network access. */
export async function signInState(options = {}) {
  const { accounts, unreadable, keyError } = await discoverAccounts(options)
  if (accounts.length > 0) return { state: 'signed-in', accounts, unreadable, keyError }
  if (unreadable.length > 0) return { state: 'unreadable', accounts: [], unreadable, keyError }
  return { state: 'signed-out', accounts: [], unreadable: [] }
}

/** Extract the uid from a JWT payload without verifying it (display only). */
export function tokenUid(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1] ?? '', 'base64url').toString('utf8'))
    return typeof payload.sub === 'string' ? payload.sub : undefined
  } catch {
    return undefined
  }
}

/** File name of the CN credential, exported so the README and tests agree with the code. */
export const AUTH_FILE_BASENAME = basename(CN_AUTH_FILE)
