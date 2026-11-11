/**
 * Smoke test for the WorkBuddy check-in client.
 * Runs the real client.js inside a VM with a minimal React implementation,
 * then renders the entry+panel for every state the host can answer with and
 * asserts that each one shows something meaningful.
 *
 *   node test/client-smoke.mjs                    # ../client.js
 *   node test/client-smoke.mjs <path/to/client.js>
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

const SOURCE = readFileSync(process.argv[2] ?? join(import.meta.dirname, '..', 'client.js'), 'utf8')
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() - 86400000))

/** Minimal React: element objects plus a hooks runtime with a render loop. */
function createReact() {
  const slots = []
  const effects = []
  let cursor = 0
  let dirty = false
  const schedule = () => { dirty = true }
  const children = (args) => args.flat()
  return {
    api: {
      Fragment: 'Fragment',
      createElement(type, props, ...rest) {
        return { type, props: props ?? {}, children: children(rest) }
      },
      useRef(value) {
        const index = cursor++
        if (!(index in slots)) slots[index] = { current: value }
        return slots[index]
      },
      useState(initial) {
        const index = cursor++
        if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
        const set = (next) => {
          const value = typeof next === 'function' ? next(slots[index]) : next
          if (Object.is(value, slots[index])) return
          slots[index] = value
          schedule()
        }
        return [slots[index], set]
      },
      useEffect(fn, deps) {
        const index = cursor++
        const previous = slots[index]
        const changed = !previous || !deps
          || previous.deps.length !== deps.length
          || deps.some((item, key) => !Object.is(item, previous.deps[key]))
        if (!changed) return
        slots[index] = { deps }
        effects.push(() => {
          previous?.cleanup?.()
          const cleanup = fn()
          slots[index].cleanup = typeof cleanup === 'function' ? cleanup : undefined
        })
      },
    },
    /**
     * Render until no hook asked for another pass, then expand every function
     * component into its output so plain walkers can read the tree. The only
     * hook-using component is the root one, so the expansion needs no cursor.
     */
    async settle(component, props, settleMs = 200) {
      const deadline = Date.now() + settleMs
      let tree
      do {
        dirty = false
        cursor = 0
        effects.length = 0
        // The seat component is a wrapper; unwrap it so the hook-using root owns slot 0.
        let element = component(props)
        while (typeof element?.type === 'function') element = element.type(element.props)
        tree = element
        for (const run of effects) run()
        await new Promise((resolve) => setTimeout(resolve, 0))
      } while (dirty && Date.now() < deadline)
      const expand = (node) => {
        if (node === undefined || node === null || typeof node !== 'object') return node
        if (Array.isArray(node)) return node.map(expand)
        if (typeof node.type === 'function') return expand(node.type(node.props))
        return { ...node, children: (node.children ?? []).map(expand) }
      }
      return expand(tree)
    },
  }
}

/** Every string in the tree, in document order. */
function strings(node, out = []) {
  if (node === undefined || node === null || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const item of node) strings(item, out)
    return out
  }
  if (typeof node === 'object') for (const child of node.children ?? []) strings(child, out)
  return out
}

/** Every element with the given tag/type name. */
function elements(node, type, out = []) {
  if (node === undefined || node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) elements(item, type, out)
    return out
  }
  if (node.type === type) out.push(node)
  for (const child of node.children ?? []) elements(child, type, out)
  return out
}

function loadPlugin(fetchImpl) {
  const react = createReact()
  const registered = []
  let plugin
  const window = {
    __ModuleLoader__: { load: ({ factory }) => { plugin = factory((name) => (name === 'react' ? react.api : {})) } },
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1440,
    innerHeight: 900,
  }
  const sandbox = {
    window,
    document: {
      documentElement: { lang: 'zh-CN' },
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
    },
    navigator: { language: 'zh-CN' },
    fetch: fetchImpl,
    AbortSignal: { timeout: () => undefined },
    btoa: (value) => Buffer.from(String(value), 'binary').toString('base64'),
    unescape: globalThis.unescape,
    Intl,
    Date,
    JSON,
    Object,
    Array,
    Math,
    String,
    Number,
    Boolean,
    Error,
    RegExp,
    Promise,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(SOURCE, { filename: 'client.js' }).runInContext(sandbox)
  plugin.apply({
    slots: {
      inject: (name, fn) => fn(),
      register: (options, component) => { registered.push({ options, component }) },
    },
  }, {})
  if (registered.length !== 1) throw new Error(`expected one registered seat, got ${registered.length}`)
  return { seat: registered[0], react, window }
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const malformed = { ok: false, status: 500, json: async () => ({ error: '内部错误' }) }

function account(extra) {
  return {
    uid: '38523849-26cd-44d2-897e-3ec034d879e4',
    nickname: '莫罗',
    domain: 'www.workbuddy.cn',
    enterprise: false,
    live: true,
    pending: false,
    state: 'pending',
    ...extra,
  }
}

const cases = [
  {
    name: '待打卡',
    payload: {
      login: 'signed-in', day: today, canCheckin: true, ready: 0, total: 1, accounts: [account({ streakDays: 20 })],
    },
    expect: ['待打卡', '一键打卡', '莫罗', '连登 20 天'],
    absent: ['暂不可用', '今日已完成'],
  },
  {
    name: '今日已完成',
    payload: {
      login: 'signed-in', day: today, checkedAt: new Date().toISOString(), canCheckin: false, ready: 1, total: 1,
      accounts: [account({ state: 'already', pending: false, credit: 5, streakDays: 21, balance: 9496 })],
    },
    expect: ['今日已完成', '莫罗', '连登 21 天', '剩余积分', '9,496', '今日 1/1'],
    absent: ['一键打卡'],
  },
  {
    name: '未登录',
    payload: { login: 'signed-out', day: today, canCheckin: false, ready: 0, total: 1, accounts: [], unreadable: [] },
    expect: ['未登录', '没有读到 WorkBuddy（国内版）的登录信息', '重新检测'],
    absent: ['今日已完成'],
  },
  {
    name: '凭据异常',
    payload: {
      login: 'unreadable', day: today, canCheckin: false, ready: 0, total: 1, accounts: [],
      unreadable: ['x'], keyError: 'DPAPI 解密失败',
    },
    expect: ['凭据异常', '无法解密或识别', 'DPAPI 解密失败', '重新检测'],
    absent: [],
  },
  {
    name: '没有可用账号',
    payload: {
      login: 'signed-in', day: today, canCheckin: false, ready: 0, total: 1,
      accounts: [account({
        uid: 'a55efedb', domain: 'staging.codebuddy.cn', live: false, state: 'pending',
        problem: '凭据指向非生产环境（staging.codebuddy.cn），不会使用；请在 WorkBuddy 里重新登录该账号',
      })],
    },
    expect: ['无账号', '没有找到可以打卡的账号', '凭据指向非生产环境', '重新检测'],
    absent: [],
  },
  {
    name: '请求失败',
    error: malformed,
    expect: ['查询失败', '内部错误', '重试'],
    absent: [],
  },
  {
    name: '查询中',
    pending: true,
    expect: ['WorkBuddy 打卡', '查询中', '正在查询'],
    absent: ['今日已完成'],
  },
  {
    name: '跨天（昨天已完成）',
    payload: {
      login: 'signed-in', day: yesterday, canCheckin: false, ready: 1, total: 1,
      accounts: [account({ state: 'already', balance: 9496, streakDays: 20 })],
    },
    expect: ['今日已完成'],
    absent: [],
  },
]

let failures = 0
for (const testCase of cases) {
  const fetchImpl = () => {
    if (testCase.pending) return new Promise(() => {})
    if (testCase.error) return Promise.resolve(testCase.error)
    return Promise.resolve(ok(testCase.payload))
  }
  const { seat, react, window } = loadPlugin(fetchImpl)
  let tree
  try {
    // Open the panel the way a click does, so the popover body is part of the tree.
    tree = await react.settle(seat.component, { wide: true, settings: { showBalance: true, hideWhenSignedOut: true } })
    // A settled tree without an open panel still proves the entry renders; open it for the full body.
    const entry = Array.isArray(tree) ? tree : [tree]
    const entryButtons = elements(tree, 'button', [])
    if (entryButtons.length === 0) throw new Error('条目没有任何按钮（入口被隐藏）')
    entryButtons[0].props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    tree = await react.settle(seat.component, { wide: true, settings: { showBalance: true, hideWhenSignedOut: true } })
    const text = strings(tree).join(' | ')
    const missing = (testCase.expect ?? []).filter((item) => !text.includes(item))
    const leftover = (testCase.absent ?? []).filter((item) => text.includes(item))
    const buttons = elements(tree, 'button', [])
    const primary = buttons.find((button) => button.props?.style?.flex === 1)
    const status = []
    if (missing.length > 0) status.push(`缺少文案 ${JSON.stringify(missing)}`)
    if (leftover.length > 0) status.push(`多出文案 ${JSON.stringify(leftover)}`)
    if (primary === undefined) status.push('缺少主按钮')
    if (testCase.name === '待打卡' && primary?.props?.disabled !== false) status.push('待打卡时主按钮被禁用')
    if (testCase.name === '今日已完成' && primary?.props?.disabled !== true) status.push('已完成时主按钮未禁用')
    if (status.length > 0) {
      failures += 1
      console.log(`✗ ${testCase.name}: ${status.join('；')}`)
      console.log(`  实际文本：${text.slice(0, 400)}`)
    } else {
      console.log(`✓ ${testCase.name}（${strings(tree).length} 段文本，${buttons.length} 个按钮）`)
    }
  } catch (cause) {
    failures += 1
    console.log(`✗ ${testCase.name}: 渲染抛错 ${cause?.stack ?? cause}`)
  }
}

console.log(failures === 0 ? '\n全部状态都能渲染出内容。' : `\n${failures} 个状态有问题。`)
process.exitCode = failures === 0 ? 0 : 1
