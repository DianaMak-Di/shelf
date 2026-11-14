import { createContext, Fragment, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import { RefreshCw, Plus, X, ChevronDown, Search, SearchX, Check, MapPin, MapPinOff, Plug, CircleCheck, CircleAlert, Circle, LoaderCircle, Sun, Moon, Monitor, ArrowUpRight, ArrowDownUp, SlidersHorizontal, ChevronRight, ChevronUp, Inbox, Film, Folder, Heart, Copy, Play, Map as MapIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Command as CommandPrimitive } from 'cmdk'
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import L from 'leaflet'
import type { Lang, Reel } from '@/types'

const TOP = 10
const MIN_TAG = 5 // rarer tags are noise in the sidebar; they still match via search
const SORTS: Record<string, (a: Reel, b: Reel) => number> = {
  saved: (a, b) => a.order - b.order,
  saved_old: (a, b) => b.order - a.order,
  date: (a, b) => (b.upload_date ?? '').localeCompare(a.upload_date ?? ''),
  date_old: (a, b) => (a.upload_date ?? '').localeCompare(b.upload_date ?? ''),
  likes: (a, b) => (b.likes ?? 0) - (a.likes ?? 0),
  views: (a, b) => (b.views ?? 0) - (a.views ?? 0),
  short: (a, b) => (a.duration ?? 0) - (b.duration ?? 0),
  long: (a, b) => (b.duration ?? 0) - (a.duration ?? 0),
  author: (a, b) => a.author.localeCompare(b.author),
  title: (a, b) => (a.title ?? '').localeCompare(b.title ?? ''),
}
const fmtDate = (d?: string) => (d && d.length === 8 ? `${d.slice(6)}.${d.slice(4, 6)}.${d.slice(0, 4)}` : '')
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
const f = (s: string, v: Record<string, string | number> = {}) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''))
// plural form of a UI string like {one, few, many, other} (lang/*.py) for n in the UI language
const plural = (forms: Record<string, string>, n: number, lang: string) => f(forms[new Intl.PluralRules(lang).select(n)] ?? forms.other, { n })
// title stub for a video without a title: summary cut at a word boundary
const cut = (s: string, n = 60) => {
  if (s.length <= n) return s
  const c = s.slice(0, n), i = c.lastIndexOf(' ')
  return (i > n / 2 ? c.slice(0, i) : c) + '…'
}

const SOURCES: Record<string, string> = { instagram: 'Instagram', tiktok: 'TikTok', telegram: 'Telegram' }
// same domains as shelf.SOURCES; anything else is not added
const LINK = /^(https?:\/\/)?([\w-]+\.)*(instagram\.com|tiktok\.com|t\.me|telegram\.me)\/\S+/i

const LangCtx = createContext<Lang>(null as unknown as Lang)
const useLang = () => useContext(LangCtx)

// Map tiles stay light in both themes (filters spoil labels); swap this URL for a dark provider if one is chosen.
const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

// Theme: 'system' follows the OS. index.html sets the class before first paint with the same key and rule.
type Theme = 'light' | 'dark' | 'system'
const THEME_KEY = 'shelf-theme'
const THEMES = { light: Sun, dark: Moon, system: Monitor }

function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try { const t = localStorage.getItem(THEME_KEY); return t === 'light' || t === 'dark' ? t : 'system' } catch { return 'system' }
  })
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      // no transitions during the swap, otherwise every color transition fires at once
      const off = document.createElement('style')
      off.textContent = '*,*::before,*::after{transition:none!important}'
      document.head.append(off)
      document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && mq.matches))
      void getComputedStyle(document.body).opacity
      requestAnimationFrame(() => off.remove())
    }
    apply()
    if (theme !== 'system') return
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
  const set = (t: Theme) => {
    setTheme(t)
    try { localStorage.setItem(THEME_KEY, t) } catch { /* no storage: next load falls back to system */ }
  }
  return [theme, set] as const
}

function ThemeSelect({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  const { ui } = useLang()
  const Icon = THEMES[theme]
  const label = `${ui.theme}: ${ui['theme_' + theme]}`
  return (
    <Select value={theme} onValueChange={(v) => v && setTheme(v as Theme)}>
      <SelectTrigger aria-label={label} title={label}
        className="size-8 justify-center border-border bg-card p-0 hover:bg-muted data-popup-open:bg-muted max-md:size-11 pointer-coarse:size-11 data-[size=default]:max-md:h-11 data-[size=default]:pointer-coarse:h-11 [&>svg:last-child]:hidden">
        <Icon aria-hidden />
      </SelectTrigger>
      <SelectContent align="end" alignItemWithTrigger={false} className="w-auto">
        {(Object.keys(THEMES) as Theme[]).map((k) => {
          const I = THEMES[k]
          return <SelectItem key={k} value={k}><I aria-hidden />{ui['theme_' + k]}</SelectItem>
        })}
      </SelectContent>
    </Select>
  )
}

// n / total / started / steps (names of the steps) come from server.py
type Sync = { running: boolean; step: string; log: string; error: string; n?: number; total?: number; started?: number; steps?: string[] }
type Sources = { telegram: string | null; tiktok: number | null; later: string[]; obsidian: string | null }

// every POST carries this header: the server refuses posts without it, so other sites cannot post to it
const post = (url: string, body: BodyInit) => fetch(url, { method: 'POST', headers: { 'X-Shelf': '1' }, body })
const postJson = async (url: string, data: object) => {
  const r = await post(url, JSON.stringify(data))
  const j = await r.json().catch(() => ({ error: String(r.status) }))
  if (!r.ok || j.error) throw new Error(j.error || String(r.status))
  return j
}

function useReels() {
  const [reels, setReels] = useState<Reel[]>([])
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const load = useCallback((): Promise<Reel[] | null> => fetch('api/reels')
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json() })
    .then((l: Reel[]) => { setReels(l); setState('ok'); return l })
    .catch(() => { setState('error'); return null }), [])
  useEffect(() => { load() }, [load])
  return { reels, load, state }
}

// Sync state lives in Main: the strip, the header button and the command menu share it.
function useSync(reload: () => Promise<Reel[] | null>, knownIds: () => Set<string>) {
  const { ui } = useLang()
  const [st, setSt] = useState<Sync | null>(null)
  const [fin, setFin] = useState<number | null>(null) // new videos after a successful sync
  const [hidden, setHidden] = useState(false)
  const before = useRef(new Set<string>())
  const failed = (error: string): Sync => ({ running: false, step: '', log: '', error })
  const start = async (urls: string[]) => {
    before.current = knownIds()
    setHidden(false); setFin(null)
    try {
      const r = await post('api/sync', JSON.stringify({ urls }))
      setSt(r.status === 409 ? failed(ui.ob_busy.replace(/\.$/, '')) : await r.json()) // 409: a sync or an Obsidian export is already running
    } catch { setSt(failed(ui.no_server)) }
  }
  // a reload during a sync keeps the strip: ask once, the polling below takes over
  useEffect(() => {
    fetch('api/sync').then((r) => r.json()).then(async (s: Sync) => {
      if (!s.running) return
      const l = await reload()
      before.current = new Set((l ?? []).map((r) => r.id))
      setSt(s)
    }).catch(() => {})
  }, [reload])
  const running = !!st?.running
  useEffect(() => {
    if (!running) return
    const t = setInterval(async () => {
      try {
        const s: Sync = await fetch('api/sync').then((r) => r.json())
        if (s.running) { setSt(s); return }
        clearInterval(t)
        const l = await reload() // the strip stays in "running" until the list is fresh
        setSt(s)
        if (!s.error && l) setFin(l.filter((r) => !before.current.has(r.id)).length)
      } catch { clearInterval(t); setSt(failed(ui.no_server)) }
    }, 2000)
    return () => clearInterval(t)
  }, [running, reload, ui.no_server])
  const kind = running ? 'running' : hidden ? null : st?.error ? 'error' : fin !== null ? 'done' : null
  const hide = useCallback(() => setHidden(true), [])
  return { st, kind, fin, start, hide, running }
}
type SyncCtl = ReturnType<typeof useSync>

function SyncStrip({ sync, onShowNew }: { sync: SyncCtl; onShowNew: () => void }) {
  const { ui } = useLang()
  const { st, kind, fin, start, hide } = sync
  const [more, setMore] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [engaged, setEngaged] = useState(false) // cursor or focus on the strip: do not hide "Done" under it
  useEffect(() => {
    if (kind !== 'running') return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [kind])
  useEffect(() => {
    if (kind !== 'done' || engaged) return
    const t = setTimeout(hide, 8000)
    return () => clearTimeout(t)
  }, [kind, engaged, hide])
  if (!kind || !st) return null

  const n = st.n ?? 0
  const total = st.total || st.steps?.length || 0
  const known = n > 0 && total > 0 // n is 0 while the first step has not started
  const elapsed = st.started ? fmtTime(Math.max(0, Math.floor(now / 1000 - st.started))) : ''
  const steps = Array.from({ length: total }, (_, i) => i + 1)
  const reason = (st.error || '').replace(/\s+/g, ' ').trim()
  const kept = f(ui.sync_kept, { e: '\u0001' }).split('\u0001') // the reason may be cut short, the "kept" part never
  const toggle = (label: string) => (
    <Button variant="ghost" aria-expanded={more} onClick={() => setMore(!more)} className="pointer-coarse:h-11">{more ? ui.collapse : label}</Button>
  )
  const x = <Button variant="ghost" size="icon" aria-label={ui.hide} title={ui.hide} onClick={hide} className="pointer-coarse:size-11"><X /></Button>

  return (
    <div onMouseEnter={() => setEngaged(true)} onMouseLeave={() => setEngaged(false)} onFocus={() => setEngaged(true)} onBlur={() => setEngaged(false)}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border bg-card py-2 ps-4 pe-2 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200">
      {kind === 'running' && <>
        <LoaderCircle aria-hidden className="size-4 shrink-0 text-muted-foreground motion-safe:animate-spin" />
        <span role="status" className="text-sm font-medium tabular-nums whitespace-nowrap">
          <span className="max-md:hidden">{known ? f(ui.sync_step, { n, m: total }) : ui.sync}</span>
          <span className="md:hidden">{known ? f(ui.sync_step_short, { n, m: total }) : ui.sync}</span>
        </span>
        <span className="min-w-0 truncate text-sm text-muted-foreground max-md:hidden">{st.step}</span>
        {elapsed && <span className="text-sm whitespace-nowrap tabular-nums text-muted-foreground max-md:hidden">{f(ui.sync_elapsed, { t: elapsed })}</span>}
        <div className="ms-auto flex shrink-0 items-center gap-3">
          {known && <div aria-hidden className="grid w-40 gap-[3px] max-md:hidden" style={{ gridTemplateColumns: `repeat(${total}, minmax(0, 1fr))` }}>
            {Array.from({ length: total }, (_, i) => <span key={i} className={cn('h-1 rounded-full', i < n - 1 ? 'bg-foreground' : 'bg-secondary')} />)}
          </div>}
          {toggle(ui.sync_more)}
        </div>
      </>}
      {kind === 'error' && <>
        <CircleAlert aria-hidden className="size-4 shrink-0 text-destructive" />
        <p role="alert" title={reason} className="min-w-0 flex-1 basis-48 text-sm max-md:line-clamp-2 md:flex">
          {known
            ? <>
                <span className="font-medium md:me-1 md:whitespace-nowrap">{f(ui.sync_failed_at, { n, m: total })}</span>{' '}
                <span className="text-muted-foreground md:min-w-0 md:truncate">{kept[0]}{reason}</span>
                <span className="text-muted-foreground md:shrink-0 md:whitespace-nowrap">{kept[1]}</span>
              </>
            : <span className="font-medium">{f(ui.sync_failed, { e: reason })}</span>}
        </p>
        <div className="ms-auto flex shrink-0 items-center gap-2">
          {toggle(ui.sync_log)}
          <Button variant="outline" onClick={() => start([])} className="pointer-coarse:h-11">{ui.retry}</Button>
          {x}
        </div>
      </>}
      {kind === 'done' && <>
        <CircleCheck aria-hidden className="size-4 shrink-0 text-success" />
        <span role="status" className="text-sm font-medium tabular-nums">{f(ui.sync_done, { n: fin ?? 0 })}</span>
        <div className="ms-auto flex shrink-0 items-center gap-2">
          {!!fin && <Button variant="ghost" onClick={() => { onShowNew(); hide() }} className="pointer-coarse:h-11">{ui.show_new}</Button>}
          {x}
        </div>
      </>}
      {more && kind !== 'done' && (
        <div className="grid basis-full gap-3 border-t py-3 pe-2">
          {steps.length > 0 && <ol className="grid gap-1.5 text-sm">
            {steps.map((i) => {
              const state = i < n ? 'done' : i === n ? (kind === 'error' ? 'fail' : 'cur') : 'todo'
              return (
                <li key={i} aria-current={state === 'cur' ? 'step' : undefined}
                  className={cn('flex items-center gap-2', state === 'todo' ? 'text-muted-foreground' : state === 'done' ? '' : 'font-medium')}>
                  {state === 'done' ? <CircleCheck aria-hidden className="size-4 shrink-0 text-success" />
                    : state === 'fail' ? <CircleAlert aria-hidden className="size-4 shrink-0 text-destructive" />
                    : state === 'cur' ? <LoaderCircle aria-hidden className="size-4 shrink-0 motion-safe:animate-spin" />
                    : <Circle aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
                  {st.steps?.[i - 1]}
                </li>
              )
            })}
          </ol>}
          {st.log.trim() && <pre tabIndex={0} aria-label={ui.sync_log} className="max-h-40 overflow-y-auto overscroll-contain font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground">{st.log.trim()}</pre>}
        </div>
      )}
    </div>
  )
}

function AddLinks({ open, setOpen, running, start }: { open: boolean; setOpen: (o: boolean) => void; running: boolean; start: (urls: string[]) => void }) {
  const { ui } = useLang()
  const [links, setLinks] = useState('')
  const words = links.split(/\s+/).filter(Boolean)
  const urls = words.filter((l) => LINK.test(l))
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" size="icon" title={ui.add_links} aria-label={ui.add_links} className="max-md:size-11 pointer-coarse:size-11" />}>
        <Plus />
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[min(24rem,calc(100vw-2rem))] gap-2 p-4">
        <label htmlFor="links" className="text-sm font-medium">{ui.paste_links}</label>
        <Textarea id="links" rows={4} value={links} onChange={(e) => setLinks(e.target.value)} aria-describedby="links-hint" />
        <p id="links-hint" className="text-xs text-muted-foreground">
          {words.length > urls.length ? f(ui.links_skipped, { n: words.length - urls.length }) : ui.links_hint}
        </p>
        <Button className="self-end" disabled={!urls.length || running} onClick={() => { start(urls); setLinks(''); setOpen(false) }}>
          {f(ui.add_sync, { n: urls.length })}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

function Field({ label, hint, ...p }: { label: string; hint?: string } & React.ComponentProps<typeof Input>) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <Input {...p} />
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  )
}

// external link marker; icon instead of a "↗" glyph
const Ext = () => <ArrowUpRight aria-hidden className="ms-0.5 inline size-3.5 align-[-0.125em]" />
const EXT_SVG = '<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ms-0.5 inline size-3.5 align-[-0.125em]"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>'

function Steps({ items }: { items: string[] }) {
  // "A → B → C" in lang strings: draw the separators as icons
  const path = (t: string) => t.split(' → ').flatMap((s, i) => i ? [<ChevronRight key={i} aria-label="→" className="mx-0.5 inline size-3.5 align-[-0.125em]" />, s] : [s])
  return <ol className="list-decimal space-y-1 ps-5 text-sm text-muted-foreground">{items.map((t) => <li key={t}>{path(t)}</li>)}</ol>
}

function TelegramSetup({ src, reload }: { src: Sources; reload: () => void }) {
  const { ui } = useLang()
  const [stage, setStage] = useState<'creds' | 'code' | 'password'>('creds')
  const [v, setV] = useState({ api_id: '', api_hash: '', phone: '', code: '', password: '', hash: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value })
  const call = async (step: string, data: object) => {
    setBusy(true); setErr('')
    try { return await postJson('api/telegram/' + step, data) } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (stage === 'creds') {
      const r = await call('code', { api_id: v.api_id, api_hash: v.api_hash, phone: v.phone })
      if (r) { setV({ ...v, hash: r.hash }); setStage('code') }
    } else {
      const r = stage === 'code' ? await call('sign_in', { phone: v.phone, code: v.code, hash: v.hash }) : await call('password', { password: v.password })
      if (r?.password) setStage('password')
      else if (r?.ok) { setV({ ...v, code: '', password: '' }); setStage('creds'); reload() }
    }
  }
  if (src.telegram) return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <CircleCheck className="size-4 text-success" aria-hidden /> {f(ui.tg_connected, { u: src.telegram })}
      <Button size="sm" variant="ghost" disabled={busy} onClick={async () => { if (await call('logout', {})) reload() }}>{ui.tg_logout}</Button>
      {err && <p role="alert" className="w-full text-sm text-destructive">{f(ui.ob_error, { e: err })}</p>}
    </div>
  )
  return (
    <form onSubmit={submit} className="grid gap-3">
      {stage === 'creds' && <>
        <Steps items={[ui.tg_step1, ui.tg_step2, ui.tg_step3]} />
        <a href="https://my.telegram.org/apps" target="_blank" rel="noreferrer" className="w-fit text-sm underline">my.telegram.org<Ext /></a>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="api_id" inputMode="numeric" pattern="[0-9]+" autoComplete="off" required value={v.api_id} onChange={set('api_id')} />
          <Field label="api_hash" autoComplete="off" spellCheck={false} required value={v.api_hash} onChange={set('api_hash')} />
        </div>
        <Field label={ui.tg_phone} type="tel" autoComplete="tel" placeholder="+7 900 000-00-00" required value={v.phone} onChange={set('phone')} />
      </>}
      {stage === 'code' && <Field label={ui.tg_code} hint={ui.tg_code_hint} inputMode="numeric" autoComplete="one-time-code" required autoFocus value={v.code} onChange={set('code')} />}
      {stage === 'password' && <Field label={ui.tg_password} type="password" autoComplete="current-password" required autoFocus value={v.password} onChange={set('password')} />}
      {err && <p role="alert" className="text-sm text-destructive">{f(ui.ob_error, { e: err })}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy}>{stage === 'creds' ? ui.tg_get_code : ui.tg_sign_in}</Button>
        {stage !== 'creds' && <Button type="button" variant="ghost" onClick={() => { setStage('creds'); setErr('') }}>{ui.tg_back}</Button>}
      </div>
      <p className="text-xs text-muted-foreground">{ui.tg_privacy}</p>
    </form>
  )
}

function TikTokSetup({ src, reload }: { src: Sources; reload: () => void }) {
  const { ui } = useLang()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const upload = async (file?: File) => {
    if (!file) return
    setBusy(true); setErr('')
    try { await postJson('api/tiktok', file); reload() } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="grid gap-3">
      {src.tiktok !== null
        ? <p className="flex items-center gap-2 text-sm"><CircleCheck className="size-4 text-success" aria-hidden />{f(ui.tt_loaded, { n: src.tiktok })}</p>
        : <>
            <p className="text-sm text-muted-foreground">{ui.tt_why}</p>
            <Steps items={[ui.tt_step1, ui.tt_step2, ui.tt_step3]} />
          </>}
      <label className={`w-fit ${busy ? 'pointer-events-none opacity-50' : ''}`}>
        <input type="file" accept=".zip,.json,application/zip,application/json" className="peer sr-only" disabled={busy}
          onChange={(e) => { upload(e.target.files?.[0]); e.target.value = '' }} />
        <span className="inline-flex h-8 cursor-pointer items-center rounded-lg border px-3 text-sm font-medium hover:bg-secondary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring">
          {busy ? ui.tt_uploading : src.tiktok !== null ? ui.tt_replace : ui.tt_upload}
        </span>
      </label>
      {err && <p role="alert" className="text-sm text-destructive">{f(ui.ob_error, { e: err })}</p>}
    </div>
  )
}

function ObsidianSetup({ src }: { src: Sources }) {
  const { ui } = useLang()
  const [path, setPath] = useState(src.obsidian ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [res, setRes] = useState('')
  const run = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setErr(''); setRes('')
    try {
      const r = await postJson('api/obsidian', { path })
      setRes(f(ui.obs_result, { n: r.new, u: r.updated, s: r.unchanged }))
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <form onSubmit={run} className="grid gap-3">
      <p className="text-sm text-muted-foreground">{ui.obs_desc}</p>
      <Field label={ui.obs_path} placeholder="~/Documents/Vault/shelf" autoComplete="off" spellCheck={false} required value={path} onChange={(e) => setPath(e.target.value)} />
      <Button type="submit" variant="outline" disabled={busy} className="w-fit">{busy ? ui.obs_exporting : ui.obs_export}</Button>
      <p role="status" className="flex items-center gap-2 text-sm empty:hidden">{res && <><CircleCheck className="size-4 text-success" aria-hidden />{res}</>}</p>
      {err && <p role="alert" className="text-sm text-destructive">{f(ui.ob_error, { e: err })}</p>}
    </form>
  )
}

function Onboarding({ open, setOpen }: { open: boolean; setOpen: (o: boolean) => void }) {
  const { ui } = useLang()
  const [src, setSrc] = useState<Sources | null>(null)
  const [changed, setChanged] = useState(false)
  const reload = useCallback((auto = false) => fetch('api/sources').then((r) => r.json()).then((s: Sources) => {
    setSrc(s)
    // first visit: open by itself while something is neither connected nor put off with "Add later"
    if (auto && ((!s.telegram && !s.later.includes('telegram')) || (s.tiktok === null && !s.later.includes('tiktok')))) setOpen(true)
  }).catch(() => {}), [setOpen])
  useEffect(() => { reload(true) }, [reload])
  const done = () => { setChanged(true); reload() }
  const later = (item: string) => postJson('api/later', { item }).then(setSrc).catch(() => {})
  const pending = src && [!src.telegram && 'telegram', src.tiktok === null && 'tiktok'].filter((x) => x && !src.later.includes(x as string))
  const section = (id: string, title: string, ok: boolean, body: React.ReactNode) => (
    <section aria-labelledby={'ob-' + id} className="grid gap-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 id={'ob-' + id} className="font-medium">{title}</h3>
        {!ok && !src?.later.includes(id) && <Button size="sm" variant="ghost" onClick={() => later(id)}>{ui.ob_later}</Button>}
      </div>
      {body}
    </section>
  )
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} aria-label={pending && pending.length > 0 ? `${ui.ob_open}, ${ui.ob_pending}` : undefined} className="relative max-md:size-11 max-md:px-0 pointer-coarse:h-11">
        <Plug aria-hidden /><span className="max-md:sr-only">{ui.ob_open}</span>
        {pending && pending.length > 0 && <span className="size-2 rounded-full bg-foreground max-md:absolute max-md:end-2 max-md:top-2" aria-hidden />}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent closeLabel={ui.close} className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{ui.ob_title}</DialogTitle>
            <DialogDescription>{ui.ob_desc}</DialogDescription>
          </DialogHeader>
          {src && <>
            {section('telegram', ui.tg_title, !!src.telegram, <TelegramSetup src={src} reload={done} />)}
            {section('tiktok', ui.tt_title, src.tiktok !== null, <TikTokSetup src={src} reload={done} />)}
            {section('obsidian', ui.obs_title, true, <ObsidianSetup src={src} />)}
          </>}
          <DialogFooter className="items-center gap-2">
            {changed && <p role="status" className="me-auto text-sm text-muted-foreground">{ui.ob_sync_hint}</p>}
            <Button onClick={() => setOpen(false)}>{ui.ob_done}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function Tag({ t, on, n, onClick, className }: { t: string; on: boolean; n?: number; onClick: () => void; className?: string }) {
  const { ui } = useLang()
  return (
    <Badge render={<button type="button" />} aria-pressed={on} aria-label={n !== undefined ? `#${t}, ${f(ui.n_videos, { n })}` : `#${t}`} onClick={onClick}
      className={cn(`relative h-7 cursor-pointer gap-0 overflow-visible rounded-full px-2.5 text-xs font-medium transition-[color,background-color] duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] pointer-coarse:h-9 pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-1 pointer-coarse:before:content-['']
        ${on ? 'bg-foreground text-background hover:bg-foreground/85'
             : 'bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_6%)]'}`, className)}>
      {/* fixed 12px slot for # / check: the chip keeps its width when selected, neighbours do not jump */}
      <span aria-hidden className="inline-flex w-3.5 justify-center">{on ? <Check className="size-3" /> : '#'}</span>
      {t}
      {n !== undefined && <span aria-hidden className={`ms-1 font-normal tabular-nums ${on ? 'opacity-80' : 'text-muted-foreground'}`}>{n}</span>}
    </Badge>
  )
}

const CARD = 'relative flex items-start gap-4 rounded-2xl border bg-card p-3'

function ReelCard({ r, toggle, active, current, onOpen, setRef }: {
  r: Reel; toggle: (t: string) => void; active: Set<string>; current: boolean; onOpen: (id: string, el: HTMLElement) => void; setRef: (id: string, el: HTMLElement | null) => void
}) {
  const { ui, kind_order, hidden_kinds } = useLang()
  const [kRecipe, kPlace] = [kind_order[1], kind_order[3]]
  const all = r.key?.length ? r.key : [
    ...(r.recipes ?? []).map((x) => ({ kind: kRecipe, text: `${x.name ?? ''}: ${(x.ingredients ?? []).join(', ')}. ${x.steps ?? ''}` })),
    ...(r.places ?? []).map((x) => ({ kind: kPlace, text: [x.name, x.city].filter(Boolean).join(', ') })),
  ]
  // the first section by kind order: concrete kinds first
  const ord = (k: string) => { const i = kind_order.indexOf(k); return i < 0 ? Infinity : i } // kinds outside kind_order go last
  const main = all
    .filter((k) => !hidden_kinds.includes(k.kind))
    .sort((a, b) => (ord(a.kind) < ord(b.kind) ? -1 : ord(a.kind) > ord(b.kind) ? 1 : 0))[0]
  const thumb = thumbOf(r)
  const date = fmtDate(r.upload_date)
  return (
    <article aria-current={current ? 'true' : undefined}
      className={cn(CARD, 'transition-[border-color] duration-[120ms] hover:border-input has-[.card-open:focus-visible]:outline-2 has-[.card-open:focus-visible]:outline-offset-2 has-[.card-open:focus-visible]:outline-ring',
        current && 'border-foreground shadow-[inset_0_0_0_1px_var(--foreground)] hover:border-foreground')}>
      <div aria-hidden className="relative aspect-[9/16] w-[104px] shrink-0 overflow-hidden rounded-sm bg-muted after:pointer-events-none after:absolute after:inset-0 after:rounded-sm after:shadow-[inset_0_0_0_1px_oklch(0_0_0/.1)] max-md:w-[72px] dark:after:shadow-[inset_0_0_0_1px_oklch(1_0_0/.1)]">
        {thumb ? <img src={thumb} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" /> : <Film className="absolute inset-0 m-auto size-5 text-muted-foreground" />}
      </div>
      <div className="flex min-w-0 max-w-[68ch] flex-1 flex-col gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-base leading-[1.4] font-semibold">
            <button type="button" ref={(el) => setRef(r.id, el)} onClick={(e) => onOpen(r.id, e.currentTarget)} aria-haspopup="dialog" aria-expanded={current}
              className="card-open line-clamp-2 text-start text-balance after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-none">
              {r.title || (r.summary ? cut(r.summary) : r.id)}
            </button>
          </h3>
          <div className="flex min-w-0 flex-nowrap items-center gap-x-1.5 gap-y-0.5 text-xs whitespace-nowrap text-muted-foreground max-[22rem]:flex-wrap">
            <span className="shrink-0 rounded-sm bg-secondary px-1.5 py-0.5 font-medium text-foreground">{SOURCES[r.source] ?? r.source}</span>
            <a href={r.url} target="_blank" rel="noreferrer" aria-label={f(ui.open_reel_by, { a: r.author })} title={ui.open_reel}
              className="relative z-10 flex min-w-0 shrink items-center hover:underline">
              <span className="truncate">@{r.author}</span><ArrowUpRight aria-hidden className="size-3 shrink-0" />
            </a>
            {date && <><span aria-hidden className="max-[22rem]:hidden">·</span><span className="shrink-0 tabular-nums">{date}</span></>}
          </div>
        </div>
        {r.tags.length > 0 && (
          <div className="relative z-10 flex flex-wrap gap-1.5">
            {r.tags.slice(0, 2).map((t) => <Tag key={t} t={t} on={active.has(t)} onClick={() => toggle(t)} />)}
          </div>
        )}
        {r.summary && <p className="line-clamp-3 text-sm text-pretty">{r.summary}</p>}
        {main && (
          <div className="flex flex-col gap-1 max-md:hidden">
            <div className="text-sm font-medium text-muted-foreground">{main.kind.charAt(0).toUpperCase() + main.kind.slice(1)}</div>
            <p className="line-clamp-2 text-sm text-pretty">{main.text}</p>
          </div>
        )}
      </div>
    </article>
  )
}

// Same card, no text: shown while /api/reels loads. No pulse, so nothing flickers.
function CardSkeleton() {
  return (
    <div aria-hidden className={CARD}>
      <div className="aspect-[9/16] w-[104px] shrink-0 rounded-sm bg-muted max-md:w-[72px]" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="h-4 w-[70%] rounded-sm bg-muted" />
        <div className="h-3 w-[40%] rounded-sm bg-muted" />
        <div className="mt-2 flex flex-col gap-2">
          {['92%', '84%', '60%'].map((w) => <div key={w} className="h-3 rounded-sm bg-muted" style={{ width: w }} />)}
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-0.5">
      <h2 id={id} className="px-2 py-1 text-xs font-medium text-muted-foreground">{title}</h2>
      {children}
    </section>
  )
}

function Facet({ on, label, n, onClick, sheet }: { on: boolean; label: string; n: number; onClick: () => void; sheet?: boolean }) {
  const { ui } = useLang()
  return (
    <button type="button" aria-pressed={on} aria-label={`${label}, ${f(ui.n_videos, { n })}`} onClick={onClick}
      className={cn('flex w-full items-center gap-2 rounded-lg px-2 text-start text-sm transition-colors duration-[120ms] hover:bg-accent',
        sheet ? 'h-11' : 'h-8 pointer-coarse:h-11', on && 'bg-secondary font-medium')}>
      <span aria-hidden className="size-4 shrink-0">{on && <Check className="size-4" />}</span>
      <span aria-hidden className="min-w-0 flex-1 truncate">{label}</span>
      <span aria-hidden className="ms-auto text-xs font-normal tabular-nums text-muted-foreground">{n}</span>
    </button>
  )
}

type FacetData = { cols: [string, number][]; none: number; srcs: [string, number][]; tags: [string, number][]; total: number }

// Collections, source, tags. Used by the sidebar (≥768) and the bottom sheet (<768, `sheet`: bigger rows, all tags).
function Facets({ d, col, setCol, src, setSrc, active, toggle, sheet }: {
  d: FacetData; col: string; setCol: (c: string) => void; src: string; setSrc: (s: string) => void
  active: Set<string>; toggle: (t: string) => void; sheet?: boolean
}) {
  const { ui } = useLang()
  const [more, setMore] = useState(false)
  const list = d.tags.filter(([t, n]) => n >= MIN_TAG || active.has(t))
  const forced = list.slice(TOP).some(([t]) => active.has(t)) // a selected tag must stay visible
  const open = sheet || more || forced
  return (
    <>
      {d.cols.length > 0 && (
        <Section title={ui.collections}>
          <Facet sheet={sheet} on={col === 'all'} label={ui.all_collections} n={d.total} onClick={() => setCol('all')} />
          {d.cols.map(([c, n]) => <Facet key={c} sheet={sheet} on={col === c} label={c} n={n} onClick={() => setCol(col === c ? 'all' : c)} />)}
          {d.none > 0 && <Facet sheet={sheet} on={col === 'none'} label={ui.no_collection} n={d.none} onClick={() => setCol(col === 'none' ? 'all' : 'none')} />}
        </Section>
      )}
      {d.srcs.length > 1 && (
        <Section title={ui.source}>
          <Facet sheet={sheet} on={src === 'all'} label={ui.all_sources} n={d.total} onClick={() => setSrc('all')} />
          {d.srcs.map(([k, n]) => <Facet key={k} sheet={sheet} on={src === k} label={SOURCES[k] ?? k} n={n} onClick={() => setSrc(src === k ? 'all' : k)} />)}
        </Section>
      )}
      {list.length > 0 && (
        <Section title={ui.tags}>
          <div className={cn('flex flex-wrap px-2 pb-2', sheet ? 'gap-2' : 'gap-1.5')}>
            {(open ? list : list.slice(0, TOP)).map(([t, n]) => <Tag key={t} t={t} n={n} on={active.has(t)} onClick={() => toggle(t)} className={sheet ? 'h-9' : ''} />)}
            {!sheet && !forced && list.length > TOP && (
              <Button variant="ghost" size="xs" aria-expanded={more} onClick={() => setMore(!more)} className="pointer-coarse:h-9">
                {more ? ui.collapse : f(ui.more_tags, { n: list.length - TOP })}
                <ChevronDown aria-hidden className={cn('motion-safe:transition-transform', more && 'rotate-180')} />
              </Button>
            )}
          </div>
        </Section>
      )}
    </>
  )
}

function ModeSwitch({ mode, setMode, className }: { mode: 'reels' | 'places'; setMode: (m: 'reels' | 'places') => void; className?: string }) {
  const { ui } = useLang()
  return (
    <div role="group" aria-label={ui.mode} className={cn('inline-flex gap-0.5 rounded-lg bg-secondary p-0.5', className)}>
      {(['reels', 'places'] as const).map((m) => (
        <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}
          className={cn('h-7 rounded-[8px] px-3 text-sm font-medium transition-[color,background-color] duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] pointer-coarse:h-10',
            mode === m ? 'bg-seg-on text-foreground shadow-[0_1px_2px_oklch(0_0_0/.08)]' : 'text-muted-foreground hover:text-foreground')}>
          {m === 'reels' ? ui.mode_reels : ui.mode_places}
        </button>
      ))}
    </div>
  )
}

function SortSelect({ sort, setSort, relevance, icon }: { sort: string; setSort: (s: string) => void; relevance: boolean; icon?: boolean }) {
  const { ui } = useLang()
  return (
    <Select value={sort} onValueChange={(v) => v && setSort(v)} disabled={relevance}>
      {icon
        ? <SelectTrigger aria-label={ui.sort} title={ui.sort} className="size-11 justify-center border-border bg-card p-0 hover:bg-muted [&>svg:last-child]:hidden"><ArrowDownUp aria-hidden /></SelectTrigger>
        : <SelectTrigger aria-label={ui.sort} className="h-10 border-0 bg-transparent hover:bg-muted data-popup-open:bg-muted"><ArrowDownUp aria-hidden className="text-muted-foreground" /><SelectValue>{relevance ? ui.sort_relevance : ui.sorts[sort]}</SelectValue></SelectTrigger>}
      <SelectContent align="end" className="w-max min-w-(--anchor-width)">{Object.keys(SORTS).map((k) => <SelectItem key={k} value={k}>{ui.sorts[k]}</SelectItem>)}</SelectContent>
    </Select>
  )
}

type Chip = { label: string; clear: () => void }

function Notice({ icon: Icon, title, children, actions, role }: { icon: typeof Inbox; title: string; children?: React.ReactNode; actions?: React.ReactNode; role?: 'status' }) {
  return (
    <div role={role} className="flex flex-col items-center gap-2 rounded-2xl border border-dashed px-4 py-12 text-center">
      <Icon aria-hidden className="size-6 text-muted-foreground" />
      <h2 className="text-base font-semibold text-balance">{title}</h2>
      {children}
      {actions && <div className="mt-2 flex flex-wrap justify-center gap-2">{actions}</div>}
    </div>
  )
}

function NothingFound({ q, chips, reset }: { q: string; chips: Chip[]; reset: () => void }) {
  const { ui } = useLang()
  return (
    <Notice role="status" icon={SearchX} title={q ? f(ui.nothing_q, { q }) : ui.nothing}
      actions={<>
        {chips.slice(0, 3).map((c) => <Button key={c.label} variant="outline" onClick={c.clear} className="pointer-coarse:h-11"><X aria-hidden />{f(ui.remove_filter, { f: c.label })}</Button>)}
        <Button variant="ghost" onClick={reset} className="pointer-coarse:h-11">{ui.reset_all}</Button>
      </>}>
      <p className="max-w-[44ch] text-sm text-pretty text-muted-foreground">{ui.nothing_hint}</p>
      {chips.length > 0 && <p className="max-w-[44ch] text-sm text-pretty text-muted-foreground">{f(ui.with_filters, { f: chips.map((c) => c.label).join(', ') })}</p>}
    </Notice>
  )
}

function EmptyState({ openSources, openAdd }: { openSources: () => void; openAdd: () => void }) {
  const { ui } = useLang()
  return (
    <Notice icon={Inbox} title={ui.empty_title}
      actions={<>
        <Button variant="outline" onClick={openSources} className="pointer-coarse:h-11"><Plug />{ui.connect_sources}</Button>
        <Button variant="outline" onClick={openAdd} className="pointer-coarse:h-11"><Plus />{ui.add_links}</Button>
      </>}>
      <p className="max-w-[44ch] text-sm text-pretty text-muted-foreground">{ui.empty_desc}</p>
    </Notice>
  )
}

function ErrorBlock({ retry }: { retry: () => void }) {
  const { ui } = useLang()
  return (
    <div role="alert" className="flex items-start gap-3 rounded-2xl border bg-card p-3 ps-4">
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{ui.load_failed_title}</p>
        <p className="text-sm text-muted-foreground">{ui.load_failed_desc}</p>
      </div>
      <Button variant="outline" onClick={retry} className="pointer-coarse:h-11">{ui.retry}</Button>
    </div>
  )
}

// Matched part of a menu item in semibold
function Hl({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q) : -1
  if (i < 0) return <span className="min-w-0 truncate">{text}</span>
  return <span className="min-w-0 truncate">{text.slice(0, i)}<span className="font-semibold">{text.slice(i, i + q.length)}</span>{text.slice(i + q.length)}</span>
}

type CmdApi = {
  open: boolean; setOpen: (o: boolean) => void; d: FacetData; active: Set<string>; toggle: (t: string) => void
  setCol: (c: string) => void; setSrc: (s: string) => void; running: boolean; sync: () => void
  addLinks: () => void; sources: () => void; setMode: (m: 'reels' | 'places') => void; setTheme: (t: Theme) => void; search: (q: string) => void
}

// ⌘K: keyboard twin of the sidebar. Filtering is ours (not cmdk's) so the groups keep the order from the spec.
function CommandMenu({ api }: { api: CmdApi }) {
  const { ui } = useLang()
  const [raw, setRaw] = useState('')
  const q = raw.trim().toLowerCase()
  const hit = (s: string) => !q || s.toLowerCase().includes(q)
  const run = (fn: () => void) => () => { api.setOpen(false); fn() }
  const tags = api.d.tags.filter(([t]) => hit(t)).slice(0, q ? 12 : 8)
  const cols = api.d.cols.filter(([c]) => hit(c))
  const srcs = api.d.srcs.filter(([k]) => hit(SOURCES[k] ?? k))
  const acts: { key: string; label: string; icon: React.ReactNode; fn: () => void; disabled?: boolean }[] = [
    { key: 'sync', label: ui.sync, icon: <RefreshCw />, fn: api.sync, disabled: api.running },
    { key: 'add', label: ui.add_links, icon: <Plus />, fn: api.addLinks },
    { key: 'src', label: ui.ob_open, icon: <Plug />, fn: api.sources },
    { key: 'reels', label: ui.mode_reels, icon: <Film />, fn: () => api.setMode('reels') },
    { key: 'places', label: ui.mode_places, icon: <MapPin />, fn: () => api.setMode('places') },
    ...(Object.keys(THEMES) as Theme[]).map((k) => { const I = THEMES[k]; return { key: 'theme' + k, label: `${ui.theme}: ${ui['theme_' + k]}`, icon: <I />, fn: () => api.setTheme(k) } }),
  ].filter((a) => hit(a.label))
  const empty = !q ? false : !tags.length && !cols.length && !srcs.length && !acts.length
  return (
    <Dialog open={api.open} onOpenChange={(o) => { api.setOpen(o); if (!o) setRaw('') }}>
      <DialogContent showCloseButton={false} className="top-1/3 max-w-[35rem] translate-y-0 gap-0 overflow-hidden p-2 sm:max-w-[35rem]">
        <DialogTitle className="sr-only">{ui.cmd_title}</DialogTitle>
        <Command shouldFilter={false} className="p-0">
          <div className="flex h-10 items-center gap-2 border-b px-2">
            <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <CommandPrimitive.Input value={raw} onValueChange={setRaw} placeholder={ui.cmd_ph} aria-label={ui.cmd_title}
              className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm" />
          </div>
          <CommandList className="max-h-80 py-1">
            {empty && <CommandEmpty>{ui.cmd_empty}</CommandEmpty>}
            {raw.trim() && (
              <CommandGroup>
                <CommandItem value="search" onSelect={run(() => api.search(raw.trim()))} className="data-selected:bg-accent">
                  <Search aria-hidden />{f(ui.cmd_search, { q: raw.trim() })}
                </CommandItem>
              </CommandGroup>
            )}
            {tags.length > 0 && (
              <CommandGroup heading={ui.tags}>
                {tags.map(([t, n]) => (
                  <CommandItem key={t} value={'tag ' + t} onSelect={run(() => api.toggle(t))} className="data-selected:bg-accent">
                    <span aria-hidden className="w-4 text-center text-muted-foreground">{api.active.has(t) ? <Check className="mx-auto size-4" /> : '#'}</span>
                    <Hl text={t} q={q} /><CommandShortcut className="tracking-normal tabular-nums">{n}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {cols.length > 0 && (
              <CommandGroup heading={ui.collections}>
                {cols.map(([c, n]) => (
                  <CommandItem key={c} value={'col ' + c} onSelect={run(() => api.setCol(c))} className="data-selected:bg-accent">
                    <Folder aria-hidden /><Hl text={c} q={q} /><CommandShortcut className="tracking-normal tabular-nums">{n}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {srcs.length > 0 && (
              <CommandGroup heading={ui.ob_open}>
                {srcs.map(([k, n]) => (
                  <CommandItem key={k} value={'src ' + k} onSelect={run(() => api.setSrc(k))} className="data-selected:bg-accent">
                    <Hl text={SOURCES[k] ?? k} q={q} /><CommandShortcut className="tracking-normal tabular-nums">{n}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {acts.length > 0 && (
              <CommandGroup heading={ui.cmd_actions}>
                {acts.map((a) => (
                  <CommandItem key={a.key} value={'act ' + a.key} disabled={a.disabled} onSelect={run(a.fn)} className="data-selected:bg-accent">
                    {a.icon}<Hl text={a.label} q={q} />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
          <p className="border-t px-2 pt-2 text-xs text-muted-foreground">{ui.cmd_hint}</p>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

type PlaceRow = { key: string; name: string; country: string; city: string; lat?: number; lng?: number; approx?: boolean; reels: Reel[] }
type Sel = { key: string; n: number; from: 'list' | 'map' }

const placeKey = (p: { name: string; city: string }) => `${p.name.toLowerCase()}|${p.city.toLowerCase()}`
const mapsUrl = (p: { name: string; city: string; country: string }) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([p.name, p.city, p.country].filter(Boolean).join(', '))}`
const thumbOf = (r: Reel) => (r.thumbs?.length ? r.thumbs[Math.floor(r.thumbs.length / 2)] : null)

// One row per place (exact name + city, case-insensitive), rows grouped by city; places without a city go last.
function groupPlaces(reels: Reel[]) {
  const rows = new Map<string, PlaceRow>()
  for (const r of reels) {
    for (const p of r.places ?? []) {
      const key = placeKey(p)
      const row = rows.get(key) ?? { key, name: p.name, city: p.city, country: p.country, reels: [] }
      if (p.lat !== undefined && p.lng !== undefined) { row.lat = p.lat; row.lng = p.lng; row.approx = p.approx }
      if (!row.reels.includes(r)) row.reels.push(r)
      rows.set(key, row)
    }
  }
  const byCity = new Map<string, PlaceRow[]>()
  for (const row of rows.values()) byCity.set(row.city, [...(byCity.get(row.city) ?? []), row])
  return [...byCity]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    .map(([city, list]) => ({ city, list: list.sort((a, b) => b.reels.length - a.reels.length || a.name.localeCompare(b.name)) }))
}

const WIDE = '(min-width: 1024px)' // lg: the map popup exists only here; on a phone the row and the marker carry the selection
const THUMB = 'relative block aspect-[9/16] overflow-hidden rounded-sm bg-muted'

// Popup is built with DOM nodes and textContent: place names come from an LLM and must not be parsed as HTML.
function popupOf(p: PlaceRow, ui: Lang['ui'], onOpenReel: (id: string, el: HTMLElement) => void, onMore: (key: string) => void) {
  const el = document.createElement('div')
  el.className = 'grid min-w-48 gap-0.5' // 192px: six 28px covers fit in one row
  const title = document.createElement('strong')
  title.className = 'text-sm font-semibold leading-snug'
  title.textContent = p.name
  el.append(title)
  const where = [p.city, p.country].filter(Boolean).join(', ')
  const line = (cls: string, text: string) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; el.append(d) }
  if (where) line('text-xs text-muted-foreground', where)
  if (p.approx) line('text-xs text-muted-foreground', ui.approx)
  const thumbs = document.createElement('div')
  thumbs.className = 'mt-2 mb-1.5 flex flex-wrap gap-1'
  const many = p.reels.length > 6
  for (const r of many ? p.reels.slice(0, 5) : p.reels) {
    const b = document.createElement('button')
    b.type = 'button'; b.title = r.title || r.id; b.setAttribute('aria-label', f(ui.open_details_by, { a: r.author }))
    b.className = `${THUMB} w-7 ${OUTLINE}`
    const t = thumbOf(r)
    if (t) { const i = document.createElement('img'); i.src = t; i.alt = ''; i.loading = 'lazy'; i.className = 'absolute inset-0 size-full object-cover'; b.append(i) }
    b.onclick = () => onOpenReel(r.id, b)
    thumbs.append(b)
  }
  if (many) {
    const b = document.createElement('button')
    const n = p.reels.length - 5
    b.type = 'button'; b.textContent = `+${n}`; b.setAttribute('aria-label', f(ui.more_reels, { n }))
    b.className = `${THUMB} w-7 flex items-center justify-center bg-muted text-xs text-muted-foreground tabular-nums`
    b.onclick = () => onMore(p.key)
    thumbs.append(b)
  }
  el.append(thumbs)
  const link = document.createElement('a')
  link.href = mapsUrl(p); link.target = '_blank'; link.rel = 'noreferrer'; link.className = 'text-sm font-medium text-accent-text'; link.textContent = ui.on_map; link.insertAdjacentHTML('beforeend', EXT_SVG)
  el.append(link)
  return el
}

// Leaflet scales the SVG marker layer during a zoom animation: after a flyTo it swells into a solid blue fill. Hide the layer while the map moves.
function animated(m: L.Map, id: { current: number }, move: (m: L.Map, animate: boolean) => void) {
  if (reducedMotion()) return move(m, false)
  const pane = m.getPane('overlayPane')!, mine = ++id.current
  pane.style.visibility = 'hidden'
  m.once('moveend', () => { if (id.current === mine) pane.style.visibility = '' }) // a newer move takes over the hiding
  move(m, true)
}

function PlacesMap({ rows, sel, onSelect, onOpenReel, onMore }: {
  rows: PlaceRow[]; sel: Sel | null; onSelect: (s: Sel | null) => void
  onOpenReel: (id: string, el: HTMLElement) => void; onMore: (key: string) => void
}) {
  const { ui } = useLang()
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const layer = useRef<L.LayerGroup | null>(null)
  const popup = useRef<L.Popup | null>(null)
  const lit = useRef<L.CircleMarker | null>(null)
  const markers = useRef(new Map<string, L.CircleMarker>())
  const flight = useRef(0) // id of the latest animated move
  const mute = useRef(false) // true while we open or close the popup ourselves: that popupclose must not clear the selection
  const cb = useRef({ ui, rows, onSelect, onOpenReel, onMore })
  useEffect(() => { cb.current = { ui, rows, onSelect, onOpenReel, onMore } })
  useEffect(() => {
    const m = L.map(el.current!).setView([20, 0], 2)
    L.tileLayer(TILES, {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(m)
    map.current = m; layer.current = L.layerGroup().addTo(m)
    popup.current = L.popup({ closeButton: true, maxWidth: 260, offset: [0, -14] })
    m.on('click', () => cb.current.onSelect(null))
    m.on('popupclose', () => { if (!mute.current) cb.current.onSelect(null) })
    // reduced motion: Leaflet's autoPan animates, so keep the popup in view with an instant pan instead
    m.on('popupopen', (e) => {
      const p = e.popup.getElement()
      if (reducedMotion() && p) m.panInside(e.popup.getLatLng()!, { animate: false, paddingTopLeft: [p.offsetWidth / 2 + 16, p.offsetHeight + 44], paddingBottomRight: [p.offsetWidth / 2 + 16, 16] })
    })
    return () => { m.remove(); map.current = null }
  }, [])
  useEffect(() => {
    layer.current?.clearLayers(); markers.current.clear(); lit.current = null
    const pts: L.LatLngTuple[] = []
    const geo = rows.filter((p) => p.lat !== undefined && p.lng !== undefined)
    const pick = (key: string) => () => cb.current.onSelect({ key, n: Date.now(), from: 'map' })
    // radius 8 alone is a 16px target (L.svg's `tolerance` does nothing for SVG, only for canvas): an invisible 40px circle under
    // every marker widens it. All of them go first, so a visible marker always sits above its neighbours' hit zones.
    for (const p of geo) L.circleMarker([p.lat!, p.lng!], { radius: 20, stroke: false, fillOpacity: 0, bubblingMouseEvents: false }).on('click', pick(p.key)).addTo(layer.current!)
    for (const p of geo) {
      const mk = L.circleMarker([p.lat!, p.lng!], { radius: 8, bubblingMouseEvents: false, className: p.approx ? 'map-marker map-marker--approx' : 'map-marker' })
        .on('click', pick(p.key)).addTo(layer.current!)
      markers.current.set(p.key, mk); pts.push([p.lat!, p.lng!])
    }
    if (pts.length && map.current) animated(map.current, flight, (m, animate) => m.fitBounds(pts, { padding: [40, 40], maxZoom: 14, animate }))
    else map.current?.setView([20, 0], 2, { animate: false })
  }, [rows])
  // selected marker: bigger, dark outline, on top
  useEffect(() => {
    const mk = sel ? markers.current.get(sel.key) : undefined
    if (lit.current && lit.current !== mk) { lit.current.setStyle({ radius: 8 }); lit.current.getElement()?.classList.remove('map-marker--sel') }
    lit.current = mk ?? null
    if (mk) { mk.setStyle({ radius: 11 }); mk.getElement()?.classList.add('map-marker--sel'); mk.bringToFront() }
  }, [sel, rows])
  // row -> marker: center the map
  useEffect(() => {
    const mk = sel?.from === 'list' ? markers.current.get(sel.key) : undefined
    const m = map.current
    if (!mk || !m) return
    const z = Math.max(m.getZoom(), 13)
    if (reducedMotion()) m.setView(mk.getLatLng(), z, { animate: false })
    else animated(m, flight, (m) => m.flyTo(mk.getLatLng(), z))
  }, [sel])
  // popup: only on a wide screen (a phone map is 220px tall); also follows the window crossing 1024px
  const [wide, setWide] = useState(() => matchMedia(WIDE).matches)
  useEffect(() => {
    const q = matchMedia(WIDE), on = () => setWide(q.matches)
    q.addEventListener('change', on)
    return () => q.removeEventListener('change', on)
  }, [])
  useEffect(() => {
    const m = map.current, pop = popup.current
    if (!m || !pop) return
    const mk = sel ? markers.current.get(sel.key) : undefined
    const row = sel ? cb.current.rows.find((r) => r.key === sel.key) : undefined
    mute.current = true
    if (!sel || !mk || !row || !wide) m.closePopup()
    else {
      const c = cb.current
      pop.options.autoPan = sel.from === 'map' && !reducedMotion() // after a flyTo the marker is centered, no pan needed
      pop.setContent(popupOf(row, c.ui, c.onOpenReel, c.onMore)).setLatLng(mk.getLatLng()).openOn(m)
    }
    mute.current = false
  }, [sel, wide, rows])
  useEffect(() => {
    if (!sel) return
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && popup.current?.isOpen() && !document.querySelector('[role="dialog"]')) cb.current.onSelect(null)
    }
    document.addEventListener('keydown', on)
    return () => document.removeEventListener('keydown', on)
  }, [sel])
  return (
    <div role="region" aria-label={ui.map_label}
      className="sticky top-0 z-10 h-[220px] [grid-area:map] overflow-hidden rounded-2xl border max-md:-mx-4 max-md:rounded-none max-md:border-x-0 lg:top-4 lg:z-0 lg:h-[calc(100dvh-2rem)] lg:min-h-[480px]">
      <div ref={el} className="z-0 size-full" />
    </div>
  )
}

const FEW = 4 // more videos than this: three covers and a "+N" button

function PlaceRowItem({ p, selected, all, onSelect, onMore, onOpenReel, setRef }: {
  p: PlaceRow; selected: boolean; all: boolean; onSelect: () => void; onMore: () => void
  onOpenReel: (id: string, el: HTMLElement) => void; setRef: (el: HTMLDivElement | null) => void
}) {
  const { ui, language } = useLang()
  const geo = p.lat !== undefined
  const thumbs = useRef<HTMLDivElement>(null)
  const refocus = useRef(false)
  const folded = !all && p.reels.length > FEW
  const list = folded ? p.reels.slice(0, 3) : p.reels
  // the "+N" button is gone after it is pressed: hand focus to the first cover it revealed
  useEffect(() => {
    if (refocus.current && !folded) { refocus.current = false; (thumbs.current?.children[3] as HTMLElement | undefined)?.focus() }
  }, [folded])
  const meta = [plural(ui.videos_n, p.reels.length, language), p.approx && ui.approx_short, !geo && ui.no_coords].filter(Boolean).join(' · ')
  const Pin = geo ? MapPin : MapPinOff
  const body = (
    <>
      <Pin aria-hidden className={cn('mt-0.5 size-4 shrink-0', selected ? 'text-accent-text' : 'text-muted-foreground')} />
      <span className="min-w-0">
        <span className="block font-medium leading-snug text-pretty wrap-anywhere">{p.name}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground tabular-nums">{meta}</span>
      </span>
    </>
  )
  const main = 'flex min-w-0 items-start gap-2 rounded-sm text-start'
  return (
    <div ref={setRef} data-selected={selected || undefined}
      className={cn('grid scroll-mt-[268px] grid-cols-[minmax(0,1fr)_auto] gap-x-1 gap-y-2 rounded-lg p-2 transition-[background-color,box-shadow] duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] lg:scroll-mt-12',
        geo && 'hover:bg-muted', 'data-[selected]:bg-muted data-[selected]:shadow-[inset_0_0_0_1px_var(--input)]')}>
      {geo
        ? <button type="button" aria-pressed={selected} onClick={onSelect} className={main}>{body}</button>
        : <div className={main}>{body}</div>}
      <a href={mapsUrl(p)} target="_blank" rel="noreferrer" aria-label={f(ui.on_map_of, { p: p.name })} title={ui.on_map}
        className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'text-muted-foreground hover:text-foreground pointer-coarse:size-11')}>
        <MapIcon aria-hidden />
      </a>
      <div ref={thumbs} className="col-span-2 flex flex-wrap gap-1 ps-6">
        {list.map((r) => {
          const th = thumbOf(r)
          return (
            <button key={r.id} type="button" aria-haspopup="dialog" onClick={(e) => onOpenReel(r.id, e.currentTarget)} title={r.title || r.id} aria-label={f(ui.open_details_by, { a: r.author })}
              className={cn(THUMB, 'w-6 pointer-coarse:w-9', OUTLINE)}>
              {th && <img src={th} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />}
            </button>
          )
        })}
        {folded && (
          <button type="button" aria-expanded={false} aria-label={f(ui.more_reels, { n: p.reels.length - 3 })} onClick={() => { refocus.current = true; onMore() }}
            className={cn(THUMB, 'flex w-6 items-center justify-center border bg-card text-xs text-muted-foreground tabular-nums pointer-coarse:w-9')}>
            +{p.reels.length - 3}
          </button>
        )}
      </div>
    </div>
  )
}

function PlacesView({ reels, total, sel, setSel, onOpenReel }: {
  reels: Reel[]; total: number; sel: Sel | null; setSel: (s: Sel | null) => void; onOpenReel: (id: string, el: HTMLElement) => void
}) {
  const { ui, language } = useLang()
  const uid = useId()
  const groups = useMemo(() => groupPlaces(reels), [reels])
  const rows = useMemo(() => groups.flatMap((g) => g.list), [groups])
  const [more, setMore] = useState<Set<string>>(new Set()) // places whose covers are all shown
  const els = useRef(new Map<string, HTMLElement>())
  const toRow = useCallback((key: string) => els.current.get(key)?.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }), [])
  useEffect(() => () => setSel(null), [setSel]) // leaving the view drops the selection
  useEffect(() => { if (sel && !rows.some((r) => r.key === sel.key)) setSel(null) }, [rows, sel, setSel]) // a filter removed it
  useEffect(() => { if (sel) toRow(sel.key) }, [sel, toRow])
  const showMore = useCallback((key: string) => { setMore((s) => new Set(s).add(key)); toRow(key) }, [toRow])
  if (!groups.length) return <p className="text-sm text-muted-foreground">{total ? ui.places_nothing : ui.places_empty}</p>
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 [grid-template-areas:'map'_'list'] lg:grid-cols-[340px_minmax(0,1fr)] lg:items-start lg:[grid-template-areas:'list_map'] xl:grid-cols-[380px_minmax(0,1fr)]">
      <div className="flex flex-col gap-6 [grid-area:list]">
        {groups.map(({ city, list }, i) => {
          const hid = `${uid}-${i}`
          const sub = [city && list[0].country, plural(ui.places_n, list.length, language)].filter(Boolean).join(' · ')
          return (
            <section key={city} aria-labelledby={hid}>
              <h2 id={hid} className="sticky top-[220px] z-[5] flex flex-wrap items-baseline gap-x-2 bg-background pt-1 pb-2 text-lg leading-snug font-semibold lg:top-0">
                {city || ui.no_city}<span className="text-sm font-normal text-muted-foreground tabular-nums">{sub}</span>
              </h2>
              <div className="flex flex-col gap-0.5 rounded-2xl border bg-card p-2">
                {list.map((p) => (
                  <PlaceRowItem key={p.key} p={p} selected={p.lat !== undefined && sel?.key === p.key} all={more.has(p.key)}
                    onSelect={() => setSel({ key: p.key, n: Date.now(), from: 'list' })} onMore={() => showMore(p.key)} onOpenReel={onOpenReel}
                    setRef={(el) => { if (el) els.current.set(p.key, el); else els.current.delete(p.key) }} />
                ))}
              </div>
            </section>
          )
        })}
      </div>
      <PlacesMap rows={rows} sel={sel} onSelect={setSel} onOpenReel={onOpenReel} onMore={showMore} />
    </div>
  )
}

// ---- Video details panel (details.md) ----

// "1. a 2. b" or one step per line; returns the steps without their numbers
// One line = one step. In a single line, numbering counts only as 1. 2. 3. ... in a row from the start: "heat to 180. Serve" and "2.5 kg" stay text.
const splitSteps = (s: string) => {
  const t = s.trim()
  if (t.includes('\n')) return t.split('\n').map((x) => x.replace(/^\s*\d+[.)]\s+/, '').trim()).filter(Boolean)
  const ms = [...t.matchAll(/(?:^|\s)(\d+)[.)]\s/g)]
  if (ms.length < 2 || ms[0].index !== 0 || !ms.every((m, i) => +m[1] === i + 1)) return [t]
  return ms.map((m, i) => t.slice(m.index + m[0].length, ms[i + 1]?.index).trim()).filter(Boolean)
}

// Query words of 3+ letters; words of 5+ lose their last 2 letters (crude stem); matches a word start, highlights the whole word.
// ponytail: 2-символьная основа, без морфологии; заменить, если будут жалобы на пропуски
const matchRe = (q: string) => {
  const stems = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3).map((w) => (w.length >= 5 ? w.slice(0, -2) : w))
  return stems.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${stems.join('|')})[\\p{L}\\p{N}]*`, 'giu') : null
}
const countMatches = (t: string, re: RegExp | null) => (re ? [...t.matchAll(re)].length : 0)

// React nodes, never innerHTML: the texts come from an LLM, OCR and strangers
function Highlight({ text, re }: { text: string; re: RegExp | null }) {
  if (!re) return <>{text}</>
  const out: React.ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(<mark key={m.index} className="rounded-[3px] bg-mark px-0.5 font-semibold text-inherit">{m[0]}</mark>)
    last = m.index + m[0].length
  }
  out.push(text.slice(last))
  return <>{out}</>
}

// ~40 characters before and ~80 after the first match, cut at word edges; no match: the start of the text (the clamp does the rest)
function Snippet({ text, re }: { text: string; re: RegExp | null }) {
  const t = text.replace(/\s+/g, ' ').trim()
  const x = re ? new RegExp(re.source, re.flags.replace('g', '')).exec(t) : null
  if (!x) return <>{t.slice(0, 200)}</>
  const end = x.index + x[0].length
  let a = Math.max(0, x.index - 40), b = Math.min(t.length, end + 80)
  if (a > 0) { const s = t.indexOf(' ', a); if (s >= 0 && s < x.index) a = s + 1 }
  if (b < t.length) { const s = t.lastIndexOf(' ', b); if (s > end) b = s }
  return <>{a > 0 && '…'}<Highlight text={t.slice(a, b)} re={re} />{b < t.length && '…'}</>
}

const TAP = 'max-sm:size-11 pointer-coarse:size-11'
const OUTLINE = 'after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:shadow-[inset_0_0_0_1px_oklch(0_0_0/.1)] dark:after:shadow-[inset_0_0_0_1px_oklch(1_0_0/.1)]'

function Block({ title, extra, children }: { title: string; extra?: React.ReactNode; children: React.ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="grid gap-3">
      <h3 id={id} className="text-lg font-semibold">{title}{extra}</h3>
      {children}
    </section>
  )
}

function StepList({ text }: { text: string }) {
  const items = splitSteps(text)
  if (items.length < 2) return <p className="max-w-[68ch] text-base text-pretty">{text}</p>
  return (
    <ol className="grid max-w-[68ch] gap-3">
      {items.map((s, i) => (
        <li key={i} className="grid grid-cols-[24px_minmax(0,1fr)] gap-3">
          <span aria-hidden className="grid size-6 place-items-center rounded-full bg-muted text-xs font-semibold tabular-nums">{i + 1}</span>
          <span className="text-base text-pretty">{s}</span>
        </li>
      ))}
    </ol>
  )
}

function RecipeView({ x, named }: { x: NonNullable<Reel['recipes']>[number]; named: boolean }) {
  const { ui } = useLang()
  return (
    <div className="grid gap-3">
      {named && x.name && <h4 className="text-base font-semibold">{x.name}</h4>}
      {!!x.ingredients?.length && (
        <div className="grid max-w-[68ch] gap-1">
          <div className="text-sm font-medium text-muted-foreground">{ui.d_ingredients}</div>
          <ul>{x.ingredients.map((s, i) => <li key={i} className="border-b py-1.5 text-base last:border-0">{s}</li>)}</ul>
        </div>
      )}
      {!!x.steps?.trim() && (
        <div className="grid gap-2">
          <div className="text-sm font-medium text-muted-foreground">{ui.d_steps}</div>
          <StepList text={x.steps} />
        </div>
      )}
    </div>
  )
}

function PlaceItem({ p, onPlace }: { p: NonNullable<Reel['places']>[number]; onPlace: (key: string) => void }) {
  const { ui } = useLang()
  const where = [p.city, p.country].filter(Boolean).join(', ')
  return (
    <li className="flex items-center gap-3 rounded-2xl border bg-card py-2 ps-3 pe-2">
      <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><MapPin className="size-4" /></span>
      <div className="min-w-0 flex-1">
        <div className="text-base font-medium break-words">{p.name}</div>
        {where && <div className="text-sm break-words text-muted-foreground">{where}</div>}
        {p.approx && <div className="text-xs text-muted-foreground">{ui.approx}</div>}
      </div>
      {p.lat !== undefined && p.lng !== undefined && (
        <Button variant="ghost" size="icon" aria-label={ui.d_on_map} title={ui.d_on_map} className={TAP} onClick={() => onPlace(placeKey(p))}><MapIcon aria-hidden /></Button>
      )}
      <a href={mapsUrl(p)} target="_blank" rel="noreferrer" aria-label={ui.on_map} title={ui.on_map} className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), TAP)}><ArrowUpRight aria-hidden /></a>
    </li>
  )
}

// One of transcript / on-screen text / caption: a native <details>, closed by default; the preview shows where the search matched.
function TextItem({ title, text, re, q, ocr }: { title: string; text: string; re: RegExp | null; q: string; ocr?: boolean }) {
  const { ui } = useLang()
  const n = countMatches(text, re)
  const [copy, setCopy] = useState<'idle' | 'ok' | 'fail'>('idle')
  useEffect(() => {
    if (copy === 'idle') return
    const t = setTimeout(() => setCopy('idle'), 2000)
    return () => clearTimeout(t)
  }, [copy])
  const doCopy = () => {
    if (!navigator.clipboard) return setCopy('fail')
    navigator.clipboard.writeText(text).then(() => setCopy('ok'), () => setCopy('fail'))
  }
  return (
    <details className="group/d">
      <summary className="group/s grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 rounded-2xl p-4 focus-visible:outline-offset-[-2px] [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-base font-medium group-hover/s:underline">{title}</span>
          {n > 0 && <span aria-label={f(ui.d_matches_label, { q, n })} className="rounded-full bg-mark px-2 text-xs font-medium tabular-nums">{f(ui.d_matches, { n })}</span>}
        </span>
        <ChevronDown aria-hidden className="mt-0.5 size-4 text-muted-foreground motion-safe:transition-transform motion-safe:duration-150 group-open/d:rotate-180" />
        <span className="col-span-full line-clamp-2 text-sm text-muted-foreground group-open/d:hidden"><Snippet text={text} re={re} /></span>
      </summary>
      <div className="grid gap-3 px-4 pb-4">
        <p className={cn('max-w-[68ch] break-words whitespace-pre-line', ocr ? 'rounded-lg bg-muted p-3 text-sm leading-[1.6]' : 'text-base text-pretty')}><Highlight text={ocr ? text.replace(/ \| /g, '\n') : text} re={re} /></p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={doCopy} className="max-sm:h-11 pointer-coarse:h-11">
            {copy === 'ok' ? <Check aria-hidden /> : <Copy aria-hidden />}{copy === 'ok' ? ui.d_copied : ui.d_copy}
          </Button>
          <span role="status" className={cn('text-sm', copy === 'fail' ? 'text-destructive' : 'sr-only')}>{copy === 'fail' ? ui.d_copy_failed : copy === 'ok' ? ui.d_copied : ''}</span>
        </div>
      </div>
    </details>
  )
}

function PanelBody({ r, q, active, onTag, onPlace, titleRef }: {
  r: Reel; q: string; active: Set<string>; onTag: (t: string) => void; onPlace: (key: string) => void; titleRef: React.RefObject<HTMLHeadingElement | null>
}) {
  const { ui, kind_order, hidden_kinds, language } = useLang()
  const re = useMemo(() => matchRe(q), [q])
  const th = thumbOf(r)
  const title = r.title || (r.summary ? cut(r.summary) : ui.d_untitled)
  const tags = [...new Set([...r.tags, ...r.specific_tags])]
  const date = fmtDate(r.upload_date)
  // chip + date · duration · likes stay in one nowrap group, the (long) author link gets its own line: no dot hangs at a line end
  const meta = [
    date && <span key="date" className="tabular-nums">{date}</span>,
    r.duration ? <span key="dur" className="tabular-nums">{fmtTime(Math.round(r.duration))}</span> : null,
    r.likes ? <span key="likes" aria-label={f(ui.d_likes, { n: r.likes })} className="inline-flex items-center gap-1 tabular-nums"><Heart aria-hidden className="size-3" />{new Intl.NumberFormat(language, { notation: 'compact' }).format(r.likes)}</span> : null,
  ].filter(Boolean)
  const recipes = (r.recipes ?? []).filter((x) => x.ingredients?.length || x.steps?.trim())
  const kinds = kind_order.map((k, i) => {
    if (hidden_kinds.includes(k)) return null
    const texts = (r.key ?? []).filter((x) => x.kind === k && x.text.trim()).map((x) => x.text)
    let body: React.ReactNode
    if (i === 1 && recipes.length) body = recipes.map((x, j) => <RecipeView key={j} x={x} named={recipes.length > 1} />)
    else if (i === 3 && r.places?.length) body = <ul className="grid gap-2">{r.places.map((p, j) => <PlaceItem key={j} p={p} onPlace={onPlace} />)}</ul>
    else if (!texts.length) return null
    else if (i === 2) body = texts.map((t, j) => <StepList key={j} text={t} />)
    else body = texts.map((t, j) => <p key={j} className="max-w-[68ch] text-base text-pretty">{t}</p>)
    return <Block key={k} title={i === 3 && (r.places?.length ?? 0) > 1 ? ui.d_places : ui.d_kinds[i] ?? k}>{body}</Block>
  })
  // kinds the model invented ("пример", "список"): after the known ones, in order of appearance, as a paragraph like "Вывод"
  const extra = [...new Set((r.key ?? []).map((x) => x.kind))].filter((k) => !kind_order.includes(k) && !hidden_kinds.includes(k)).map((k) => {
    const ts = (r.key ?? []).filter((x) => x.kind === k && x.text.trim()).map((x) => x.text)
    return ts.length ? <Block key={k} title={k.charAt(0).toUpperCase() + k.slice(1)}>{ts.map((t, j) => <p key={j} className="max-w-[68ch] text-base text-pretty">{t}</p>)}</Block> : null
  })
  const frames = r.thumbs ?? []
  const texts = ([[ui.d_transcript, r.transcript, false], [ui.d_ocr, r.ocr ?? '', true], [ui.d_caption, r.caption, false]] as const).filter(([, t]) => t.trim())
  return (
    <div className="grid gap-8 p-4 sm:p-6">
      <div className="grid grid-cols-[80px_minmax(0,1fr)] items-start gap-4 sm:grid-cols-[96px_minmax(0,1fr)]">
        <a href={r.url} target="_blank" rel="noreferrer" aria-label={f(ui.open_reel_by, { a: r.author })}
          className={cn('relative block aspect-[9/16] overflow-hidden rounded-lg bg-muted', OUTLINE)}>
          {th ? <img src={th} alt="" className="absolute inset-0 size-full object-cover" /> : <Film aria-hidden className="absolute inset-0 m-auto size-6 text-muted-foreground" />}
          {th && <span aria-hidden className="absolute inset-0 m-auto grid size-9 place-items-center rounded-full bg-on-media text-on-media-fg"><Play className="ms-0.5 size-4 fill-current" /></span>}
        </a>
        <div className="grid min-w-0 gap-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="rounded-sm bg-secondary px-1.5 py-0.5 font-medium text-foreground">{SOURCES[r.source] ?? r.source}</span>
            <span className="flex items-center gap-x-2 whitespace-nowrap">
              {meta.map((node, i) => <Fragment key={i}>{i > 0 && <span aria-hidden>·</span>}{node}</Fragment>)}
            </span>
            <span className="basis-full font-medium break-words text-foreground">@{r.author}</span>
          </div>
          <h2 id="reel-title" ref={titleRef} tabIndex={-1} className="text-2xl leading-[1.2] font-semibold tracking-[-0.01em] break-words text-balance outline-none">{title}</h2>
          {tags.length > 0 && <div className="flex flex-wrap gap-1.5">{tags.map((t) => <Tag key={t} t={t} on={active.has(t)} onClick={() => onTag(t)} />)}</div>}
        </div>
      </div>
      {r.summary && <p className="max-w-[68ch] text-base text-pretty">{r.summary}</p>}
      {kinds}
      {extra}
      {frames.length > 1 && (
        <Block title={ui.d_frames} extra={<span className="ms-2 text-base font-normal tabular-nums text-muted-foreground">{frames.length}</span>}>
          <div className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:px-6">
            {frames.map((src, i) => (
              <a key={src} href={src} target="_blank" rel="noreferrer" aria-label={f(ui.d_frame, { n: i + 1, m: frames.length })}
                className={cn('relative block aspect-[9/16] w-22 shrink-0 snap-start overflow-hidden rounded-sm bg-muted sm:w-[104px]', OUTLINE)}>
                <img src={src} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />
              </a>
            ))}
          </div>
        </Block>
      )}
      {texts.length > 0 && (
        <Block title={ui.d_texts}>
          <p className="-mt-1 text-sm text-muted-foreground">{ui.d_texts_hint}</p>
          <div className="rounded-2xl border bg-card [&>details+details]:border-t">
            {texts.map(([title, text, ocr]) => <TextItem key={title} title={title} text={text} re={re} q={q} ocr={ocr} />)}
          </div>
        </Block>
      )}
    </div>
  )
}

type PanelProps = {
  open: boolean; r: Reel | null; pos: { i: number; n: number }; q: string; active: Set<string>
  onNav: (d: 1 | -1) => void; onClose: () => void; onTag: (t: string) => void; onPlace: (key: string) => void
  finalFocus: () => HTMLElement | false
}

function ReelPanel({ open, r, pos, q, active, onNav, onClose, onTag, onPlace, finalFocus }: PanelProps) {
  const { ui } = useLang()
  const title = useRef<HTMLHeadingElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const id = r?.id
  const prev = useRef(id)
  // another video in the same panel: back to the top, the screen reader reads the new title
  useEffect(() => {
    if (prev.current === id) return
    prev.current = id
    if (popup.current) popup.current.scrollTop = 0
    title.current?.focus({ preventScroll: true })
  }, [id])
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest('input, textarea, [contenteditable]')) return
    if (e.code === 'KeyJ') onNav(1)
    else if (e.code === 'KeyK') onNav(-1)
  }
  return (
    <Dialog open={open && !!r} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogPanel ref={popup} aria-labelledby="reel-title" initialFocus={title} finalFocus={finalFocus} onKeyDown={onKeyDown}>
        {r && <>
          <div className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b bg-card px-1 sm:px-3">
            <Button variant="ghost" size="icon" aria-label={ui.d_prev} title={ui.d_prev} aria-keyshortcuts="K" disabled={pos.i <= 0} onClick={() => onNav(-1)} className={TAP}><ChevronUp aria-hidden /></Button>
            <Button variant="ghost" size="icon" aria-label={ui.d_next} title={ui.d_next} aria-keyshortcuts="J" disabled={pos.i < 0 || pos.i >= pos.n - 1} onClick={() => onNav(1)} className={TAP}><ChevronDown aria-hidden /></Button>
            {pos.i >= 0 && <span className="ms-1 hidden text-xs tabular-nums text-muted-foreground sm:inline">{f(ui.d_pos, { n: pos.i + 1, m: pos.n })}</span>}
            <span className="flex-1" />
            <a href={r.url} target="_blank" rel="noreferrer" aria-label={f(ui.d_watch_on, { s: SOURCES[r.source] ?? r.source })}
              className={cn(buttonVariants(), 'max-sm:h-11 pointer-coarse:h-11')}>{ui.d_watch}<Ext /></a>
            <DialogClose render={<Button variant="ghost" size="icon" aria-label={ui.close} title={ui.close} className={TAP} />}><X aria-hidden /></DialogClose>
          </div>
          <PanelBody key={r.id} r={r} q={q} active={active} onTag={onTag} onPlace={onPlace} titleRef={title} />
        </>}
      </DialogPanel>
    </Dialog>
  )
}

const hashId = () => {
  const m = location.hash.match(/^#\/r\/(.+)$/)
  try { return m ? decodeURIComponent(m[1]) : null } catch { return null } // a broken %-sequence in the link: no panel
}

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform)

function Main() {
  const { ui, language } = useLang()
  const { reels, load, state } = useReels()
  const [theme, setTheme] = useTheme()
  const [mode, setMode] = useState<'reels' | 'places'>('reels')
  const [q, setQ] = useState('')
  // Search: the list follows the last *answered* query, not the text in the field, so it does not flash "nothing found" while typing.
  const ql = q.trim()
  const [res, setRes] = useState<{ q: string; sem: Map<string, number> | null }>({ q: '', sem: null })
  useEffect(() => {
    if (!ql) return
    const ac = new AbortController()
    const t = setTimeout(() => fetch('api/search?q=' + encodeURIComponent(ql), { signal: ac.signal })
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json() })
      .then((l: [string, number][]) => {
        const top = l[0]?.[1] ?? 0
        setRes({ q: ql, sem: new Map(l.filter(([, s]) => s >= Math.max(0.3, top - 0.15))) })
      })
      .catch(() => { if (!ac.signal.aborted) setRes({ q: ql, sem: null }) }), 300) // semantic search failed: match words instead
    return () => { ac.abort(); clearTimeout(t) }
  }, [ql])
  const searching = ql !== '' && res.q !== ql
  const semError = ql !== '' && res.q === ql && res.sem === null
  const live = useMemo(() => (ql ? res : { q: '', sem: null }), [ql, res])
  const [sort, setSort] = useState('saved')
  const [active, setActive] = useState<Set<string>>(new Set())
  const [src, setSrc] = useState('all')
  const [col, setCol] = useState('all') // 'all' | 'none' | collection name
  const toggle = useCallback((t: string) => setActive((s) => { const n = new Set(s); if (!n.delete(t)) n.add(t); return n }), [])

  const d = useMemo<FacetData>(() => {
    const tags = new Map<string, number>(), cols = new Map<string, number>(), srcs = new Map<string, number>()
    let none = 0
    for (const r of reels) {
      new Set(r.tags).forEach((t) => tags.set(t, (tags.get(t) ?? 0) + 1))
      new Set(r.collections).forEach((c) => cols.set(c, (cols.get(c) ?? 0) + 1))
      if (!r.collections.length) none++
      srcs.set(r.source, (srcs.get(r.source) ?? 0) + 1)
    }
    return {
      tags: [...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      cols: [...cols].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      srcs: [...srcs].sort((a, b) => a[0].localeCompare(b[0])),
      none, total: reels.length,
    }
  }, [reels])

  const shown = useMemo(() => {
    const ql = live.q.toLowerCase(), sem = live.sem
    const hit = (r: Reel) => [r.title, r.author, r.caption, r.transcript, r.ocr].join(' ').toLowerCase().includes(ql)
    const list = reels
      .filter((r) => src === 'all' || r.source === src)
      .filter((r) => col === 'all' || (col === 'none' ? !r.collections.length : r.collections.includes(col)))
      .filter((r) => { const s = new Set([...r.tags, ...r.specific_tags]); return [...active].every((t) => s.has(t)) })
      .filter((r) => !ql || (sem ? sem.has(r.id) : hit(r)))
    return ql && sem ? list.sort((a, b) => (sem.get(b.id) ?? 0) - (sem.get(a.id) ?? 0)) : list.sort(SORTS[sort])
  }, [reels, live, active, sort, src, col])

  const filtered = active.size > 0 || src !== 'all' || col !== 'all'
  const nFilters = active.size + (src !== 'all' ? 1 : 0) + (col !== 'all' ? 1 : 0)
  const resetFilters = () => { setActive(new Set()); setSrc('all'); setCol('all') }
  const resetAll = () => { resetFilters(); setQ('') }
  const chips: Chip[] = [
    ...[...active].map((t) => ({ label: '#' + t, clear: () => toggle(t) })),
    ...(col !== 'all' ? [{ label: col === 'none' ? ui.no_collection : col, clear: () => setCol('all') }] : []),
    ...(src !== 'all' ? [{ label: SOURCES[src] ?? src, clear: () => setSrc('all') }] : []),
  ]
  const relevance = ql !== '' && !semError

  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [cmdOpen, setCmdOpen] = useState(false)
  const sheetTitle = useRef<HTMLHeadingElement>(null)
  const cardRefs = useRef(new Map<string, HTMLElement>())
  const setRef = useCallback((id: string, el: HTMLElement | null) => {
    if (el) cardRefs.current.set(id, el)
    else cardRefs.current.delete(id)
  }, [])

  // Details panel: the open video lives in the URL hash (#/r/<id>), so Back closes it and a reload keeps it.
  const [openRaw, setOpenId] = useState<string | null>(hashId)
  // unknown id in the link, or the video is gone after a sync: no panel
  const openId = openRaw && (state !== 'ok' || reels.some((r) => r.id === openRaw)) ? openRaw : null
  const [lastId, setLastId] = useState(openRaw) // the panel keeps showing this video while it slides out
  const lastRef = useRef(openRaw)
  const pushed = useRef(false) // true: opening added a history entry, so closing goes back
  const closeTo = useRef<'card' | 'main'>('card')
  const opener = useRef<{ id: string; el: HTMLElement } | null>(null)
  const [mapSel, setMapSel] = useState<Sel | null>(null)
  const show = useCallback((id: string | null) => {
    setOpenId(id)
    if (id) { setLastId(id); lastRef.current = id }
  }, [])
  const openReel = useCallback((id: string, el?: HTMLElement) => {
    pushed.current = true; closeTo.current = 'card'; opener.current = el ? { id, el } : null
    location.hash = '#/r/' + encodeURIComponent(id)
    show(id)
  }, [show])
  const closePanel = useCallback(() => {
    if (pushed.current) { pushed.current = false; history.back() }
    else { history.replaceState(null, '', location.pathname + location.search); show(null) }
  }, [show])
  useEffect(() => {
    const on = () => { const id = hashId(); if (!id) pushed.current = false; show(id) }
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [show])
  useEffect(() => {
    if (!openRaw || openId) return
    pushed.current = false
    history.replaceState(null, '', location.pathname + location.search)
  }, [openRaw, openId])

  const panelReel = useMemo(() => reels.find((r) => r.id === lastId) ?? null, [reels, lastId])
  const panelPos = { i: shown.findIndex((r) => r.id === lastId), n: shown.length }
  const panelOpen = openId !== null && state === 'ok' && panelReel !== null

  // J/K and the header arrows: replaceState, so one "Back" closes the panel instead of walking through every video
  const nav = (d: 1 | -1) => {
    const i = shown.findIndex((r) => r.id === openId)
    const next = shown[i + d]
    if (i < 0 || !next) return
    history.replaceState(null, '', '#/r/' + encodeURIComponent(next.id))
    show(next.id)
  }
  const panelTag = (t: string) => { setActive((s) => new Set(s).add(t)); closeTo.current = 'main'; closePanel() }
  const panelPlace = (key: string) => { setMode('places'); setMapSel({ key, n: Date.now(), from: 'list' }); closeTo.current = 'main'; closePanel() }
  // back to the card of the video that is current now (not the one that opened the panel), scrolled into view.
  // #main is focusable but not tabbable: base-ui would swap it for the search field (and raise the phone keyboard), so focus it ourselves.
  const finalFocus = useCallback(() => {
    const main = document.getElementById('main')
    const cur = lastRef.current
    const o = opener.current
    const el = closeTo.current === 'main' || !cur ? null : cardRefs.current.get(cur) ?? (o && o.id === cur && o.el.isConnected ? o.el : null)
    if (el) { el.scrollIntoView({ block: 'nearest' }); return el }
    setTimeout(() => main?.focus({ preventScroll: true }), 0)
    return false
  }, [])

  const sync = useSync(load, () => new Set(reels.map((r) => r.id)))
  const showNew = () => {
    setMode('reels'); setSort('saved'); resetAll()
    window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'k' || e.altKey || e.shiftKey) return
      if (e.target instanceof HTMLTextAreaElement || matchMedia('(max-width: 767px)').matches) return
      e.preventDefault()
      if (!sourcesOpen && !sheetOpen && openId === null) setCmdOpen((o) => !o)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sourcesOpen, sheetOpen, openId])

  const hasReels = reels.length > 0
  const loading = state === 'loading'
  const controls = hasReels || loading
  const strip = sync.kind !== null
  const placesTotal = useMemo(() => reels.reduce((n, r) => n + (r.places?.length ?? 0), 0), [reels])
  const placesShown = useMemo(() => (mode === 'places' ? groupPlaces(shown).reduce((n, g) => n + g.list.length, 0) : 0), [mode, shown])
  const countText = !(hasReels || state === 'ok') ? '' : mode === 'places' ? plural(ui.places_n, placesShown, language) : filtered || live.q ? f(ui.shown_of, { n: shown.length, m: reels.length }) : String(reels.length)
  const facets = { d, col, setCol, src, setSrc, active, toggle }

  return (
    <div className="mx-auto max-w-[86rem] px-4 py-3 md:px-6 md:py-6 min-[1200px]:px-8">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-10 focus:rounded-lg focus:bg-card focus:px-3 focus:py-2">{ui.skip}</a>
      <header className={cn('flex flex-wrap items-center gap-x-4 gap-y-2', strip ? 'mb-3 md:mb-4' : 'mb-3 md:mb-6')}>
        <div className="flex items-baseline">
          <h1 className="text-xl font-semibold">{ui.title}</h1>
          <span role="status" className="ms-1.5 text-sm font-normal tabular-nums text-muted-foreground">{countText}</span>
        </div>
        <ModeSwitch mode={mode} setMode={setMode} className="max-md:hidden" />
        <div className="ms-auto flex items-center gap-2">
          <ThemeSelect theme={theme} setTheme={setTheme} />
          <Onboarding open={sourcesOpen} setOpen={setSourcesOpen} />
          <AddLinks open={addOpen} setOpen={setAddOpen} running={sync.running} start={sync.start} />
          <Button disabled={sync.running} onClick={() => sync.start([])} className="max-md:size-11 max-md:px-0 pointer-coarse:h-11">
            <RefreshCw aria-hidden className={sync.running ? 'motion-safe:animate-spin' : ''} /><span className="max-md:sr-only">{ui.sync}</span>
          </Button>
        </div>
      </header>

      {strip && <div className="mb-3 md:mb-4"><SyncStrip sync={sync} onShowNew={showNew} /></div>}

      <div className="flex items-start gap-6">
        {controls && (
          <aside aria-label={ui.filters} className="sticky top-6 hidden max-h-[calc(100dvh-3rem)] w-62 shrink-0 flex-col gap-4 overflow-y-auto overscroll-contain rounded-2xl border bg-card p-2 md:flex">
            {hasReels ? <>
              {filtered && (
                <div className="flex items-center justify-between ps-2">
                  <span className="text-xs font-medium text-muted-foreground">{ui.filters}</span>
                  <Button variant="ghost" size="xs" onClick={resetFilters} className="pointer-coarse:h-9">{ui.reset}</Button>
                </div>
              )}
              <Facets {...facets} />
            </> : (
              <div aria-hidden className="flex flex-col gap-1">
                {Array.from({ length: 6 }, (_, i) => <div key={i} className="h-8 rounded-lg bg-muted" />)}
              </div>
            )}
          </aside>
        )}

        <main id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col gap-4 outline-none">
          {controls && (
            <div className="flex gap-2">
              <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg border border-input bg-card ps-3 pe-1.5 pointer-coarse:h-11 has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-ring">
                <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <Input aria-label={ui.search} className="h-full min-w-0 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:outline-none" placeholder={ui.search_ph} value={q} onChange={(e) => setQ(e.target.value)} />
                <span role="status" className="flex items-center gap-1.5 pe-1.5 text-xs whitespace-nowrap text-muted-foreground empty:hidden">
                  {searching && <><LoaderCircle aria-hidden className="size-3.5 motion-safe:animate-spin" />{ui.searching}</>}
                </span>
                {!searching && <kbd aria-hidden className="inline-flex h-[22px] items-center rounded-sm border px-1.5 font-sans text-xs text-muted-foreground max-md:hidden pointer-coarse:hidden">{isMac() ? '⌘K' : 'Ctrl K'}</kbd>}
              </div>
              {mode === 'reels' && hasReels && <div className="max-md:hidden"><SortSelect sort={sort} setSort={setSort} relevance={relevance} /></div>}
            </div>
          )}
          {semError && <p role="status" className="-mt-2 text-xs text-muted-foreground">{ui.sem_failed}</p>}

          <div className="flex flex-wrap items-center gap-2 md:hidden">
            <ModeSwitch mode={mode} setMode={setMode} />
            {hasReels && (
              <div className="ms-auto flex items-center gap-2">
                <Button variant="outline" className="h-11" onClick={() => setSheetOpen(true)} aria-label={nFilters ? f(ui.filters_label, { n: nFilters }) : undefined}>
                  <SlidersHorizontal aria-hidden />{nFilters ? f(ui.filters_n, { n: nFilters }) : ui.filters}
                </Button>
                {mode === 'reels' && <SortSelect icon sort={sort} setSort={setSort} relevance={relevance} />}
              </div>
            )}
          </div>
          {hasReels && d.tags.some(([t, n]) => n >= MIN_TAG || active.has(t)) && (
            <div role="group" aria-label={ui.tags} className="-mx-4 flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] md:hidden">
              {[...d.tags.filter(([t, n]) => n >= MIN_TAG || active.has(t))].sort((a, b) => +active.has(b[0]) - +active.has(a[0]))
                .map(([t, n]) => <Tag key={t} t={t} n={n} on={active.has(t)} onClick={() => toggle(t)} className="shrink-0" />)}
            </div>
          )}

          {state === 'error' && <ErrorBlock retry={load} />}
          {loading && (
            <div role="status" aria-label={ui.loading} className="grid grid-cols-1 items-start gap-3 min-[1200px]:grid-cols-2">
              {Array.from({ length: 4 }, (_, i) => <CardSkeleton key={i} />)}
            </div>
          )}
          {state === 'ok' && !hasReels && <EmptyState openSources={() => setSourcesOpen(true)} openAdd={() => setAddOpen(true)} />}
          {hasReels && !searching && shown.length === 0 && <NothingFound q={live.q} chips={chips} reset={resetAll} />}
          {hasReels && shown.length > 0 && (mode === 'places'
            ? <PlacesView reels={shown} total={placesTotal} sel={mapSel} setSel={setMapSel} onOpenReel={openReel} />
            : <div className="grid grid-cols-1 items-start gap-3 min-[1200px]:grid-cols-2">
                {shown.map((r) => <ReelCard key={r.id} r={r} toggle={toggle} active={active} current={r.id === openId} onOpen={openReel} setRef={setRef} />)}
              </div>)}
        </main>
      </div>

      <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
        <DialogContent showCloseButton={false} initialFocus={sheetTitle}
          className="top-auto bottom-0 left-0 max-h-[85dvh] max-w-none translate-x-0 translate-y-0 gap-4 overflow-y-auto overscroll-contain rounded-t-2xl rounded-b-none p-2 pb-0 ease-[cubic-bezier(0.2,0,0,1)] motion-safe:data-open:zoom-in-100 motion-safe:data-open:slide-in-from-bottom motion-safe:data-closed:zoom-out-100 motion-safe:data-closed:slide-out-to-bottom sm:max-w-none">
          <DialogTitle ref={sheetTitle} tabIndex={-1} className="py-2 text-center text-base leading-normal font-semibold outline-none">{ui.filters}</DialogTitle>
          <Facets {...facets} sheet />
          <div className="sticky bottom-0 flex gap-2 bg-popover pt-2 pb-[max(8px,env(safe-area-inset-bottom))]">
            <Button variant="ghost" className="h-11" disabled={!filtered} onClick={resetFilters}>{ui.reset}</Button>
            <Button className="h-11 flex-1 bg-foreground text-background hover:bg-foreground/85" onClick={() => setSheetOpen(false)}>{f(ui.show_n, { n: shown.length })}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <ReelPanel open={panelOpen} r={panelReel} pos={panelPos} q={live.q} active={active} onNav={nav} onClose={closePanel} onTag={panelTag} onPlace={panelPlace} finalFocus={finalFocus} />

      <CommandMenu api={{
        open: cmdOpen, setOpen: setCmdOpen, d, active, toggle, setCol, setSrc, running: sync.running,
        sync: () => sync.start([]), addLinks: () => setAddOpen(true), sources: () => setSourcesOpen(true), setMode, setTheme, search: setQ,
      }} />
    </div>
  )
}

const FAIL = navigator.language.startsWith('ru')
  ? { text: 'Не удалось связаться с сервером. Проверьте, запущен ли server.py.', retry: 'Повторить' }
  : { text: 'Could not reach the server. Check that server.py is running.', retry: 'Retry' }

export default function App() {
  const [lang, setLang] = useState<Lang | null>(null)
  const [failed, setFailed] = useState(false)
  const loadLang = useCallback(() => {
    fetch('api/lang')
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json() })
      .then((l: Lang) => {
        document.documentElement.lang = l.language
        document.title = l.ui.title
        setLang(l)
      })
      .catch(() => setFailed(true))
  }, [])
  useEffect(() => { loadLang() }, [loadLang])
  if (lang) return <LangCtx.Provider value={lang}><Main /></LangCtx.Provider>
  if (failed) return (
    <div role="alert" className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-3 px-4 text-center">
      <CircleAlert aria-hidden className="size-6 text-destructive" />
      <p className="text-base text-pretty">{FAIL.text}</p>
      <Button variant="outline" onClick={() => { setFailed(false); loadLang() }}>{FAIL.retry}</Button>
    </div>
  )
  // language is loading: header skeleton instead of a white page
  return (
    <div aria-hidden className="mx-auto max-w-[86rem] px-4 py-3 md:px-6 md:py-6 min-[1200px]:px-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="h-7 w-24 rounded-sm bg-muted" />
        <div className="flex gap-2"><div className="h-8 w-8 rounded-lg bg-muted" /><div className="h-8 w-28 rounded-lg bg-muted" /><div className="h-8 w-8 rounded-lg bg-muted" /><div className="h-8 w-20 rounded-lg bg-muted" /></div>
      </div>
    </div>
  )
}
