import {
  Activity,
  CheckCircle2,
  Clipboard,
  Container,
  FileText,
  Gauge,
  RefreshCw,
  Server,
  TriangleAlert,
  WrapText,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, ApiError, type Agent, type ManagedStack, type Role, type RuntimeServiceStatus, type TelemetrySnapshot } from './api'
import type { Locale, Translate } from './App'
import { copyText } from './clipboard'

const panelClass = 'rounded-[1.4rem] border border-stone-200/80 bg-sand-50 shadow-panel dark:border-white/[0.07] dark:bg-ink-900/80'
const inputClass = 'h-12 w-full rounded-xl border border-stone-200 bg-white px-3.5 text-sm font-semibold text-ink-800 outline-none transition focus:border-mint-400 focus:ring-4 focus:ring-mint-400/10 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/[0.08] dark:bg-white/[0.035] dark:text-stone-100'
const primaryButton = 'flex min-h-12 items-center justify-center gap-2 rounded-xl bg-ink-900 px-5 text-sm font-extrabold text-white transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 dark:bg-mint-400 dark:text-ink-950'
const secondaryButton = 'flex min-h-11 items-center justify-center gap-2 rounded-xl border border-stone-200 bg-white px-4 text-xs font-extrabold transition hover:border-mint-400 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/5'
const servicePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
const maxLogCharacters = 500_000

export function MonitoringPage({ t, locale }: { t: Translate; locale: Locale }) {
  const [snapshots, setSnapshots] = useState<TelemetrySnapshot[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')

  async function load(background = false) {
    background ? setRefreshing(true) : setLoading(true)
    setError('')
    try {
      const [summary, agentResult] = await Promise.all([api.monitoringSummary(), api.agents()])
      setSnapshots(summary.agents)
      setAgents(agentResult.agents)
    } catch (caught) {
      setError(friendlyError(caught, t))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(true), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const now = Date.now()
  const staleCount = snapshots.filter((snapshot) => isStale(snapshot, now)).length
  const services = snapshots.flatMap((snapshot) => snapshot.services)
  const healthyCount = services.filter((service) => service.status === 'healthy').length
  const unhealthyCount = services.filter((service) => service.status === 'unhealthy').length

  return <PageShell icon={Activity} title={t('monitoringTitle')} description={t('monitoringDescription')} action={<button type="button" className={secondaryButton} disabled={refreshing} onClick={() => void load(true)}><RefreshCw className={refreshing ? 'animate-spin' : ''} size={15} />{t('refresh')}</button>}>
    {error && <Alert>{error}</Alert>}
    {loading ? <Loading t={t} /> : <>
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric icon={Server} label={t('reportingAgents')} value={formatNumber(snapshots.length, locale)} />
        <Metric icon={CheckCircle2} label={t('healthyServices')} value={formatNumber(healthyCount, locale)} tone="good" />
        <Metric icon={TriangleAlert} label={t('unhealthyServices')} value={formatNumber(unhealthyCount, locale)} tone={unhealthyCount ? 'bad' : 'neutral'} />
        <Metric icon={Gauge} label={t('staleAgents')} value={formatNumber(staleCount, locale)} tone={staleCount ? 'warn' : 'neutral'} />
      </section>
      {snapshots.length === 0 ? <Empty icon={Activity} text={t('noMonitoringData')} /> : <section className="grid grid-cols-1 gap-4 xl:grid-cols-2 2xl:grid-cols-3">
        {snapshots.map((snapshot) => <AgentTelemetryCard key={snapshot.agentId} snapshot={snapshot} agent={agents.find((item) => item.id === snapshot.agentId)} locale={locale} t={t} now={now} />)}
      </section>}
    </>}
  </PageShell>
}

function AgentTelemetryCard({ snapshot, agent, locale, t, now }: { snapshot: TelemetrySnapshot; agent?: Agent; locale: Locale; t: Translate; now: number }) {
  const stale = isStale(snapshot, now)
  const total = snapshot.node.memoryTotalBytes
  const used = Math.max(0, total - snapshot.node.memoryAvailableBytes)
  const memoryPercent = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
  return <article className={`${panelClass} min-w-0 overflow-hidden`}>
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-stone-200/70 p-5 dark:border-white/[0.06] sm:p-6">
      <div className="min-w-0"><p className="text-[0.65rem] font-extrabold uppercase tracking-wider text-stone-400">{t('runtimeHealth')}</p><h2 className="truncate pt-1 text-lg font-black text-ink-900 dark:text-white">{agent?.name || snapshot.agentId}</h2></div>
      <Freshness stale={stale} t={t} />
    </div>
    <div className="flex flex-col gap-5 p-5 sm:p-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Meta label={t('uptime')} value={formatDuration(snapshot.node.uptimeSeconds, locale)} />
        <Meta label={t('loadAverage')} value={`${formatDecimal(snapshot.node.load1, locale)} / ${formatDecimal(snapshot.node.load5, locale)} / ${formatDecimal(snapshot.node.load15, locale)}`} ltr />
        <Meta label={t('lastObserved')} value={formatDate(snapshot.observedAt, locale)} wide />
      </div>
      <div>
        <div className="flex items-center justify-between gap-3 text-xs"><span className="font-extrabold">{t('memoryUsage')}</span><bdi dir="ltr" className="font-mono text-stone-500 dark:text-stone-300">{formatBytes(used, locale)} / {formatBytes(total, locale)}</bdi></div>
        <div role="progressbar" aria-label={t('memoryUsage')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={memoryPercent} className="mt-2 h-2.5 overflow-hidden rounded-full bg-stone-200 dark:bg-white/10"><span className={`block h-full rounded-full ${memoryPercent > 90 ? 'bg-rose-500' : memoryPercent > 75 ? 'bg-amber-500' : 'bg-mint-400'}`} style={{ width: `${memoryPercent}%` }} /></div>
      </div>
      <div><div className="flex items-center justify-between gap-3"><h3 className="text-xs font-extrabold text-ink-900 dark:text-white">{t('runtimeServices')}</h3><span className="text-[0.65rem] font-bold text-stone-400">{formatNumber(snapshot.services.length, locale)}</span></div>
        {snapshot.services.length === 0 ? <p className="pt-3 text-xs font-semibold text-stone-400">{t('noRuntimeServices')}</p> : <div className="grid grid-cols-1 gap-2 pt-3 sm:grid-cols-2">{snapshot.services.map((service) => <div key={service.name} className="min-w-0 rounded-xl border border-stone-200/70 bg-white/50 p-3 dark:border-white/[0.06] dark:bg-white/[0.025]"><div className="flex items-start justify-between gap-2"><bdi dir="ltr" className="truncate font-mono text-xs font-bold text-ink-900 dark:text-white">{service.name}</bdi><RuntimeStatus status={service.status} t={t} /></div><bdi dir="ltr" className="block truncate pt-2 text-[0.65rem] text-stone-400">{service.projectName} / {service.serviceName}</bdi></div>)}</div>}
      </div>
      <p className="text-[0.65rem] font-semibold text-stone-400">{t('receivedAt')}: <bdi dir="ltr">{formatDate(snapshot.receivedAt, locale)}</bdi></p>
    </div>
  </article>
}

export function LogsPage({ t, locale, role }: { t: Translate; locale: Locale; role: Role }) {
  const [stacks, setStacks] = useState<ManagedStack[]>([])
  const [stackId, setStackId] = useState('')
  const [service, setService] = useState('')
  const [tail, setTail] = useState(200)
  const [windowMinutes, setWindowMinutes] = useState(60)
  const [logs, setLogs] = useState('')
  const [wrapped, setWrapped] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [status, setStatus] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const pollTimer = useRef<number | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    void api.stacks().then((result) => { setStacks(result.stacks); setStackId(result.stacks[0]?.id || '') }).catch((caught) => setError(friendlyError(caught, t))).finally(() => setLoading(false))
    return () => { mounted.current = false; if (pollTimer.current !== null) window.clearTimeout(pollTimer.current) }
  }, [])

  async function poll(commandId: string) {
    try {
      const result = await api.logRequest(commandId)
      if (!mounted.current) return
      setStatus(result.command.status)
      if (result.command.status === 'succeeded') {
        const output = result.command.result?.logs || ''
        setLogs(output.length > maxLogCharacters ? output.slice(-maxLogCharacters) : output)
        setTruncated(Boolean(result.command.result?.truncated) || output.length > maxLogCharacters)
        setBusy(false)
        return
      }
      if (result.command.status === 'failed') {
        setError(t('logRequestFailed')); setBusy(false); return
      }
      pollTimer.current = window.setTimeout(() => void poll(commandId), 2_000)
    } catch (caught) {
      setError(friendlyError(caught, t)); setBusy(false)
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const normalizedService = service.trim()
    if (!stackId || !servicePattern.test(normalizedService)) { setError(t('invalidServiceName')); return }
    if (pollTimer.current !== null) window.clearTimeout(pollTimer.current)
    setBusy(true); setError(''); setLogs(''); setTruncated(false); setStatus('pending')
    try {
      const since = windowMinutes === 0 ? undefined : new Date(Date.now() - windowMinutes * 60_000).toISOString()
      const result = await api.requestLogs(stackId, normalizedService, tail, since)
      setStatus(result.status)
      await poll(result.commandId)
    } catch (caught) { setError(friendlyError(caught, t)); setBusy(false) }
  }

  async function copy() {
    try { await copyText(logs); setCopied(true); window.setTimeout(() => setCopied(false), 2_000) }
    catch { setError(t('copyFailed')) }
  }

  return <PageShell icon={FileText} title={t('logsTitle')} description={t('logsDescription')}>
    {role === 'viewer' && <Notice>{t('logsPermissionNotice')}</Notice>}
    {error && <Alert>{error}</Alert>}
    {loading ? <Loading t={t} /> : <>
      {role !== 'viewer' && <form onSubmit={submit} className={`${panelClass} grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:p-6 xl:grid-cols-12 xl:items-end`}>
        <Field label={t('stack')} className="xl:col-span-3"><select required value={stackId} onChange={(event) => setStackId(event.target.value)} className={inputClass}><option value="">{t('chooseStack')}</option>{stacks.map((stack) => <option key={stack.id} value={stack.id}>{stack.name}</option>)}</select></Field>
        <Field label={t('composeService')} hint={t('composeServiceHint')} className="xl:col-span-3"><input required dir="ltr" maxLength={128} pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]*" value={service} onChange={(event) => setService(event.target.value)} className={inputClass} /></Field>
        <Field label={t('tailLines')} className="xl:col-span-2"><select value={tail} onChange={(event) => setTail(Number(event.target.value))} className={inputClass}>{[100, 200, 500, 1000].map((value) => <option key={value} value={value}>{formatNumber(value, locale)}</option>)}</select></Field>
        <Field label={t('timeWindow')} className="xl:col-span-2"><select value={windowMinutes} onChange={(event) => setWindowMinutes(Number(event.target.value))} className={inputClass}><option value={15}>{t('last15Minutes')}</option><option value={60}>{t('lastHour')}</option><option value={360}>{t('last6Hours')}</option><option value={1440}>{t('last24Hours')}</option><option value={0}>{t('availableHistory')}</option></select></Field>
        <button disabled={busy || stacks.length === 0} className={`${primaryButton} xl:col-span-2`}><FileText size={16} />{t('requestLogs')}</button>
      </form>}
      {!loading && stacks.length === 0 && <Notice>{t('noStacksForLogs')}</Notice>}
      <section className={`${panelClass} min-w-0 overflow-hidden`}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200/70 p-3 dark:border-white/[0.06] sm:px-5"><div className="flex items-center gap-2"><Container size={16} className="text-mint-500" /><span className="text-xs font-extrabold">{t('logOutput')}</span>{status && <span className="rounded-full bg-stone-200/70 px-2 py-1 text-[0.62rem] font-bold dark:bg-white/10">{t(status as 'pending' | 'claimed' | 'succeeded' | 'failed')}</span>}</div><div className="flex gap-2"><button type="button" aria-pressed={wrapped} onClick={() => setWrapped((value) => !value)} className={secondaryButton}><WrapText size={15} />{t(wrapped ? 'unwrapLines' : 'wrapLines')}</button><button type="button" disabled={!logs} onClick={() => void copy()} className={secondaryButton}><Clipboard size={15} />{t(copied ? 'copied' : 'copy')}</button></div></div>
        {busy && <div role="status" className="flex min-h-40 items-center justify-center gap-3 bg-ink-950 text-sm font-bold text-stone-400"><RefreshCw className="animate-spin" size={18} />{t('waitingForLogs')}</div>}
        {!busy && <pre dir="ltr" tabIndex={0} aria-label={t('logOutput')} className={`max-h-[60vh] min-h-64 overflow-auto bg-[#050b0a] p-4 text-left font-mono text-xs leading-5 text-stone-200 sm:p-5 ${wrapped ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}`}>{logs || t('noLogOutput')}</pre>}
        {truncated && <div role="status" className="flex items-center gap-2 border-t border-amber-500/20 bg-amber-500/10 px-4 py-3 text-xs font-bold text-amber-700 dark:text-amber-300"><TriangleAlert size={15} />{t('logsTruncated')}</div>}
      </section>
    </>}
  </PageShell>
}

function PageShell({ icon: Icon, title, description, action, children }: { icon: typeof Activity; title: string; description: string; action?: React.ReactNode; children: React.ReactNode }) { return <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-6"><section className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end"><div className="max-w-3xl"><span className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.14em] text-mint-500 dark:text-mint-300"><Icon size={15} />GatewayControl</span><h1 className="pt-2 text-3xl font-black tracking-[-0.045em] text-ink-900 dark:text-white sm:text-4xl">{title}</h1><p className="max-w-2xl pt-2 text-sm font-medium leading-6 text-stone-500 dark:text-stone-400 sm:text-base">{description}</p></div>{action}</section>{children}</div> }
function Metric({ icon: Icon, label, value, tone = 'neutral' }: { icon: typeof Activity; label: string; value: string; tone?: 'neutral' | 'good' | 'warn' | 'bad' }) { const color = tone === 'good' ? 'text-emerald-600 dark:text-emerald-300' : tone === 'warn' ? 'text-amber-600 dark:text-amber-300' : tone === 'bad' ? 'text-rose-600 dark:text-rose-300' : 'text-mint-500 dark:text-mint-300'; return <article className={`${panelClass} min-w-0 p-4 sm:p-5`}><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="text-[0.68rem] font-bold text-stone-400">{label}</p><bdi dir="ltr" className="block pt-2 text-2xl font-black text-ink-900 dark:text-white sm:text-3xl">{value}</bdi></div><Icon className={`shrink-0 ${color}`} size={20} /></div></article> }
function Freshness({ stale, t }: { stale: boolean; t: Translate }) { return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.65rem] font-extrabold ${stale ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{t(stale ? 'stale' : 'fresh')}</span> }
function RuntimeStatus({ status, t }: { status: RuntimeServiceStatus; t: Translate }) { const color = status === 'healthy' ? 'text-emerald-700 bg-emerald-500/10 dark:text-emerald-300' : status === 'unhealthy' ? 'text-rose-700 bg-rose-500/10 dark:text-rose-300' : status === 'starting' ? 'text-amber-700 bg-amber-500/10 dark:text-amber-300' : 'text-stone-500 bg-stone-500/10 dark:text-stone-300'; return <span className={`shrink-0 rounded-full px-2 py-1 text-[0.6rem] font-extrabold ${color}`}>{t(status === 'healthy' ? 'runtimeHealthy' : status)}</span> }
function Meta({ label, value, ltr = false, wide = false }: { label: string; value: string; ltr?: boolean; wide?: boolean }) { return <div className={`min-w-0 rounded-xl bg-stone-100/70 p-3 dark:bg-white/[0.03] ${wide ? 'col-span-2 sm:col-span-1' : ''}`}><span className="block text-[0.62rem] font-bold text-stone-400">{label}</span><bdi dir={ltr ? 'ltr' : undefined} className="block truncate pt-1 text-xs font-bold text-ink-800 dark:text-stone-200">{value}</bdi></div> }
function Field({ label, hint, className = '', children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) { return <label className={`flex min-w-0 flex-col gap-2 ${className}`}><span className="text-xs font-extrabold text-ink-800 dark:text-stone-100">{label}</span>{children}{hint && <span className="text-[0.66rem] font-medium leading-5 text-stone-400">{hint}</span>}</label> }
function Alert({ children }: { children: React.ReactNode }) { return <div role="alert" className="flex items-start gap-2 rounded-xl bg-rose-500/10 px-3.5 py-3 text-xs font-bold leading-5 text-rose-700 dark:text-rose-300"><TriangleAlert className="mt-0.5 shrink-0" size={15} />{children}</div> }
function Notice({ children }: { children: React.ReactNode }) { return <div className="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3.5 py-3 text-xs font-bold leading-5 text-amber-700 dark:text-amber-300"><TriangleAlert className="mt-0.5 shrink-0" size={15} />{children}</div> }
function Loading({ t }: { t: Translate }) { return <div role="status" className={`${panelClass} flex items-center justify-center gap-3 p-8 text-sm font-bold text-stone-400`}><RefreshCw className="animate-spin" size={18} />{t('loadingData')}</div> }
function Empty({ icon: Icon, text }: { icon: typeof Activity; text: string }) { return <div className={`${panelClass} flex min-h-52 flex-col items-center justify-center p-10 text-center`}><Icon className="text-stone-300 dark:text-stone-600" size={31} /><p className="pt-3 text-sm font-bold text-stone-400">{text}</p></div> }
function isStale(snapshot: TelemetrySnapshot, now: number) { return now - new Date(snapshot.receivedAt).getTime() > 90_000 }
function formatNumber(value: number, locale: Locale) { return new Intl.NumberFormat(locale).format(value) }
function formatDecimal(value: number, locale: Locale) { return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value) }
function formatBytes(value: number, locale: Locale) { if (!Number.isFinite(value) || value < 0) return '—'; const units = ['B', 'KB', 'MB', 'GB', 'TB']; const index = value === 0 ? 0 : Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1); return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / 1024 ** index)} ${units[index]}` }
function formatDuration(seconds: number, locale: Locale) { const days = Math.floor(seconds / 86_400); const hours = Math.floor((seconds % 86_400) / 3_600); const minutes = Math.floor((seconds % 3_600) / 60); const unit = (value: number, name: 'day' | 'hour' | 'minute') => new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'short' }).format(value); return days > 0 ? `${unit(days, 'day')} ${unit(hours, 'hour')}` : `${unit(hours, 'hour')} ${unit(minutes, 'minute')}` }
function formatDate(value: string, locale: Locale) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date) }
function friendlyError(error: unknown, t: Translate) { if (error instanceof ApiError) { if (error.status === 403) return t('forbidden'); if (error.status === 409) return t('conflict'); if (error.status === 400) return t('validationError') } return t('requestFailed') }
