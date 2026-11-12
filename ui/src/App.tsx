import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, Plus, X, ChevronDown, Play, Search, Check, MapPin, Link2, CircleCheck, Sun, Moon, Monitor, ArrowUpRight, ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import L from 'leaflet'
import type { Lang, Reel } from '@/types'

const TOP = 10
const MAX_SECTIONS = 3 // sections shown when a card is expanded
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
const f = (s: string, v: Record<string, string | number> = {}) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''))

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

function ThemeSelect() {
  const { ui } = useLang()
  const [theme, setTheme] = useTheme()
  const Icon = THEMES[theme]
  const label = `${ui.theme}: ${ui['theme_' + theme]}`
  return (
    <Select value={theme} onValueChange={(v) => v && setTheme(v as Theme)}>
      <SelectTrigger aria-label={label} title={label}
        className="size-8 justify-center border-border bg-card p-0 hover:bg-muted data-popup-open:bg-muted [&>svg:last-child]:hidden">
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

type Sync = { running: boolean; step: string; log: string; error: string }
type Sources = { telegram: string | null; tiktok: number | null; later: string[] }

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
  const load = useCallback(() => fetch('api/reels')
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json() })
    .then((l) => { setReels(l); setState('ok') })
    .catch(() => setState('error')), [])
  useEffect(() => { load() }, [load])
  return { reels, load, state }
}

function SyncButton({ onDone }: { onDone: () => void }) {
  const { ui } = useLang()
  const [st, setSt] = useState<Sync | null>(null)
  const [links, setLinks] = useState('')
  const start = async (urls: string[]) => {
    try {
      const r = await post('api/sync', JSON.stringify({ urls }))
      setSt(await r.json())
    } catch {
      setSt({ running: false, step: '', log: '', error: ui.no_server })
    }
  }
  useEffect(() => {
    if (!st?.running) return
    const t = setInterval(async () => {
      try {
        const s: Sync = await fetch('api/sync').then((r) => r.json())
        setSt(s)
        if (!s.running) { onDone(); clearInterval(t) }
      } catch {
        setSt({ running: false, step: '', log: '', error: ui.no_server })
        clearInterval(t)
      }
    }, 2000)
    return () => clearInterval(t)
  }, [st?.running, onDone, ui.no_server])
  const words = links.split(/\s+/).filter(Boolean)
  const urls = words.filter((l) => LINK.test(l))
  return (
    <div className="flex items-center gap-2">
      <span role="status" className="text-sm text-muted-foreground">
        {st?.error ? f(ui.sync_failed, { e: st.error }) : st?.step}
      </span>
      <Popover>
        <PopoverTrigger render={<Button variant="outline" size="icon" title={ui.add_links} aria-label={ui.add_links} />}>
          <Plus />
        </PopoverTrigger>
        <PopoverContent className="w-96 space-y-2">
          <p className="text-sm">{ui.paste_links}</p>
          <Textarea rows={5} value={links} onChange={(e) => setLinks(e.target.value)} aria-describedby="links-hint" />
          <p id="links-hint" className="text-xs text-muted-foreground">
            {words.length > urls.length ? f(ui.links_skipped, { n: words.length - urls.length }) : ui.links_hint}
          </p>
          <Button disabled={!urls.length || st?.running} onClick={() => { start(urls); setLinks('') }}>
            {f(ui.add_sync, { n: urls.length })}
          </Button>
        </PopoverContent>
      </Popover>
      <Button disabled={st?.running} onClick={() => start([])}>
        <RefreshCw className={st?.running ? 'motion-safe:animate-spin' : ''} /> {ui.sync}
      </Button>
    </div>
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

function Onboarding() {
  const { ui } = useLang()
  const [src, setSrc] = useState<Sources | null>(null)
  const [open, setOpen] = useState(false)
  const [changed, setChanged] = useState(false)
  const reload = useCallback((auto = false) => fetch('api/sources').then((r) => r.json()).then((s: Sources) => {
    setSrc(s)
    // first visit: open by itself while something is neither connected nor put off with "Add later"
    if (auto && ((!s.telegram && !s.later.includes('telegram')) || (s.tiktok === null && !s.later.includes('tiktok')))) setOpen(true)
  }).catch(() => {}), [])
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
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Link2 /> {ui.ob_open}{pending && pending.length > 0 && <span className="size-2 rounded-full bg-primary" aria-hidden />}
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

function Tag({ t, on, n, onClick }: { t: string; on: boolean; n?: number; onClick: () => void }) {
  return (
    <Badge render={<button type="button" />} aria-pressed={on} aria-label={n !== undefined ? `#${t}, ${n}` : `#${t}`} onClick={onClick}
      className={`h-7 cursor-pointer gap-0 rounded-full px-2.5 text-xs font-medium transition-[color,background-color] duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)]
        ${on ? 'bg-foreground text-background hover:bg-foreground/85'
             : 'bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_6%)]'}`}>
      {/* fixed 12px slot for # / check: the chip keeps its width when selected, neighbours do not jump */}
      <span aria-hidden className="inline-flex w-3.5 justify-center">{on ? <Check className="size-3" /> : '#'}</span>
      {t}
      {n !== undefined && <span aria-hidden className={`ms-1 font-normal tabular-nums ${on ? 'opacity-80' : 'text-muted-foreground'}`}>{n}</span>}
    </Badge>
  )
}

function ReelCard({ r, toggle, active }: { r: Reel; toggle: (t: string) => void; active: Set<string> }) {
  const { ui, kind_order, hidden_kinds } = useLang()
  const [kRecipe, kPlace] = [kind_order[1], kind_order[3]]
  const all = r.key?.length ? r.key : [
    ...(r.recipes ?? []).map((x) => ({ kind: kRecipe, text: `${x.name ?? ''}: ${(x.ingredients ?? []).join(', ')}. ${x.steps ?? ''}` })),
    ...(r.places ?? []).map((x) => ({ kind: kPlace, text: [x.name, x.city].filter(Boolean).join(', ') })),
  ]
  const key = all
    .filter((k, i) => !hidden_kinds.includes(k.kind) && all.findIndex((x) => x.kind === k.kind) === i) // one section per kind
    .sort((a, b) => kind_order.indexOf(a.kind) - kind_order.indexOf(b.kind)) // concrete kinds first
  const [open, setOpen] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const [long, setLong] = useState(false)
  useLayoutEffect(() => {
    if (open) return
    const ps = [...(body.current?.querySelectorAll('p') ?? [])]
    setLong(Math.min(key.length, MAX_SECTIONS) > 1 || ps.some((p) => p.scrollHeight > p.clientHeight + 1))
  }, [open, key.length, r.summary])
  const clamp = open ? '' : 'line-clamp-3'
  const thumb = r.thumbs?.length ? r.thumbs[Math.floor(r.thumbs.length / 2)] : null
  return (
    <Card className="flex-row items-start gap-4 rounded-2xl p-3">
      <a href={r.url} target="_blank" rel="noreferrer" title={ui.open_reel} aria-label={f(ui.open_reel_by, { a: r.author })}
        className="group relative flex aspect-[9/16] w-[113px] shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted">
        {thumb && <img src={thumb} alt="" loading="lazy" className="absolute inset-0 size-full object-cover motion-safe:transition-transform motion-safe:group-hover:scale-105" />}
        <span className="relative flex size-10 items-center justify-center rounded-full bg-on-media text-[oklch(.21_.01_260)]"><Play className="ml-0.5 fill-current" size={18} /></span>
      </a>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="space-y-1">
          <h3 className="line-clamp-2 text-base font-semibold leading-snug text-balance">{r.title || r.summary?.slice(0, 60) || r.id}</h3>
          <div className="text-xs text-muted-foreground">
            <span className="me-1.5 rounded-sm bg-secondary px-1.5 py-0.5 font-medium text-secondary-foreground">{SOURCES[r.source] ?? r.source}</span>
            <a href={r.url} target="_blank" rel="noreferrer" className="hover:underline">@{r.author}<Ext /></a>
            {fmtDate(r.upload_date) && <> · <span className="tabular-nums">{fmtDate(r.upload_date)}</span></>}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {r.tags.slice(0, 2).map((t) => <Tag key={t} t={t} on={active.has(t)} onClick={() => toggle(t)} />)}
        </div>
        <div ref={body} className="flex flex-col gap-2">
        {r.summary && <p className={`text-sm text-pretty ${clamp}`}>{r.summary}</p>}
        {key.slice(0, open ? MAX_SECTIONS : 1).map((k, i) => (
          <div key={i} className="space-y-1">
            <div className="text-sm font-medium capitalize text-muted-foreground">{k.kind}</div>
            <p className={`text-sm text-pretty ${clamp}`}>{k.text}</p>
          </div>
        ))}
        </div>
        {long && <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex items-center gap-1 self-start text-sm font-medium text-accent-text hover:underline">{open ? ui.collapse : ui.expand}<ChevronDown aria-hidden className={`size-4 motion-safe:transition-transform ${open ? 'rotate-180' : ''}`} /></button>}
      </div>
    </Card>
  )
}

type PlaceRow = { key: string; name: string; country: string; city: string; lat?: number; lng?: number; approx?: boolean; reels: Reel[] }

const mapsUrl = (p: { name: string; city: string; country: string }) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([p.name, p.city, p.country].filter(Boolean).join(', '))}`
const thumbOf = (r: Reel) => (r.thumbs?.length ? r.thumbs[Math.floor(r.thumbs.length / 2)] : null)

// One row per place (exact name + city, case-insensitive), rows grouped by city; places without a city go last.
function groupPlaces(reels: Reel[]) {
  const rows = new Map<string, PlaceRow>()
  for (const r of reels) {
    for (const p of r.places ?? []) {
      const key = `${p.name.toLowerCase()}|${p.city.toLowerCase()}`
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

// Popup is built with DOM nodes and textContent: place names come from an LLM and must not be parsed as HTML.
function popupOf(p: PlaceRow, openLabel: string, approxLabel: string) {
  const el = document.createElement('div')
  el.className = 'grid gap-1'
  const title = document.createElement('strong')
  title.className = 'text-sm font-semibold'
  title.textContent = p.name
  const sub = document.createElement('div')
  sub.className = 'text-xs text-muted-foreground'
  sub.textContent = [p.city, p.country].filter(Boolean).join(', ')
  const link = document.createElement('a')
  link.href = mapsUrl(p); link.target = '_blank'; link.rel = 'noreferrer'; link.className = 'text-sm font-medium'; link.textContent = openLabel; link.insertAdjacentHTML('beforeend', EXT_SVG)
  el.append(title, sub)
  if (p.approx) { const ap = document.createElement('div'); ap.className = 'text-xs text-muted-foreground'; ap.textContent = approxLabel; el.append(ap) }
  el.append(link)
  const thumbs = document.createElement('div')
  thumbs.style.cssText = 'display:flex;gap:4px;margin-top:6px'
  for (const r of p.reels) {
    const a = document.createElement('a')
    a.href = r.url; a.target = '_blank'; a.rel = 'noreferrer'; a.title = r.title || r.id
    a.style.cssText = 'display:block;width:30px;aspect-ratio:9/16;border-radius:6px;overflow:hidden;background:var(--muted)'
    const t = thumbOf(r)
    if (t) { const i = document.createElement('img'); i.src = t; i.alt = ''; i.style.cssText = 'width:100%;height:100%;object-fit:cover'; a.append(i) }
    thumbs.append(a)
  }
  el.append(thumbs)
  return el
}

function PlacesMap({ rows, focus }: { rows: PlaceRow[]; focus: { key: string; n: number } | null }) {
  const { ui } = useLang()
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const layer = useRef<L.LayerGroup | null>(null)
  const markers = useRef(new Map<string, L.CircleMarker>())
  useEffect(() => {
    const m = L.map(el.current!).setView([20, 0], 2)
    L.tileLayer(TILES, {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(m)
    map.current = m; layer.current = L.layerGroup().addTo(m)
    return () => { m.remove(); map.current = null }
  }, [])
  useEffect(() => {
    layer.current?.clearLayers(); markers.current.clear()
    const pts: L.LatLngTuple[] = []
    for (const p of rows) {
      if (p.lat === undefined || p.lng === undefined) continue
      const mk = L.circleMarker([p.lat, p.lng], { radius: 8, className: p.approx ? 'map-marker map-marker--approx' : 'map-marker' })
        .bindPopup(popupOf(p, ui.on_map, ui.approx), { autoPan: !reducedMotion() }).addTo(layer.current!)
      // reduced motion: Leaflet's autoPan animates, so keep the popup in view with an instant pan instead
      mk.on('popupopen', (e) => {
        const el = e.popup.getElement()
        if (reducedMotion() && el) map.current?.panInside(e.popup.getLatLng()!, { animate: false, paddingTopLeft: [el.offsetWidth / 2 + 16, el.offsetHeight + 44], paddingBottomRight: [el.offsetWidth / 2 + 16, 16] })
      })
      markers.current.set(p.key, mk); pts.push([p.lat, p.lng])
    }
    if (pts.length) map.current?.fitBounds(pts, { padding: [40, 40], maxZoom: 14, animate: !reducedMotion() })
  }, [rows, ui.on_map, ui.approx])
  useEffect(() => {
    const mk = focus && markers.current.get(focus.key)
    if (mk && map.current) {
      const z = Math.max(map.current.getZoom(), 13)
      if (reducedMotion()) map.current.setView(mk.getLatLng(), z, { animate: false })
      else map.current.flyTo(mk.getLatLng(), z)
      mk.openPopup()
    }
  }, [focus])
  return <div ref={el} role="region" aria-label={ui.mode_places} className="z-0 h-72 w-full overflow-hidden rounded-2xl border lg:sticky lg:top-4 lg:h-[calc(100dvh-2rem)] lg:flex-1" />
}

function PlacesView({ reels }: { reels: Reel[] }) {
  const { ui } = useLang()
  const groups = useMemo(() => groupPlaces(reels), [reels])
  const rows = useMemo(() => groups.flatMap((g) => g.list), [groups])
  const [focus, setFocus] = useState<{ key: string; n: number } | null>(null)
  if (!groups.length) return <p className="text-sm text-muted-foreground">{ui.places_empty}</p>
  return (
    <div className="flex flex-col gap-4 lg:flex-row-reverse lg:items-start">
      <PlacesMap rows={rows} focus={focus} />
      <div className="space-y-5 lg:max-h-[calc(100dvh-2rem)] lg:w-[360px] lg:shrink-0 lg:overflow-y-auto lg:pe-1">
        {groups.map(({ city, list }) => (
          <section key={city} aria-label={city || ui.no_city} className="space-y-2">
            <h2 className="text-lg font-semibold">{city || ui.no_city}<span className="ml-2 text-sm font-normal tabular-nums text-muted-foreground">{list.length}</span></h2>
            <div className="grid gap-2">
              {list.map((p) => {
                const geo = p.lat !== undefined
                return (
                  <Card key={p.key} className="gap-2 rounded-2xl p-3">
                    <div className="min-w-0 space-y-1">
                      <div className="font-medium leading-snug">
                        {geo
                          ? <button type="button" className="text-start hover:underline" onClick={() => setFocus({ key: p.key, n: Date.now() })}>{p.name}</button>
                          : p.name}
                        {p.country && <span className="ml-2 text-xs font-normal text-muted-foreground">{p.country}</span>}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 text-sm">
                        <a href={mapsUrl(p)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-accent-text hover:underline">
                          <MapPin aria-hidden className="size-4" />{ui.on_map}<ArrowUpRight aria-hidden className="size-3.5" />
                        </a>
                        {!geo && <span className="text-xs text-muted-foreground">{ui.no_coords}</span>}
                        {p.approx && <span className="text-xs text-muted-foreground">{ui.approx}</span>}
                      </div>
                    </div>
                    <div className="flex gap-1.5">
                      {p.reels.map((r) => {
                        const th = thumbOf(r)
                        return (
                          <a key={r.id} href={r.url} target="_blank" rel="noreferrer" title={r.title || r.id} aria-label={f(ui.open_reel_by, { a: r.author })}
                            className="relative block aspect-[9/16] w-9 overflow-hidden rounded-sm bg-muted">
                            {th && <img src={th} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />}
                          </a>
                        )
                      })}
                    </div>
                  </Card>
                )
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

function Main() {
  const { ui } = useLang()
  const { reels, load, state } = useReels()
  const [mode, setMode] = useState<'reels' | 'places'>('reels')
  const [q, setQ] = useState('')
  const [sem, setSem] = useState<Map<string, number> | null>(null)
  useEffect(() => {
    const ql = q.trim()
    if (!ql) { setSem(null); return }
    const t = setTimeout(() => fetch('api/search?q=' + encodeURIComponent(ql)).then((r) => r.json()).then((l: [string, number][]) => {
      const top = l[0]?.[1] ?? 0
      setSem(new Map(l.filter(([, s]) => s >= Math.max(0.3, top - 0.15))))
    }), 300)
    return () => clearTimeout(t)
  }, [q])
  const [sort, setSort] = useState('saved')
  const [active, setActive] = useState<Set<string>>(new Set())
  const [src, setSrc] = useState('all')
  const srcs = useMemo(() => [...new Set(reels.map((r) => r.source))].sort(), [reels])
  const toggle = useCallback((t: string) => setActive((s) => { const n = new Set(s); n.has(t) ? n.delete(t) : n.add(t); return n }), [])

  const { top, rest } = useMemo(() => {
    const cnt = new Map<string, number>()
    for (const r of reels) {
      new Set(r.tags).forEach((t) => cnt.set(t, (cnt.get(t) ?? 0) + 1))
    }
    const all = [...cnt].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    return { top: all.slice(0, TOP), rest: all.slice(TOP) }
  }, [reels])

  const shown = useMemo(() => {
    const ql = q.trim().toLowerCase()
    const hit = (r: Reel) => [r.title, r.author, r.caption, r.transcript, r.ocr].join(' ').toLowerCase().includes(ql)
    const list = reels
      .filter((r) => src === 'all' || r.source === src)
      .filter((r) => { const s = new Set([...r.tags, ...r.specific_tags]); return [...active].every((t) => s.has(t)) })
      .filter((r) => !ql || (sem ? sem.has(r.id) : false) || (!sem && hit(r)))
    return ql && sem ? list.sort((a, b) => (sem.get(b.id) ?? 0) - (sem.get(a.id) ?? 0)) : list.sort(SORTS[sort])
  }, [reels, q, active, sort, sem, src])

  const tagList = (
    <div className="flex flex-wrap gap-1.5">
      {[...top, ...rest].filter(([, n]) => n >= MIN_TAG).map(([t, n]) => <Tag key={t} t={t} n={n} on={active.has(t)} onClick={() => toggle(t)} />)}
    </div>
  )

  return (
    <div className="mx-auto flex min-h-dvh max-w-7xl gap-6 p-4">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-10 focus:rounded-lg focus:bg-card focus:px-3 focus:py-2">{ui.skip}</a>
      <aside aria-label={ui.tags} className="sticky top-4 hidden h-fit w-60 shrink-0 rounded-2xl border bg-card p-3 md:block">
        {tagList}
      </aside>

      <main id="main" tabIndex={-1} className="min-w-0 flex-1 space-y-4 outline-none">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-semibold">{ui.title} <span role="status" className="text-sm font-normal tabular-nums text-muted-foreground">{f(ui.shown_of, { n: shown.length, m: reels.length })}</span></h1>
          <div className="flex flex-wrap items-center gap-2"><ThemeSelect /><Onboarding /><SyncButton onDone={load} /></div>
        </header>

        <div role="group" aria-label={ui.mode} className="flex gap-1">
          {(['reels', 'places'] as const).map((m) => (
            <Button key={m} size="sm" variant={mode === m ? 'default' : 'outline'} aria-pressed={mode === m} onClick={() => setMode(m)}>
              {m === 'reels' ? ui.mode_reels : ui.mode_places}
            </Button>
          ))}
        </div>

        <details className="rounded-2xl border bg-card p-3 md:hidden">
          <summary className="cursor-pointer text-sm font-medium">{ui.tags}{active.size > 0 && ` (${active.size})`}</summary>
          <div className="mt-3">{tagList}</div>
        </details>

        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-input bg-card p-2 has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-ring">
          <Search aria-hidden className="ms-2.5 size-4 text-muted-foreground" />
          <Input aria-label={ui.search} className="min-w-64 flex-1 border-0 bg-transparent shadow-none focus-visible:outline-none" placeholder={ui.search_ph} value={q} onChange={(e) => setQ(e.target.value)} />
          {srcs.length > 1 && (
            <Select value={src} onValueChange={(v) => v && setSrc(v)}>
              <SelectTrigger aria-label={ui.source} className="w-40 border-0 bg-secondary"><SelectValue>{src === 'all' ? ui.all_sources : SOURCES[src] ?? src}</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{ui.all_sources}</SelectItem>
                {srcs.map((k) => <SelectItem key={k} value={k}>{SOURCES[k] ?? k}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          {mode === 'reels' && (
            <Select value={sort} onValueChange={(v) => v && setSort(v)}>
              <SelectTrigger aria-label={ui.sort} className="w-60 border-0 bg-secondary"><SelectValue>{ui.sorts[sort]}</SelectValue></SelectTrigger>
              <SelectContent>{Object.keys(SORTS).map((k) => <SelectItem key={k} value={k}>{ui.sorts[k]}</SelectItem>)}</SelectContent>
            </Select>
          )}
        </div>

      {(active.size > 0 || q || src !== 'all') && (
        <Button variant="ghost" size="sm" onClick={() => { setActive(new Set()); setQ(''); setSrc('all') }}><X /> {ui.reset}</Button>
      )}

      {state === 'error' && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-2xl border bg-card p-3 text-sm">
          {ui.load_failed}
          <Button size="sm" onClick={load}>{ui.retry}</Button>
        </div>
      )}
      {state === 'loading' && <p className="text-sm text-muted-foreground">{ui.loading}</p>}
      {state === 'ok' && mode === 'reels' && shown.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {reels.length ? (q.trim() ? f(ui.nothing_q, { q: q.trim() }) : ui.nothing) : ui.empty}
        </p>
      )}

      {mode === 'places'
        ? state === 'ok' && <PlacesView reels={shown} />
        : <div className="grid items-start gap-3">
            {shown.map((r) => <ReelCard key={r.id} r={r} toggle={toggle} active={active} />)}
          </div>}
      </main>
    </div>
  )
}

export default function App() {
  const [lang, setLang] = useState<Lang | null>(null)
  useEffect(() => {
    fetch('api/lang').then((r) => r.json()).then((l: Lang) => {
      document.documentElement.lang = l.language
      document.title = l.ui.title
      setLang(l)
    })
  }, [])
  return lang ? <LangCtx.Provider value={lang}><Main /></LangCtx.Provider> : null
}
