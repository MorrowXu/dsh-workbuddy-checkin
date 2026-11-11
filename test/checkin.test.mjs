/**
 * Offline tests: every WorkBuddy call is a stub, so nothing here touches the
 * network, the desktop app, or the real DSH home.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from 'node:fs/promises'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  authDirs,
  discoverAccounts,
  forgetKey,
  keyIdOf,
  openEnvelope,
  parseEnvelope,
  parseAtRestPayload,
  resolveElectron,
  signInState,
  buildAad,
} from '../credentials.js'
import { dailyCheckin, checkinStatus, creditBalance, credentialProblem, isProductionDomain } from '../upstream.js'
import { hasToday, load, mergeResults, save, statePath, today } from '../store.js'
import { decodeConfigKey, isTrustedRequest, panelState } from '../index.js'

const SECRET = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')
const KEY = createHash('sha256').update(SECRET, 'utf8').digest()

/** Seal a field exactly the way the desktop app does. */
function seal(key, plaintext) {
  const keyId = keyIdOf(key)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(buildAad(keyId, 1))
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  const inner = {
    suite: 1,
    keyId,
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
  return { $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify(inner), 'utf8').toString('base64') }
}

/** A fake JWT whose payload carries the uid. */
function jwt(uid) {
  const payload = Buffer.from(JSON.stringify({ sub: uid, exp: 4102444800 })).toString('base64url')
  return `header.${payload}.signature`
}

/** One auth document in the desktop app's shape. */
function authDoc({ uid, domain = 'www.codebuddy.cn', token, nickname = 'Tester', enterprise }) {
  return {
    account: {
      uid,
      nickname,
      ...(enterprise ? { enterpriseId: 'ent-1' } : {}),
    },
    auth: { accessToken: token, domain },
  }
}

/** Write one auth file into a temp auth directory. */
async function authDir(files) {
  const dir = await mkdtemp(join(tmpdir(), 'wb-checkin-'))
  await mkdir(dir, { recursive: true })
  for (const [name, doc] of Object.entries(files)) {
    await writeFile(join(dir, name), JSON.stringify(doc))
  }
  return dir
}

/** Options that never spawn the desktop app: the key comes from a stub. */
const withKey = (key) => ({
  dirs: [],
  platform: 'win32',
  env: {},
  home: tmpdir(),
  spawn: async () => JSON.stringify({ version: 1, atRestSecretKey: SECRET }),
  electronPath: 'C:/fake/WorkBuddy.exe',
  ...(key === undefined ? {} : {}),
})

test('a sealed field opens with its protector key and fails with another', () => {
  forgetKey()
  const envelope = seal(KEY, 'the-token')
  const parsed = parseEnvelope(envelope)
  assert.ok(parsed)
  assert.equal(parsed.keyId, keyIdOf(KEY))
  assert.equal(openEnvelope(KEY, parsed), 'the-token')
  assert.equal(openEnvelope(Buffer.alloc(32, 7), parsed), undefined)
})

test('a tampered envelope is rejected at parse time', () => {
  const envelope = seal(KEY, 'the-token')
  assert.equal(parseEnvelope({ $wbEncrypted: 2, envelope: envelope.envelope }), undefined)
  assert.equal(parseEnvelope({ $wbEncrypted: 1, envelope: 'not-base64' }), undefined)
  const inner = JSON.parse(Buffer.from(envelope.envelope, 'base64').toString('utf8'))
  inner.suite = 9
  const bad = { $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify(inner)).toString('base64') }
  assert.equal(parseEnvelope(bad), undefined)
})

test('the helper payload shape is validated', () => {
  assert.ok(parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: SECRET })))
  assert.equal(parseAtRestPayload(JSON.stringify({ version: 2, atRestSecretKey: SECRET })), undefined)
  assert.equal(parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: 'short' })), undefined)
  assert.equal(parseAtRestPayload('not json'), undefined)
})

test('auth directories follow the platform', () => {
  const win = authDirs('win32', { LOCALAPPDATA: 'C:/Users/u/AppData/Local', APPDATA: 'C:/Users/u/AppData/Roaming' }, 'C:/Users/u')
  assert.deepEqual(win, [
    'C:\\Users\\u\\AppData\\Local\\CodeBuddyExtension\\Data\\Public\\auth',
    'C:\\Users\\u\\AppData\\Roaming\\CodeBuddyExtension\\Data\\Public\\auth',
  ])
  assert.equal(authDirs('darwin', {}, '/Users/u').length, 1)
  assert.equal(authDirs('linux', {}, '/home/u').length, 2)
})

test('an explicit Electron override wins; a missing one is reported', () => {
  assert.equal(resolveElectron('win32', { WORKBUDDY_ELECTRON_BIN: process.execPath }), process.execPath)
  assert.equal(resolveElectron('linux', {}, '/home/u'), undefined)
})

test('discovery decrypts the newest credential per account and ignores the international build', async () => {
  forgetKey()
  const dir = await authDir({
    'workbuddy-desktop.info': authDoc({ uid: 'u1', token: seal(KEY, jwt('u1')) }),
    'workbuddy-desktop.2026-01-01T00-00-00-000Z.info': authDoc({ uid: 'u1', token: seal(KEY, 'stale') }),
    'workbuddy-desktop-ai.info': authDoc({ uid: 'u-intl', domain: 'www.workbuddy.ai', token: seal(KEY, jwt('u-intl')) }),
  })
  try {
    const { accounts, unreadable } = await discoverAccounts({ ...withKey(), dirs: [dir] })
    assert.equal(unreadable.length, 0)
    assert.equal(accounts.length, 1)
    assert.equal(accounts[0].uid, 'u1')
    assert.equal(accounts[0].token, jwt('u1'))
    assert.equal(accounts[0].enterprise, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a backup sealed by another key falls back to the plaintext file for the same uid', async () => {
  forgetKey()
  const dir = await authDir({
    'workbuddy-desktop.info': authDoc({ uid: 'u1', token: seal(Buffer.alloc(32, 3), 'unopenable') }),
    'workbuddy-desktop.2026-01-01T00-00-00-000Z.info': authDoc({ uid: 'u1', token: jwt('u1') }),
  })
  try {
    const { accounts } = await discoverAccounts({ ...withKey(), dirs: [dir] })
    assert.equal(accounts.length, 1)
    assert.equal(accounts[0].token, jwt('u1'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an encrypted credential with no available key is reported, never treated as signed out', async () => {
  forgetKey()
  const dir = await authDir({
    'workbuddy-desktop.info': authDoc({ uid: 'u1', token: seal(KEY, jwt('u1')) }),
  })
  try {
    const state = await signInState({
      ...withKey(),
      dirs: [dir],
      electronPath: undefined,
      platform: 'linux',
      env: {},
    })
    assert.equal(state.state, 'unreadable')
    assert.equal(state.accounts.length, 0)
    assert.ok(state.keyError)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('no credential at all reads as signed out', async () => {
  forgetKey()
  const dir = await mkdtemp(join(tmpdir(), 'wb-checkin-empty-'))
  try {
    const state = await signInState({ ...withKey(), dirs: [dir] })
    assert.equal(state.state, 'signed-out')
    assert.equal(state.accounts.length, 0)
    assert.equal(state.unreadable.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/** A fetch stub answering one canned JSON body per URL fragment. */
function stubFetch(table) {
  return async (url, init = {}) => {
    const key = Object.keys(table).find((fragment) => String(url).includes(fragment))
    const entry = key === undefined ? { status: 404, body: {} } : table[key]
    const body = typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body)
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      text: async () => body,
      init,
    }
  }
}

const ACCOUNT = { uid: 'u1', domain: 'www.codebuddy.cn', token: jwt('u1'), enterprise: false }

test('check-in outcomes: signed, already done, relogin, failure', async () => {
  const signed = await dailyCheckin(ACCOUNT, { fetch: stubFetch({ 'daily-checkin': { status: 200, body: { code: 0, data: { credit: 100 } } } }) })
  assert.deepEqual(signed, { state: 'signed', credit: 100 })

  const alreadyCode = await dailyCheckin(ACCOUNT, { fetch: stubFetch({ 'daily-checkin': { status: 400, body: { code: 10001, msg: 'x' } } }) })
  assert.equal(alreadyCode.state, 'already')

  const alreadyMsg = await dailyCheckin(ACCOUNT, { fetch: stubFetch({ 'daily-checkin': { status: 400, body: { code: 500, msg: '今天已签到' } } }) })
  assert.equal(alreadyMsg.state, 'already')

  const relogin = await dailyCheckin(ACCOUNT, { fetch: stubFetch({ 'daily-checkin': { status: 401, body: {} } }) })
  assert.equal(relogin.state, 'needRelogin')

  const failed = await dailyCheckin(ACCOUNT, { fetch: stubFetch({ 'daily-checkin': { status: 500, body: { code: 3, msg: '上游繁忙' } } }) })
  assert.equal(failed.state, 'failed')
  assert.equal(failed.error, '上游繁忙')
})

test('a non-JSON error page is a failure carrying the HTTP status', async () => {
  const result = await dailyCheckin(ACCOUNT, { fetch: stubFetch({ 'daily-checkin': { status: 502, body: '<html>bad gateway</html>' } }) })
  assert.equal(result.state, 'failed')
  assert.match(result.error, /502/u)
})

test('enterprise accounts are refused locally', async () => {
  const result = await dailyCheckin({ ...ACCOUNT, enterprise: true }, { fetch: async () => { throw new Error('must not be called') } })
  assert.equal(result.state, 'failed')
})

test('the status and balance calls decode their shapes and reject business errors', async () => {
  const status = await checkinStatus(ACCOUNT, {
    fetch: stubFetch({
      'checkin-activity-status': { status: 200, body: { code: 0, data: { today_checked_in: true, streak_days: 10, daily_credit: 100, today_credit: 60 } } },
    }),
  })
  assert.deepEqual(status, { todayCheckedIn: true, streakDays: 10, dailyCredit: 100, todayCredit: 60, active: true })

  const balance = await creditBalance(ACCOUNT, {
    fetch: stubFetch({
      'get-user-resource': { status: 200, body: { code: 0, data: { Response: { Data: { Accounts: [{ CycleCapacityRemain: 120.5 }, { CycleCapacityRemain: 79.5 }] } } } } },
    }),
  })
  assert.equal(balance, 200)

  const rejected = await creditBalance(ACCOUNT, {
    fetch: stubFetch({ 'get-user-resource': { status: 200, body: { code: 401, msg: 'expired', data: { Response: { Data: { Accounts: [] } } } } } }),
  })
  assert.equal(rejected, undefined)
})

test('credential usability is decided locally: test hosts, LAN, expiry and JWT parsing', () => {
  assert.equal(credentialProblem(ACCOUNT), undefined)
  for (const domain of ['staging.codebuddy.cn', 'localhost:8787', '192.168.1.20', '127.0.0.1:9000', 'wb.test']) {
    const problem = credentialProblem({ ...ACCOUNT, domain })
    assert.equal(typeof problem, 'string', `${domain} must be refused`)
    assert.match(problem, /非生产环境/u)
  }
  const expired = `header.${Buffer.from(JSON.stringify({ sub: 'u1', exp: 1 })).toString('base64url')}.sig`
  assert.match(credentialProblem({ ...ACCOUNT, token: expired }), /已过期/u)
  assert.equal(isProductionDomain('www.codebuddy.cn'), true)
  assert.equal(isProductionDomain('https://www.codebuddy.cn/'), true)
  assert.equal(isProductionDomain('staging.codebuddy.cn'), false, 'a non-customer host is refused before any request')
})

test('the record is written atomically with owner-only permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-checkin-state-'))
  const path = join(dir, 'nested', '.workbuddy-checkin.json')
  try {
    const day = '2026-10-20'
    await save(mergeResults(undefined, [{ uid: 'u1', state: 'signed', at: 'now', credit: 100 }], day), path)
    const stored = await load(path)
    assert.equal(stored.day, day)
    assert.equal(stored.results[0].state, 'signed')
    assert.equal(hasToday(stored, 'u1', day), true)
    assert.equal(hasToday(stored, 'u1', '2026-10-21'), false)
    const mode = (await stat(path)).mode & 0o777
    if (process.platform !== 'win32') assert.equal(mode, 0o600)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failure later the same day never demotes an earlier success', () => {
  const day = '2026-10-20'
  const first = mergeResults(undefined, [{ uid: 'u1', state: 'signed', at: 'a' }], day)
  const second = mergeResults(first, [{ uid: 'u1', state: 'failed', at: 'b', error: 'x' }], day)
  assert.equal(second.results[0].state, 'signed')
  const retried = mergeResults(second, [{ uid: 'u1', state: 'already', at: 'c' }], day)
  assert.equal(retried.results[0].state, 'already')
})

test('results from another day do not leak into today', () => {
  const stale = mergeResults(undefined, [{ uid: 'u1', state: 'signed', at: 'a' }], '2026-10-19')
  const fresh = mergeResults(stale, [], '2026-10-20')
  assert.equal(fresh.results.length, 0)
})

test('the state path honours DSH_HOME', () => {
  assert.equal(statePath({ DSH_HOME: 'C:/dsh' }, 'C:/home'), join('C:/dsh', '.workbuddy-checkin.json'))
  assert.equal(statePath({}, 'C:/home'), join('C:/home', '.dsh', '.workbuddy-checkin.json'))
})

test('today() uses the Asia/Shanghai calendar day', () => {
  // 2026-10-20T16:30Z is already 2026-10-21 00:30 in Shanghai.
  assert.equal(today(new Date('2026-10-20T16:30:00Z')), '2026-10-21')
  assert.equal(today(new Date('2026-10-20T15:30:00Z')), '2026-10-20')
})

test('only loopback requests are trusted', () => {
  const req = (headers) => ({ headers })
  assert.equal(isTrustedRequest(req({ host: '127.0.0.1:59224' })), true)
  assert.equal(isTrustedRequest(req({ host: 'localhost:59224' })), true)
  assert.equal(isTrustedRequest(req({ host: '[::1]:59224' })), true)
  assert.equal(isTrustedRequest(req({ host: '127.0.0.1:59224', origin: 'http://localhost:59224' })), true)
  assert.equal(isTrustedRequest(req({ host: '127.0.0.1:59224', origin: 'https://evil.example' })), false)
  assert.equal(isTrustedRequest(req({ host: 'evil.example' })), false)
  assert.equal(isTrustedRequest(req({})), false)
})

test('the panel state exposes check-in only for live, non-enterprise accounts', () => {
  const settings = { autoCheckinOnOpen: false, hideWhenSignedOut: true, showBalance: true }
  const signIn = {
    state: 'signed-in',
    unreadable: [],
    accounts: [
      { uid: 'u1', domain: 'www.codebuddy.cn', live: true, enterprise: false, nickname: 'A' },
      { uid: 'u2', domain: 'staging.codebuddy.cn', live: false, enterprise: false, nickname: 'B' },
      { uid: 'u3', domain: 'www.codebuddy.cn', live: true, enterprise: true, nickname: 'C' },
    ],
  }
  const view = panelState(signIn, undefined, settings, '2026-10-20')
  assert.equal(view.canCheckin, true)
  assert.equal(view.total, 1)
  assert.equal(view.ready, 0)
  assert.equal(view.accounts[1].pending, false)

  const done = panelState(signIn, {
    day: '2026-10-20',
    checkedAt: '2026-10-20T02:00:00.000Z',
    results: [{ uid: 'u1', state: 'signed', at: '2026-10-20T02:00:00.000Z', credit: 100 }],
  }, settings, '2026-10-20')
  assert.equal(done.canCheckin, false)
  assert.equal(done.ready, 1)
  assert.equal(done.accounts[0].credit, 100)

  const tomorrow = panelState(signIn, {
    day: '2026-10-19',
    checkedAt: '2026-10-19T02:00:00.000Z',
    results: [{ uid: 'u1', state: 'signed', at: '2026-10-19T02:00:00.000Z' }],
  }, settings, '2026-10-20')
  assert.equal(tomorrow.canCheckin, true)
  assert.equal(tomorrow.ready, 0)
})

test('the settings header decodes a Client report and rejects junk', () => {
  const encoded = Buffer.from(JSON.stringify({ autoCheckinOnOpen: true, hideWhenSignedOut: false, showBalance: true })).toString('base64url')
  assert.deepEqual(decodeConfigKey(encoded), { autoCheckinOnOpen: true, hideWhenSignedOut: false, showBalance: true })
  assert.equal(decodeConfigKey('not-base64-json'), undefined)
  assert.equal(decodeConfigKey(Buffer.from('"text"').toString('base64url')), undefined)
})

test('the client half registers itself into the sidebar footer slot', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /sidebar\.footer\.action/u)
  assert.match(source, /\/plugins\/dsh-workbuddy-checkin\/checkin/u)
  assert.match(source, /id: 'workbuddy-checkin'/u)
})
