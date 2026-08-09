import { Archive, CheckCircle2, DatabaseBackup, HardDrive, Network, RefreshCw, RotateCcw, Server, ShieldCheck, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, ApiError, type ManagedStack, type OperationStatus, type Role, type StackBackup, type StackRestore } from './api'
import type { Locale, Translate } from './App'

const panelClass = 'rounded-[1.4rem] border border-stone-200/80 bg-sand-50 shadow-panel dark:border-white/[0.07] dark:bg-ink-900/80'
const inputClass = 'h-12 w-full rounded-xl border border-stone-200 bg-white px-3.5 text-sm font-semibold text-ink-800 outline-none transition focus:border-mint-400 focus:ring-4 focus:ring-mint-400/10 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/[0.08] dark:bg-white/[0.035] dark:text-stone-100'
const primaryButton = 'flex min-h-12 items-center justify-center gap-2 rounded-xl bg-ink-900 px-5 text-sm font-extrabold text-white transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 dark:bg-mint-400 dark:text-ink-950'
const secondaryButton = 'flex min-h-11 items-center justify-center gap-2 rounded-xl border border-stone-200 bg-white px-4 text-xs font-extrabold transition hover:border-mint-400 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/5'

export function BackupsPage({ t, locale, role }: { t: Translate; locale: Locale; role: Role }) {
  const [backups, setBackups] = useState<StackBackup[]>([])
  const [restores, setRestores] = useState<StackRestore[]>([])
  const [stacks, setStacks] = useState<ManagedStack[]>([])
  const [stackId, setStackId] = useState('')
  const [target, setTarget] = useState<StackBackup['target']>('local')
  const [confirming, setConfirming] = useState<StackBackup | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  async function load(background = false) {
    if (!background) setLoading(true)
    setError('')
    try {
      const [backupResult, restoreResult, stackResult] = await Promise.all([api.backups(), api.restores(), api.stacks()])
      setBackups(backupResult.backups)
      setRestores(restoreResult.restores)
      setStacks(stackResult.stacks)
      setStackId((current) => current || stackResult.stacks[0]?.id || '')
    } catch (caught) { setError(friendlyError(caught, t)) }
    finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [])
  const active = [...backups, ...restores].some((operation) => operation.status === 'pending' || operation.status === 'running')
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => void load(true), 5_000)
    return () => window.clearInterval(timer)
  }, [active])

  async function create(event: React.FormEvent) {
    event.preventDefault()
    if (!stackId) { setError(t('chooseStack')); return }
    setBusy('create'); setError(''); setSuccess('')
    try {
      const result = await api.createBackup(stackId, target)
      setBackups((current) => [result.backup, ...current])
      setSuccess(t('backupQueued'))
    } catch (caught) { setError(friendlyError(caught, t)) }
    finally { setBusy('') }
  }

  async function restore() {
    if (!confirming) return
    setBusy(`restore:${confirming.id}`); setError(''); setSuccess('')
    try {
      const result = await api.restoreBackup(confirming.id)
      setRestores((current) => [result.restore, ...current])
      setSuccess(t('restoreQueued'))
      setConfirming(null)
    } catch (caught) { setError(friendlyError(caught, t)) }
    finally { setBusy('') }
  }

  const succeeded = backups.filter((backup) => backup.status === 'succeeded').length
  const failed = backups.filter((backup) => backup.status === 'failed').length
  const totalBytes = backups.reduce((sum, backup) => sum + (backup.result?.sizeBytes || 0), 0)
  const confirmingStack = confirming ? stacks.find((stack) => stack.id === confirming.stackId) : undefined

  return <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-6">
    <section className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end"><div className="max-w-3xl"><span className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.14em] text-mint-500 dark:text-mint-300"><DatabaseBackup size={15} />GatewayControl</span><h1 className="pt-2 text-3xl font-black tracking-[-0.045em] text-ink-900 dark:text-white sm:text-4xl">{t('backupsTitle')}</h1><p className="max-w-2xl pt-2 text-sm font-medium leading-6 text-stone-500 dark:text-stone-400 sm:text-base">{t('backupsDescription')}</p></div><button type="button" className={secondaryButton} onClick={() => void load()}><RefreshCw size={15} />{t('refresh')}</button></section>
    {error && <Alert>{error}</Alert>}{success && <Success>{success}</Success>}
    {loading ? <Loading t={t} /> : <>
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4"><Summary icon={Archive} label={t('totalBackups')} value={formatNumber(backups.length, locale)} /><Summary icon={CheckCircle2} label={t('succeededBackups')} value={formatNumber(succeeded, locale)} /><Summary icon={TriangleAlert} label={t('failedBackups')} value={formatNumber(failed, locale)} /><Summary icon={HardDrive} label={t('storedBackupSize')} value={formatBytes(totalBytes, locale)} /></section>
      {role !== 'viewer' ? <form onSubmit={create} className={`${panelClass} grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:p-6 xl:grid-cols-12 xl:items-end`}><Field label={t('stack')} className="xl:col-span-5"><select required value={stackId} onChange={(event) => setStackId(event.target.value)} className={inputClass}><option value="">{t('chooseStack')}</option>{stacks.map((stack) => <option key={stack.id} value={stack.id} disabled={!stack.enabled}>{stack.name}</option>)}</select></Field><div className="xl:col-span-5"><p className="pb-2 text-xs font-extrabold">{t('backupTarget')}</p><div role="radiogroup" className="grid grid-cols-2 gap-2"><Target active={target === 'local'} icon={HardDrive} label={t('localTarget')} onClick={() => setTarget('local')} /><Target active={target === 'nas'} icon={Network} label={t('nasTarget')} onClick={() => setTarget('nas')} /></div></div><button disabled={busy === 'create' || stacks.length === 0} className={`${primaryButton} xl:col-span-2`}><DatabaseBackup size={16} />{t('createBackup')}</button></form> : <Notice>{t('backupViewerNotice')}</Notice>}
      {confirming && <section role="alertdialog" aria-modal="false" aria-labelledby="restore-confirm-title" className="rounded-[1.4rem] border border-amber-400/40 bg-amber-500/10 p-5 sm:p-6"><div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-300" size={21} /><div className="min-w-0 flex-1"><h2 id="restore-confirm-title" className="font-black text-ink-900 dark:text-white">{t('confirmRestoreTitle')}</h2><p className="pt-2 text-sm font-semibold leading-6 text-stone-600 dark:text-stone-300">{t('confirmRestoreDescription')} <strong>{confirmingStack?.name || t('unknown')}</strong> <bdi dir="ltr" className="break-all font-mono">#{confirming.id}</bdi></p><p className="pt-2 text-xs font-bold text-amber-700 dark:text-amber-300">{t('restoreWarning')}</p><div className="flex flex-col-reverse gap-2 pt-5 sm:flex-row sm:justify-end"><button type="button" disabled={busy !== ''} className={secondaryButton} onClick={() => setConfirming(null)}>{t('cancel')}</button><button type="button" disabled={busy !== ''} className={primaryButton} onClick={() => void restore()}><RotateCcw size={16} />{t('confirmRestore')}</button></div></div></div></section>}
      <div className="flex items-center justify-between gap-3"><h2 className="flex items-center gap-2 text-lg font-black text-ink-900 dark:text-white"><Archive className="text-mint-500 dark:text-mint-300" size={19} />{t('backupHistory')}</h2>{active && <span role="status" className="flex items-center gap-2 text-xs font-bold text-stone-400"><RefreshCw className="animate-spin" size={14} />{t('operationsActive')}</span>}</div>
      {backups.length === 0 ? <Empty t={t} /> : <section className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">{backups.map((backup) => <BackupCard key={backup.id} backup={backup} stack={stacks.find((stack) => stack.id === backup.stackId)} locale={locale} role={role} t={t} busy={busy} confirm={() => setConfirming(backup)} />)}</section>}
      <h2 className="flex items-center gap-2 text-lg font-black text-ink-900 dark:text-white"><RotateCcw className="text-mint-500 dark:text-mint-300" size={19} />{t('restoreHistory')}</h2>
      {restores.length === 0 ? <div className={`${panelClass} p-6 text-center text-sm font-bold text-stone-400`}>{t('noRestores')}</div> : <section className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">{restores.map((restore) => <RestoreCard key={restore.id} restore={restore} backup={backups.find((backup) => backup.id === restore.backupId)} stack={stacks.find((stack) => stack.id === restore.stackId)} locale={locale} t={t} />)}</section>}
    </>}
  </div>
}

function RestoreCard({ restore, backup, stack, locale, t }: { restore: StackRestore; backup?: StackBackup; stack?: ManagedStack; locale: Locale; t: Translate }) {
  return <article className={`${panelClass} min-w-0 p-5 sm:p-6`}><div className="flex items-start justify-between gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-600 dark:text-amber-300"><RotateCcw size={20} /></span><OperationStatusPill status={restore.status} t={t} /></div><h3 className="truncate pt-4 text-base font-black text-ink-900 dark:text-white">{stack?.name || t('unknown')}</h3><bdi dir="ltr" className="block truncate pt-1 font-mono text-[0.65rem] text-stone-400">#{restore.id}</bdi><div className="grid grid-cols-2 gap-3 pt-5"><Meta label={t('backupHistory')} value={backup ? `#${backup.id}` : t('unknown')} ltr /><Meta label={t('createdAt')} value={formatDate(restore.createdAt, locale)} /><Meta label={t('completedAt')} value={restore.completedAt ? formatDate(restore.completedAt, locale) : t('notCompleted')} /></div></article>
}

function BackupCard({ backup, stack, locale, role, t, busy, confirm }: { backup: StackBackup; stack?: ManagedStack; locale: Locale; role: Role; t: Translate; busy: string; confirm: () => void }) {
  return <article className={`${panelClass} flex min-w-0 flex-col p-5 sm:p-6`}><div className="flex items-start justify-between gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-mint-400/10 text-mint-500 dark:text-mint-300"><DatabaseBackup size={21} /></span><OperationStatusPill status={backup.status} t={t} /></div><h3 className="truncate pt-4 text-base font-black text-ink-900 dark:text-white">{stack?.name || t('unknown')}</h3><bdi dir="ltr" className="block truncate pt-1 font-mono text-[0.65rem] text-stone-400">#{backup.id}</bdi><div className="grid grid-cols-2 gap-3 pt-5"><Meta label={t('backupTarget')} value={t(backup.target === 'local' ? 'localTarget' : 'nasTarget')} /><Meta label={t('revision')} value={`#${backup.stackRevision}`} ltr /><Meta label={t('createdAt')} value={formatDate(backup.createdAt, locale)} /><Meta label={t('completedAt')} value={backup.completedAt ? formatDate(backup.completedAt, locale) : t('notCompleted')} /></div>
    {backup.result && <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-stone-200/70 pt-4 mt-4 dark:border-white/[0.06]">{typeof backup.result.sizeBytes === 'number' && <Result label={t('backupSize')} value={formatBytes(backup.result.sizeBytes, locale)} />}{typeof backup.result.fileCount === 'number' && <Result label={t('fileCount')} value={formatNumber(backup.result.fileCount, locale)} />}{typeof backup.result.durationMs === 'number' && <Result label={t('duration')} value={formatDuration(backup.result.durationMs, locale)} />}{backup.result.checksum && <Result label={t('checksum')} value={backup.result.checksum} ltr />}{backup.result.message && <Result label={t('resultMessage')} value={backup.result.message} wide />}</div>}
    {role === 'owner' && backup.status === 'succeeded' && <button type="button" disabled={busy !== ''} onClick={confirm} className={`${secondaryButton} mt-5 w-full`}><RotateCcw size={15} />{t('restoreBackup')}</button>}
  </article>
}

function Summary({ icon: Icon, label, value }: { icon: typeof Archive; label: string; value: string }) { return <article className={`${panelClass} min-w-0 p-4 sm:p-5`}><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="text-[0.68rem] font-bold text-stone-400">{label}</p><bdi dir="ltr" className="block truncate pt-2 text-2xl font-black text-ink-900 dark:text-white sm:text-3xl">{value}</bdi></div><Icon className="shrink-0 text-mint-500 dark:text-mint-300" size={20} /></div></article> }
function Target({ active, icon: Icon, label, onClick }: { active: boolean; icon: typeof HardDrive; label: string; onClick: () => void }) { return <button type="button" role="radio" aria-checked={active} onClick={onClick} className={`flex min-h-12 items-center justify-center gap-2 rounded-xl border px-3 text-xs font-extrabold transition ${active ? 'border-mint-400 bg-mint-400/10 text-ink-900 ring-2 ring-mint-400/10 dark:text-white' : 'border-stone-200 bg-white dark:border-white/10 dark:bg-white/5'}`}><Icon size={16} />{label}</button> }
function OperationStatusPill({ status, t }: { status: OperationStatus; t: Translate }) { const styles = status === 'succeeded' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : status === 'failed' ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'; return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.65rem] font-extrabold ${styles}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{t(status)}</span> }
function Field({ label, className = '', children }: { label: string; className?: string; children: React.ReactNode }) { return <label className={`flex min-w-0 flex-col gap-2 ${className}`}><span className="text-xs font-extrabold text-ink-800 dark:text-stone-100">{label}</span>{children}</label> }
function Meta({ label, value, ltr = false }: { label: string; value: string; ltr?: boolean }) { return <div className="min-w-0 rounded-xl bg-stone-100/70 p-3 dark:bg-white/[0.03]"><span className="block text-[0.62rem] font-bold text-stone-400">{label}</span><bdi dir={ltr ? 'ltr' : undefined} className="block truncate pt-1 text-xs font-bold text-ink-800 dark:text-stone-200">{value}</bdi></div> }
function Result({ label, value, ltr = false, wide = false }: { label: string; value: string; ltr?: boolean; wide?: boolean }) { return <div className={`min-w-0 ${wide ? 'col-span-2' : ''}`}><span className="block text-[0.62rem] font-bold text-stone-400">{label}</span><bdi dir={ltr ? 'ltr' : undefined} className="block truncate pt-1 text-xs font-semibold text-stone-600 dark:text-stone-300" title={value}>{value}</bdi></div> }
function Alert({ children }: { children: React.ReactNode }) { return <div role="alert" className="flex items-start gap-2 rounded-xl bg-rose-500/10 px-3.5 py-3 text-xs font-bold leading-5 text-rose-700 dark:text-rose-300"><TriangleAlert className="mt-0.5 shrink-0" size={15} />{children}</div> }
function Notice({ children }: { children: React.ReactNode }) { return <div className="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3.5 py-3 text-xs font-bold leading-5 text-amber-700 dark:text-amber-300"><TriangleAlert className="mt-0.5 shrink-0" size={15} />{children}</div> }
function Success({ children }: { children: React.ReactNode }) { return <div role="status" className="flex items-start gap-2 rounded-xl bg-emerald-500/10 px-3.5 py-3 text-xs font-bold text-emerald-700 dark:text-emerald-300"><CheckCircle2 size={15} />{children}</div> }
function Loading({ t }: { t: Translate }) { return <div role="status" className={`${panelClass} flex items-center justify-center gap-3 p-8 text-sm font-bold text-stone-400`}><RefreshCw className="animate-spin" size={18} />{t('loadingData')}</div> }
function Empty({ t }: { t: Translate }) { return <div className={`${panelClass} flex min-h-52 flex-col items-center justify-center p-10 text-center`}><Server className="text-stone-300 dark:text-stone-600" size={31} /><p className="pt-3 text-sm font-bold text-stone-400">{t('noBackups')}</p></div> }
function formatNumber(value: number, locale: Locale) { return new Intl.NumberFormat(locale).format(value) }
function formatBytes(value: number, locale: Locale) { if (!Number.isFinite(value) || value < 0) return '—'; const units = ['B', 'KB', 'MB', 'GB', 'TB']; const index = value === 0 ? 0 : Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1); return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / 1024 ** index)} ${units[index]}` }
function formatDuration(milliseconds: number, locale: Locale) { return new Intl.NumberFormat(locale, { style: 'unit', unit: milliseconds >= 60_000 ? 'minute' : 'second', unitDisplay: 'short', maximumFractionDigits: 1 }).format(milliseconds / (milliseconds >= 60_000 ? 60_000 : 1_000)) }
function formatDate(value: string, locale: Locale) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date) }
function friendlyError(error: unknown, t: Translate) { if (error instanceof ApiError) { if (error.status === 403) return t('forbidden'); if (error.status === 409) return t('conflict'); if (error.status === 400) return t('validationError') } return t('requestFailed') }
