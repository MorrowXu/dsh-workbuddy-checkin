window.__ModuleLoader__.load({
  id: 'dsh-workbuddy-checkin',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const STATUS_PATH = '/plugins/dsh-workbuddy-checkin/status'
    const CHECKIN_PATH = '/plugins/dsh-workbuddy-checkin/checkin'
    const REFRESH_PATH = '/plugins/dsh-workbuddy-checkin/refresh'
    const REQUEST_TIMEOUT_MS = 30_000
    /** While the entry has nothing useful to show, re-read this often (WorkBuddy may start later). */
    const ATTENTION_POLL_MS = 60_000
    /**
     * An unreadable credential is retried far less often: every status read may
     * spawn WorkBuddy's Electron to fetch the protector key, and its own failure
     * cache only lasts 30s.
     */
    const UNREADABLE_POLL_MS = 5 * 60_000
    /** Cross-day check: a panel left open overnight must not keep yesterday's answer. */
    const DAY_POLL_MS = 5 * 60_000
    const PANEL_WIDTH = 320

    /** Host theme tokens, each with a fallback for hosts that do not define it. */
    const T = {
      text: 'var(--dsw-alias-label-primary, #f4f4f5)',
      secondary: 'var(--dsw-alias-label-secondary, #bdbdbd)',
      dimmed: 'var(--dsw-alias-label-dimmed, #8a8a8f)',
      layer: 'var(--dsw-alias-bg-layer-1, #252525)',
      layer2: 'var(--dsw-alias-bg-layer-2, #2e2e2e)',
      border: 'var(--dsw-alias-border-l2, #4a4a4a)',
      ok: 'var(--dsw-alias-state-success-primary, #22c55e)',
      warn: 'var(--dsw-alias-state-warn-primary, #eab308)',
      error: 'var(--dsw-alias-state-error-primary, #ef4444)',
      accent: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      // Brand primary flips with the theme (near-white on dark, near-black on
      // light), so its text must come from the paired foreground token — a fixed
      // white label is invisible on the dark theme's white button.
      onAccent: 'var(--dsw-alias-label-primary-foreground, #101010)',
    }

    const text = {
      zh: {
        title: 'WorkBuddy 打卡',
        open: '打开 WorkBuddy 打卡面板',
        checkedIn: '已打卡',
        notCheckedIn: '待打卡',
        signedOut: '未登录',
        unreadable: '凭据异常',
        signInHint: '没有读到 WorkBuddy（国内版）的登录信息。请先在 WorkBuddy 里登录，再点「重新检测」。',
        unreadableHint: '已找到凭据，但无法解密或识别。请在 WorkBuddy 里重新登录该账号，再点「重新检测」。',
        today: '今日',
        checkinButton: '一键打卡',
        checking: '正在打卡…',
        done: '今日已完成',
        retry: '重试',
        recheck: '重新检测',
        refresh: '刷新余额与状态',
        refreshing: '刷新中…',
        balance: '剩余积分',
        balanceUnknown: '暂不可用',
        credit: '本次 +{{n}} 积分',
        streak: '连登 {{n}} 天',
        enterprise: '企业账号不支持每日签到',
        expired: '登录已失效，请重新登录',
        failed: '打卡失败：{{error}}',
        signed: '已打卡并领取积分',
        already: '今日已领取',
        querying: '查询中',
        loading: '正在查询 WorkBuddy 登录状态…',
        loadFailed: '查询失败',
        requestFailed: '请求失败',
        close: '关闭',
        lastChecked: '更新于 {{time}}',
        auto: '打开面板时已自动补签',
        empty: '无账号',
        noAccounts: '没有可用账号',
        noAccountsHint: '没有找到可以打卡的账号。请在 WorkBuddy 里登录国内版账号后点「重新检测」。',
        blocked: '无法打卡',
        blockedHint: '账号存在，但今天都不能打卡，原因见下方。',
        pendingHint: '还有 {{n}} 个账号今天没打卡',
        doneHint: '今天已经打完卡了',
      },
      en: {
        title: 'WorkBuddy check-in',
        open: 'Open the WorkBuddy check-in panel',
        checkedIn: 'Checked in',
        notCheckedIn: 'Not checked in',
        signedOut: 'Signed out',
        unreadable: 'Credential unreadable',
        signInHint: 'No WorkBuddy (China) sign-in found. Sign in to WorkBuddy, then press Recheck.',
        unreadableHint: 'A credential was found but could not be decrypted. Sign in again in WorkBuddy, then press Recheck.',
        today: 'Today',
        checkinButton: 'Check in',
        checking: 'Checking in…',
        done: 'Done for today',
        retry: 'Retry',
        recheck: 'Recheck',
        refresh: 'Refresh credits and state',
        refreshing: 'Refreshing…',
        balance: 'Credits',
        balanceUnknown: 'Unavailable',
        credit: '+{{n}} credits',
        streak: '{{n}}-day streak',
        enterprise: 'Enterprise accounts have no daily check-in',
        expired: 'Sign-in expired, sign in again',
        failed: 'Check-in failed: {{error}}',
        signed: 'Checked in, credits claimed',
        already: 'Already claimed today',
        querying: 'Checking',
        loading: 'Reading the WorkBuddy sign-in state…',
        loadFailed: 'Load failed',
        loadFailed: 'Load failed',
        requestFailed: 'Request failed',
        close: 'Close',
        lastChecked: 'Updated {{time}}',
        auto: 'Checked in automatically when the panel opened',
        empty: 'No account',
        noAccounts: 'No usable account',
        noAccountsHint: 'No account can check in. Sign in to a WorkBuddy (China) account, then press Recheck.',
        blocked: 'Cannot check in',
        blockedHint: 'Accounts exist, but none can check in today. See the reasons below.',
        pendingHint: '{{n}} account(s) still not checked in today',
        doneHint: 'Today is already done',
      },
    }

    /** The active UI language, read from the document so it follows the host locale. */
    function language() {
      const value = String((typeof document !== 'undefined' && document.documentElement.lang) || navigator.language || 'zh')
      return value.toLowerCase().startsWith('en') ? 'en' : 'zh'
    }

    function translator() {
      const table = text[language()]
      return (key, vars) => {
        const template = table[key] ?? text.zh[key] ?? key
        return String(template).replace(/\{\{(\w+)\}\}/gu, (_, name) => String(vars?.[name] ?? ''))
      }
    }

    /** Today's calendar day in the host's window (Asia/Shanghai), as `YYYY-MM-DD`. */
    function todayKey() {
      try {
        return new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Shanghai',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date())
      } catch {
        return new Date().toISOString().slice(0, 10)
      }
    }

    /** One request with a timeout; non-2xx answers become a readable error. */
    async function request(path, method = 'GET', settings) {
      const headers = {}
      if (settings !== undefined) {
        // The host half adopts these, so a settings change reaches it without a restart.
        headers['x-workbuddy-checkin-config'] = btoa(unescape(encodeURIComponent(JSON.stringify(settings))))
      }
      const response = await fetch(path, { method, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      let body
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      if (!response.ok) {
        const error = new Error(String(body?.error ?? `HTTP ${response.status}`))
        error.status = response.status
        throw error
      }
      return body
    }

    function formatBalance(value) {
      return typeof value === 'number' ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : undefined
    }

    function formatTime(iso) {
      if (!iso) return ''
      try {
        return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      } catch {
        return ''
      }
    }

    /** The checkable accounts, i.e. the ones a check-in may send a request for. */
    function checkableOf(data) {
      const accounts = Array.isArray(data?.accounts) ? data.accounts : []
      return accounts.filter((account) => account.live && account.enterprise !== true)
    }

    /**
     * The single place that turns the host answer into the state the entry and the
     * panel both render. Every branch has something visible to show, so no state is
     * silent: a missing answer is "loading", a failed request is "error" with a retry,
     * and a signed-out or unreadable credential keeps the entry instead of hiding it.
     */
    function viewOf(data, error, t) {
      if (data === undefined) {
        if (error !== undefined) return { kind: 'error', tone: 'error', badge: t('loadFailed'), dot: T.error }
        return { kind: 'loading', tone: 'muted', badge: t('querying'), dot: T.dimmed }
      }
      if (data.login === 'signed-out') return { kind: 'signed-out', tone: 'muted', badge: t('signedOut'), dot: T.dimmed }
      if (data.login === 'unreadable') return { kind: 'unreadable', tone: 'muted', badge: t('unreadable'), dot: T.dimmed }
      const checkable = checkableOf(data)
      if (checkable.length === 0) return { kind: 'empty', tone: 'muted', badge: t('empty'), dot: T.dimmed }
      if (data.canCheckin === true) {
        const waiting = checkable.filter((account) => account.state === 'pending' || account.state === 'failed').length
        return { kind: 'pending', tone: 'warn', badge: t('notCheckedIn'), dot: T.warn, waiting }
      }
      if (checkable.some((account) => account.state === 'failed' || account.state === 'needRelogin')) {
        return { kind: 'blocked', tone: 'error', badge: t('blocked'), dot: T.error }
      }
      return { kind: 'done', tone: 'ok', badge: t('done'), dot: T.ok }
    }

    /** The per-account outcome line. */
    function outcomeLine(account, t) {
      if (account.enterprise) return t('enterprise')
      if (!account.live) return account.problem ?? t('expired')
      const credit = account.credit !== undefined ? t('credit', { n: account.credit }) : ''
      if (account.state === 'signed') return [t('signed'), credit].filter(Boolean).join(' · ')
      if (account.state === 'already') return [t('already'), credit].filter(Boolean).join(' · ')
      if (account.state === 'needRelogin') return t('expired')
      if (account.state === 'failed') return t('failed', { error: account.error ?? t('requestFailed') })
      return t('notCheckedIn')
    }

    /** The dot colour of one account row. */
    function accountColor(account) {
      if (account.enterprise || !account.live) return T.dimmed
      if (account.state === 'failed' || account.state === 'needRelogin') return T.error
      if (account.state === 'pending') return T.warn
      return T.ok
    }

    function Dot({ color, size = 7 }) {
      return h('i', {
        'aria-hidden': true,
        style: { width: size, height: size, borderRadius: '50%', background: color, flex: 'none' },
      })
    }

    /** The streak/balance line of one account, rendered only when it has content. */
    function detailsOf(account, t, showBalance) {
      if (!showBalance) return account.streakDays === undefined ? [] : [t('streak', { n: account.streakDays })]
      const archived = account.state === 'already' || account.state === 'signed'
      // A pending account has no credits yet: showing "暂不可用" there is noise.
      const hasBalance = typeof account.balance === 'number' || archived
      return [
        account.streakDays === undefined ? undefined : t('streak', { n: account.streakDays }),
        hasBalance ? `${t('balance')}：${formatBalance(account.balance) ?? t('balanceUnknown')}` : undefined,
        account.balanceError ?? undefined,
      ].filter(Boolean)
    }

    /** One account row: identity, outcome, and the optional second line. */
    function AccountRow({ account, t, showBalance }) {
      const color = accountColor(account)
      const details = detailsOf(account, t, showBalance)
      return h('div', { style: { padding: '7px 0', borderTop: `1px solid ${T.border}` } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 } },
          h(Dot, { color }),
          h('span', {
            style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, account.nickname || String(account.uid ?? '').slice(0, 8) || '—'),
          h('span', {
            style: {
              fontSize: 12, color: color === T.ok ? T.secondary : color, minWidth: 0,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
          }, outcomeLine(account, t)),
        ),
        details.length > 0 && h('div', { style: { fontSize: 12, color: T.secondary, marginTop: 3, paddingLeft: 13 } },
          details.join(' · ')),
      )
    }

    /** The banner that explains the current state and offers the matching action. */
    function StateBlock({ view, data, t, busy, onAction }) {
      const body = (() => {
        if (view.kind === 'loading') return t('loading')
        if (view.kind === 'error') return t('loadFailed')
        if (view.kind === 'signed-out') return t('signInHint')
        if (view.kind === 'unreadable') return [t('unreadableHint'), data?.keyError].filter(Boolean).join('\n')
        if (view.kind === 'empty') return t('noAccountsHint')
        if (view.kind === 'blocked') return t('blockedHint')
        if (view.kind === 'pending') return view.waiting > 0 ? t('pendingHint', { n: view.waiting }) : t('notCheckedIn')
        return t('doneHint')
      })()
      const action = view.kind === 'error' ? t('retry')
        : view.kind === 'signed-out' || view.kind === 'unreadable' || view.kind === 'empty' ? t('recheck')
          : undefined
      return h('div', {
        style: {
          marginTop: 10, padding: '8px 10px', borderRadius: 8, background: T.layer2,
          border: `1px solid ${view.tone === 'muted' ? T.border : view.dot}`,
          color: view.tone === 'muted' ? T.secondary : T.text,
          lineHeight: 1.55, whiteSpace: 'pre-wrap',
        },
      },
        body,
        action !== undefined && h('button', {
          type: 'button',
          onClick: onAction,
          disabled: busy,
          style: {
            display: 'block', marginTop: 8, padding: '5px 10px', borderRadius: 6,
            border: `1px solid ${T.border}`, background: 'transparent', color: 'inherit',
            cursor: busy ? 'wait' : 'pointer', fontSize: 12,
          },
        }, action),
      )
    }

    /** The sidebar entry (always rendered) and its popover. */
    function CheckinEntry({ wide, settings }) {
      const t = translator()
      const [data, setData] = useState(undefined)
      const [open, setOpen] = useState(false)
      const [anchor, setAnchor] = useState(undefined)
      const [loading, setLoading] = useState(true)
      const [working, setWorking] = useState(false)
      const [refreshing, setRefreshing] = useState(false)
      const [error, setError] = useState(undefined)
      const [notice, setNotice] = useState(undefined)
      const requestId = useRef(0)
      const buttonRef = useRef(null)
      const panelRef = useRef(null)
      const dataRef = useRef(data)
      dataRef.current = data
      /** When the last successful read landed, used to space out expensive retries. */
      const loadedAt = useRef(0)

      const load = async (path, method) => {
        const id = ++requestId.current
        try {
          const next = await request(path, method, settings)
          if (id !== requestId.current) return undefined
          setData(next)
          setError(undefined)
          loadedAt.current = Date.now()
          return next
        } catch (cause) {
          if (id !== requestId.current) return undefined
          // Keep the last good answer on screen; the banner reports the failed refresh.
          setError(cause instanceof Error ? cause.message : String(cause))
          return undefined
        }
      }
      // Timers call the latest load without being re-created on every render.
      const loadRef = useRef(load)
      loadRef.current = load

      // First read: the entry reads "查询中…" until the answer lands, never an empty box.
      useEffect(() => {
        let alive = true
        loadRef.current(STATUS_PATH).finally(() => {
          if (alive) setLoading(false)
        })
        return () => {
          alive = false
        }
      }, [])

      useEffect(() => {
        if (!notice) return undefined
        const timer = setTimeout(() => setNotice(undefined), 5000)
        return () => clearTimeout(timer)
      }, [notice])

      const view = viewOf(data, error, t)
      // Timers read the live view through a ref so the interval is created once.
      const viewRef = useRef(view)
      viewRef.current = view

      // States that can heal on their own: WorkBuddy may be started after DSH.
      // `unreadable` is retried slowly — each read may spawn WorkBuddy's Electron.
      useEffect(() => {
        const timer = setInterval(() => {
          const kind = viewRef.current.kind
          if (kind === 'signed-out' || kind === 'empty' || kind === 'error') {
            loadRef.current(STATUS_PATH)
            return
          }
          if (kind === 'unreadable' && Date.now() - loadedAt.current >= UNREADABLE_POLL_MS) {
            loadRef.current(STATUS_PATH)
          }
        }, ATTENTION_POLL_MS)
        return () => clearInterval(timer)
      }, [])

      // A panel left open overnight must not keep yesterday's "今日已完成".
      useEffect(() => {
        const check = () => {
          const current = dataRef.current
          if (current === undefined || current.day !== todayKey()) loadRef.current(STATUS_PATH)
        }
        const timer = setInterval(check, DAY_POLL_MS)
        const onVisible = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          check()
        }
        window.addEventListener('focus', onVisible)
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          clearInterval(timer)
          window.removeEventListener('focus', onVisible)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [])

      // Escape and outside clicks close the popover like any other menu.
      useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onPointer = (event) => {
          const target = event.target
          if (panelRef.current?.contains?.(target)) return
          if (buttonRef.current?.contains?.(target)) return
          setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('pointerdown', onPointer, true)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('pointerdown', onPointer, true)
        }
      }, [open])

      const measure = () => {
        const element = buttonRef.current
        if (!element || typeof element.getBoundingClientRect !== 'function') return
        const rect = element.getBoundingClientRect()
        setAnchor({ left: rect.left, top: rect.top })
      }

      const toggle = async () => {
        if (open) {
          setOpen(false)
          return
        }
        measure()
        setOpen(true)
        setLoading(true)
        const next = await load(STATUS_PATH)
        setLoading(false)
        if (next?.auto) setNotice(t('auto'))
      }

      const recheck = async () => {
        setLoading(true)
        await load(STATUS_PATH)
        setLoading(false)
      }

      const checkin = async () => {
        if (working) return
        setWorking(true)
        const next = await load(CHECKIN_PATH, 'POST')
        setWorking(false)
        if (next === undefined) return
        const accounts = Array.isArray(next.accounts) ? next.accounts : []
        const usable = accounts.filter((account) => account.live && !account.enterprise)
        const fresh = usable.filter((account) => account.state === 'signed')
        const already = usable.filter((account) => account.state === 'already')
        if (fresh.length === 0 && already.length === 0) {
          const failure = accounts.find((account) => account.state === 'failed' || account.state === 'needRelogin')
          setNotice(failure ? outcomeLine(failure, t) : t('done'))
          return
        }
        const credit = fresh.reduce((sum, account) => sum + (typeof account.credit === 'number' ? account.credit : 0), 0)
        setNotice([
          fresh.length > 0 ? t('signed') : t('already'),
          fresh.length > 1 ? `×${fresh.length}` : '',
          credit > 0 ? t('credit', { n: credit }) : '',
        ].filter(Boolean).join(' · '))
      }

      const refresh = async () => {
        if (refreshing) return
        setRefreshing(true)
        await load(REFRESH_PATH, 'POST')
        setRefreshing(false)
      }

      const signedOut = view.kind === 'signed-out' || view.kind === 'unreadable'
      // The entry is never removed: a hidden entry cannot be clicked, cannot explain
      // itself, and cannot recover once WorkBuddy starts later.
      const compact = signedOut && settings?.hideWhenSignedOut === true
      const showBalance = settings?.showBalance !== false
      const canCheckin = data?.canCheckin === true
      const checkable = checkableOf(data)
      const label = view.kind === 'done' ? t('done') : view.badge

      const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth
      const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight
      const left = Math.max(8, Math.min(anchor?.left ?? 76, Math.max(8, viewportWidth - PANEL_WIDTH - 8)))
      const bottom = anchor === undefined ? 64 : Math.max(8, viewportHeight - anchor.top + 8)

      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          ref: buttonRef,
          onClick: toggle,
          title: `${t('title')} — ${label}`,
          'aria-label': t('open'),
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          style: {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            border: 0, background: open ? T.layer2 : 'transparent', color: 'inherit',
            cursor: 'pointer', padding: wide ? '6px 8px' : '6px', borderRadius: 8,
          },
        },
          h('svg', {
            viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none', stroke: 'currentColor',
            strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
          },
            h('rect', { x: 3.25, y: 4.75, width: 17.5, height: 15.5, rx: 3.5 }),
            h('path', { d: 'M7.75 3.25v3M16.25 3.25v3' }),
            h('path', { d: 'M3.25 9.5h17.5' }),
            h('path', { d: 'M7.9 14.55l2.2 2.2 4.4-4.5' }),
          ),
          h(Dot, { color: view.dot }),
          wide && !compact && h('span', {
            style: {
              fontSize: 12, maxWidth: 92, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              color: view.tone === 'ok' ? T.secondary : view.tone === 'muted' ? T.dimmed : view.dot,
            },
          }, label),
        ),
        open && h('div', {
          ref: panelRef,
          role: 'dialog',
          'aria-label': t('title'),
          style: {
            position: 'fixed', zIndex: 1000, left, bottom, width: PANEL_WIDTH,
            background: T.layer, border: `1px solid ${T.border}`, borderRadius: 12,
            padding: 14, boxShadow: '0 18px 45px #0008', color: T.text, fontSize: 13,
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('b', { style: { fontSize: 14 } }, t('title')),
            h(Dot, { color: view.dot }),
            h('button', {
              type: 'button',
              onClick: () => setOpen(false),
              'aria-label': t('close'),
              style: {
                marginLeft: 'auto', background: 'transparent', border: 0, color: T.secondary,
                fontSize: 18, cursor: 'pointer', lineHeight: 1, padding: '0 2px',
              },
            }, '×'),
          ),
          notice && h('div', {
            role: 'status',
            style: {
              marginTop: 8, padding: '6px 8px', borderRadius: 8,
              background: T.layer2, border: `1px solid ${view.dot}`,
            },
          }, notice),
          // A failed refresh keeps the last answer on screen and reports itself here.
          error !== undefined && h('div', { role: 'alert', style: { marginTop: 8, color: T.error } },
            `${t('loadFailed')}（${error}）`),
          view.kind === 'loading'
            ? h('div', { role: 'status', style: { marginTop: 10, color: T.secondary, lineHeight: 1.55 } }, t('loading'))
            : h(StateBlock, { view, data, t, busy: loading, onAction: recheck }),
          Array.isArray(data?.accounts) && data.accounts.length > 0 && h('div', {
            style: { marginTop: 10, maxHeight: 220, overflowY: 'auto' },
          },
            data.accounts.map((account, index) => h(AccountRow, {
              key: account.uid ?? `account-${index}`, account, t, showBalance,
            })),
          ),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 12 } },
            h('button', {
              type: 'button',
              disabled: working || refreshing || !canCheckin,
              onClick: checkin,
              style: {
                flex: 1, padding: '8px 10px', borderRadius: 8, border: 0,
                minHeight: 34, lineHeight: 1.2,
                background: canCheckin ? T.accent : T.layer2,
                color: canCheckin ? T.onAccent : T.secondary,
                cursor: canCheckin && !working ? 'pointer' : 'not-allowed',
                fontWeight: 600, fontSize: 13,
              },
            }, working
              ? t('checking')
              : canCheckin
                ? t('checkinButton')
                : view.kind === 'done'
                  ? `✓ ${t('done')}`
                  : label),
            h('button', {
              type: 'button',
              disabled: refreshing || working,
              onClick: refresh,
              title: t('refresh'),
              'aria-label': t('refresh'),
              style: {
                padding: '8px 10px', borderRadius: 8, border: `1px solid ${T.border}`,
                background: 'transparent', color: 'inherit',
                cursor: refreshing ? 'wait' : 'pointer', fontSize: 13,
              },
            }, refreshing ? '↻…' : '↻'),
          ),
          checkable.length > 0 && h('div', { style: { marginTop: 8, fontSize: 11, color: T.dimmed } },
            [
              `${t('today')} ${data?.ready ?? 0}/${data?.total ?? 0}`,
              data?.checkedAt ? t('lastChecked', { time: formatTime(data.checkedAt) }) : '',
            ].filter(Boolean).join(' · ')),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx, config = {}) {
        const settings = {
          autoCheckinOnOpen: config.autoCheckinOnOpen === true,
          hideWhenSignedOut: config.hideWhenSignedOut !== false,
          showBalance: config.showBalance !== false,
        }
        // `label` is a seat option the owner projects as plain text, so it stays a
        // string thunk; the settings reach the component through this closure.
        const label = () => 'WorkBuddy'
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'workbuddy-checkin',
          order: 20,
          label,
        }, (props) => h(CheckinEntry, { ...props, settings })))
      },
    }
  },
})
