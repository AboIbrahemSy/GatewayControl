import { Archive, CheckCircle2, Clipboard, DatabaseBackup, Eye, EyeOff, HardDrive, KeyRound, Network, RefreshCw, RotateCcw, Server, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, ApiError, type ManagedStack, type OperationStatus, type Role, type StackBackup, type StackRestore, type SystemBackup, type SystemRestore } from './api'
import type { Locale, MessageKey, Translate } from './App'
import { copyText } from './clipboard'
import { Modal } from './Modal'

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
  const [createOpen, setCreateOpen] = useState(false)
  const [confirming, setConfirming] = useState<StackBackup | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [systemBackups, setSystemBackups] = useState<SystemBackup[]>([])
  const [systemRestores, setSystemRestores] = useState<SystemRestore[]>([])
  const [systemLoading, setSystemLoading] = useState(role === 'owner')
  const [systemError, setSystemError] = useState('')
  const [systemModalError, setSystemModalError] = useState('')
  const [systemCreateOpen, setSystemCreateOpen] = useState(false)
  const [systemRestoreBackup, setSystemRestoreBackup] = useState<SystemBackup | null>(null)
  const [systemTarget, setSystemTarget] = useState<SystemBackup['target']>('local')
  const [passphrase, setPassphrase] = useState('')
  const [passphraseConfirmation, setPassphraseConfirmation] = useState('')
  const [passphraseVisible, setPassphraseVisible] = useState(false)
  const [confirmationVisible, setConfirmationVisible] = useState(false)
  const [passphraseCopied, setPassphraseCopied] = useState(false)
  const [restoreCommand, setRestoreCommand] = useState('')
  const [restoreCommandCopied, setRestoreCommandCopied] = useState(false)

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

  async function loadSystem(background = false) {
    if (role !== 'owner') return
    if (!background) setSystemLoading(true)
    setSystemError('')
    try {
      const result = await api.systemBackups()
      setSystemBackups(result.backups)
      setSystemRestores(result.restores)
    } catch { setSystemError(t('systemRecoveryLoadFailed')) }
    finally { setSystemLoading(false) }
  }

  useEffect(() => { void load(); void loadSystem() }, [])
  const active = [...backups, ...restores].some((operation) => operation.status === 'pending' || operation.status === 'running')
  const systemActive = systemBackups.some((backup) => backup.status === 'running')
  useEffect(() => {
    if (!active && !systemActive) return
    const timer = window.setInterval(() => { if (active) void load(true); if (systemActive) void loadSystem(true) }, 5_000)
    return () => window.clearInterval(timer)
  }, [active, systemActive])

  async function create(event: React.FormEvent) {
    event.preventDefault()
    if (!stackId) { setError(t('chooseStack')); return }
    setBusy('create'); setError(''); setSuccess('')
    try {
      const result = await api.createBackup(stackId, target)
      setBackups((current) => [result.backup, ...current])
      setSuccess(t('backupQueued')); setTarget('local'); setCreateOpen(false)
    } catch (caught) { setError(friendlyError(caught, t)) }
    finally { setBusy('') }
  }

  async function restore() {
    if (!confirming) return
    setBusy(`restore:${confirming.id}`); setError(''); setSuccess('')
    try {
      const result = await api.restoreBackup(confirming.id)
      setRestores((current) => [result.restore, ...current])
      setSuccess(t('restoreQueued')); setConfirming(null)
    } catch (caught) { setError(friendlyError(caught, t)) }
    finally { setBusy('') }
  }

  function resetSystemModal() { setPassphrase(''); setPassphraseConfirmation(''); setPassphraseVisible(false); setConfirmationVisible(false); setPassphraseCopied(false); setSystemModalError('') }
  function openSystemCreate() { resetSystemModal(); setSystemCreateOpen(true) }
  function openSystemRestore(backup: SystemBackup) { resetSystemModal(); setSystemRestoreBackup(backup) }

  function generatePassphrase() {
    const generated = generateSecurePassphrase()
    setPassphrase(generated)
    setPassphraseConfirmation('')
    setPassphraseVisible(true)
    setConfirmationVisible(false)
    setPassphraseCopied(false)
    void copyText(generated).then(() => setPassphraseCopied(true)).catch(() => setSystemModalError(t('passphraseCopyFailed')))
  }

  async function copyPassphrase() {
    if (!passphrase) return
    try {
      await copyText(passphrase)
      setPassphraseCopied(true)
      window.setTimeout(() => setPassphraseCopied(false), 2_000)
    } catch {
      setSystemModalError(t('passphraseCopyFailed'))
    }
  }

  async function createSystemBackup(event: React.FormEvent) {
    event.preventDefault()
    if (passphrase.length < 16 || passphrase !== passphraseConfirmation) { setSystemModalError(t(passphrase.length < 16 ? 'systemPassphraseTooShort' : 'passwordsMismatch')); return }
    setBusy('system-create'); setSystemModalError(''); setSuccess('')
    try {
      const result = await api.createSystemBackup(systemTarget, passphrase)
      setSystemBackups((current) => [result.backup, ...current])
      setSuccess(t('systemBackupCreated')); setSystemCreateOpen(false); setSystemTarget('local'); resetSystemModal()
    } catch (caught) { setSystemModalError(systemRecoveryError(caught, t)) }
    finally { setBusy('') }
  }

  async function stageSystemRestore(event: React.FormEvent) {
    event.preventDefault()
    if (!systemRestoreBackup || passphrase.length < 16) { setSystemModalError(t('systemPassphraseTooShort')); return }
    setBusy('system-restore'); setSystemModalError(''); setSuccess('')
    try {
      const result = await api.stageSystemRestore(systemRestoreBackup.id, passphrase)
      setSystemRestores((current) => [result.restore, ...current])
      setSuccess(t('systemRestoreStagedManual')); setRestoreCommand(result.restoreCommand); setRestoreCommandCopied(false); setSystemRestoreBackup(null); resetSystemModal()
    } catch (caught) { setSystemModalError(systemRecoveryError(caught, t)) }
    finally { setBusy('') }
  }

  const succeeded = backups.filter((backup) => backup.status === 'succeeded').length
  const failed = backups.filter((backup) => backup.status === 'failed').length
  const totalBytes = backups.reduce((sum, backup) => sum + (backup.result?.sizeBytes || 0), 0)
  const confirmingStack = confirming ? stacks.find((stack) => stack.id === confirming.stackId) : undefined

  return <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-6">
    <section className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end"><div className="max-w-3xl"><span className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.14em] text-mint-500 dark:text-mint-300"><DatabaseBackup size={15} />GatewayControl</span><h1 className="pt-2 text-3xl font-black tracking-[-0.045em] text-ink-900 dark:text-white sm:text-4xl">{t('backupsTitle')}</h1><p className="max-w-2xl pt-2 text-sm font-medium leading-6 text-stone-500 dark:text-stone-400 sm:text-base">{t('backupsDescription')}</p></div><div className="flex flex-col-reverse gap-2 sm:flex-row">{role !== 'viewer' && <button type="button" disabled={loading || stacks.length === 0} className={primaryButton} onClick={() => setCreateOpen(true)}><DatabaseBackup size={16} />{t('createBackup')}</button>}<button type="button" className={secondaryButton} onClick={() => { void load(); void loadSystem() }}><RefreshCw size={15} />{t('refresh')}</button></div></section>
    {error && <Alert>{error}</Alert>}{success && <Success>{success}</Success>}
    {restoreCommand && <section className={`${panelClass} flex min-w-0 flex-col gap-3 p-4 sm:p-5`}><p className="text-xs font-bold text-amber-700 dark:text-amber-300">{t('systemRestoreStagedManual')}</p><pre dir="ltr" className="overflow-x-auto whitespace-pre-wrap break-all rounded-xl bg-ink-950 p-4 text-left font-mono text-xs text-mint-100"><code>{restoreCommand}</code></pre><button type="button" className={`${secondaryButton} self-end`} onClick={() => void copyText(restoreCommand).then(() => setRestoreCommandCopied(true)).catch(() => setError(t('copyFailed')))}><Clipboard size={15} />{t(restoreCommandCopied ? 'copied' : 'copy')}</button></section>}
    {loading ? <Loading t={t} /> : <>
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4"><Summary icon={Archive} label={t('totalBackups')} value={formatNumber(backups.length, locale)} /><Summary icon={CheckCircle2} label={t('succeededBackups')} value={formatNumber(succeeded, locale)} /><Summary icon={TriangleAlert} label={t('failedBackups')} value={formatNumber(failed, locale)} /><Summary icon={HardDrive} label={t('storedBackupSize')} value={formatBytes(totalBytes, locale)} /></section>
      {role === 'owner' && <SystemRecoveryPanel t={t} locale={locale} loading={systemLoading} error={systemError} backups={systemBackups} restores={systemRestores} openCreate={openSystemCreate} openRestore={openSystemRestore} />}
      {role !== 'viewer' ? <Modal open={createOpen} title={t('createBackup')} description={t('backupsDescription')} closeLabel={t('cancel')} busy={busy === 'create'} onClose={() => { setTarget('local'); setCreateOpen(false); setError('') }}><form onSubmit={create} className="grid grid-cols-1 items-start gap-5 p-5 sm:grid-cols-2 sm:p-6"><Field label={t('stack')}><select required value={stackId} onChange={(event) => setStackId(event.target.value)} className={inputClass}><option value="">{t('chooseStack')}</option>{stacks.map((stack) => <option key={stack.id} value={stack.id} disabled={!stack.enabled}>{stack.name}</option>)}</select></Field><div><p className="pb-2 text-xs font-extrabold">{t('backupTarget')}</p><div role="radiogroup" aria-label={t('backupTarget')} className="grid grid-cols-2 gap-2"><Target active={target === 'local'} icon={HardDrive} label={t('localTarget')} onClick={() => setTarget('local')} /><Target active={target === 'nas'} icon={Network} label={t('nasTarget')} onClick={() => setTarget('nas')} /></div></div><button disabled={busy === 'create' || stacks.length === 0} className={`${primaryButton} sm:col-span-2`}><DatabaseBackup size={16} />{t('createBackup')}</button></form></Modal> : <Notice>{t('backupViewerNotice')}</Notice>}
      {confirming && <section role="alertdialog" aria-modal="false" aria-labelledby="restore-confirm-title" className="rounded-[1.4rem] border border-amber-400/40 bg-amber-500/10 p-5 sm:p-6"><div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-300" size={21} /><div className="min-w-0 flex-1"><h2 id="restore-confirm-title" className="font-black text-ink-900 dark:text-white">{t('confirmRestoreTitle')}</h2><p className="pt-2 text-sm font-semibold leading-6 text-stone-600 dark:text-stone-300">{t('confirmRestoreDescription')} <strong>{confirmingStack?.name || t('unknown')}</strong> <bdi dir="ltr" className="break-all font-mono">#{confirming.id}</bdi></p><p className="pt-2 text-xs font-bold text-amber-700 dark:text-amber-300">{t('restoreWarning')}</p><div className="flex flex-col-reverse gap-2 pt-5 sm:flex-row sm:justify-end"><button type="button" disabled={busy !== ''} className={secondaryButton} onClick={() => setConfirming(null)}>{t('cancel')}</button><button type="button" disabled={busy !== ''} className={primaryButton} onClick={() => void restore()}><RotateCcw size={16} />{t('confirmRestore')}</button></div></div></div></section>}
      <div className="flex items-center justify-between gap-3"><h2 className="flex items-center gap-2 text-lg font-black text-ink-900 dark:text-white"><Archive className="text-mint-500 dark:text-mint-300" size={19} />{t('backupHistory')}</h2>{active && <span role="status" className="flex items-center gap-2 text-xs font-bold text-stone-400"><RefreshCw className="animate-spin" size={14} />{t('operationsActive')}</span>}</div>
      {backups.length === 0 ? <Empty t={t} /> : <section className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">{backups.map((backup) => <BackupCard key={backup.id} backup={backup} stack={stacks.find((stack) => stack.id === backup.stackId)} locale={locale} role={role} t={t} busy={busy} confirm={() => setConfirming(backup)} />)}</section>}
      <h2 className="flex items-center gap-2 text-lg font-black text-ink-900 dark:text-white"><RotateCcw className="text-mint-500 dark:text-mint-300" size={19} />{t('restoreHistory')}</h2>
      {restores.length === 0 ? <div className={`${panelClass} p-6 text-center text-sm font-bold text-stone-400`}>{t('noRestores')}</div> : <section className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">{restores.map((item) => <RestoreCard key={item.id} restore={item} backup={backups.find((backup) => backup.id === item.backupId)} stack={stacks.find((stack) => stack.id === item.stackId)} locale={locale} t={t} />)}</section>}
    </>}
    {role === 'owner' && <Modal open={systemCreateOpen} title={t('createSystemBackup')} description={t('systemRecoveryScopeDescription')} closeLabel={t('cancel')} busy={busy === 'system-create'} maxWidthClass="max-w-xl" onClose={() => { setSystemCreateOpen(false); setSystemTarget('local'); resetSystemModal() }}>
      <form onSubmit={createSystemBackup} className="flex flex-col gap-5 p-5 sm:p-6">
        {systemModalError && <Alert>{systemModalError}</Alert>}
        <div><p className="pb-2 text-xs font-extrabold">{t('backupTarget')}</p><div role="radiogroup" aria-label={t('backupTargetLabel')} className="grid grid-cols-2 gap-2"><Target active={systemTarget === 'local'} icon={HardDrive} label={t('localTarget')} onClick={() => setSystemTarget('local')} /><Target active={systemTarget === 'nas'} icon={Network} label={t('nasTarget')} onClick={() => setSystemTarget('nas')} /></div></div>
        <PassphraseField label={t('systemPassphrase')} value={passphrase} visible={passphraseVisible} showLabel={t('showPassphrase')} hideLabel={t('hidePassphrase')} onChange={(value) => { setPassphrase(value); setPassphraseCopied(false) }} toggleVisibility={() => setPassphraseVisible((current) => !current)} />
        <PassphraseField label={t('systemPassphraseConfirmation')} value={passphraseConfirmation} visible={confirmationVisible} showLabel={t('showPassphrase')} hideLabel={t('hidePassphrase')} onChange={setPassphraseConfirmation} toggleVisibility={() => setConfirmationVisible((current) => !current)} />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button type="button" className={secondaryButton} onClick={generatePassphrase}><Sparkles size={16} />{t('generatePassphrase')}</button>
          <button type="button" disabled={!passphrase} className={secondaryButton} onClick={() => void copyPassphrase()}><Clipboard size={16} />{t(passphraseCopied ? 'copied' : 'copyPassphrase')}</button>
        </div>
        <Notice>{t('generatedPassphraseConfirmation')}</Notice>
        <p className="text-xs font-semibold leading-5 text-stone-500 dark:text-stone-400">{t('systemPassphraseNotice')}</p>
        <button disabled={busy !== ''} className={primaryButton}><KeyRound size={16} />{t('createSystemBackup')}</button>
      </form>
    </Modal>}
    {role === 'owner' && <Modal open={systemRestoreBackup !== null} title={t('stageSystemRestore')} description={t('systemRecoveryScopeDescription')} closeLabel={t('cancel')} busy={busy === 'system-restore'} maxWidthClass="max-w-xl" onClose={() => { setSystemRestoreBackup(null); resetSystemModal() }}>
      <form onSubmit={stageSystemRestore} className="flex flex-col gap-5 p-5 sm:p-6">
        {systemModalError && <Alert>{systemModalError}</Alert>}
        <Notice>{t('systemRestoreDestructiveWarning')}</Notice>
        <bdi dir="ltr" className="break-all rounded-xl bg-stone-100 p-3 font-mono text-xs dark:bg-white/[0.04]">#{systemRestoreBackup?.id}</bdi>
        <PassphraseField label={t('systemPassphrase')} value={passphrase} visible={passphraseVisible} showLabel={t('showPassphrase')} hideLabel={t('hidePassphrase')} onChange={setPassphrase} toggleVisibility={() => setPassphraseVisible((current) => !current)} />
        <button disabled={busy !== ''} className={primaryButton}><RotateCcw size={16} />{t('confirmStageSystemRestore')}</button>
      </form>
    </Modal>}
  </div>
}

function SystemRecoveryPanel({ t, locale, loading, error, backups, restores, openCreate, openRestore }: { t: Translate; locale: Locale; loading: boolean; error: string; backups: SystemBackup[]; restores: SystemRestore[]; openCreate: () => void; openRestore: (backup: SystemBackup) => void }) {
  return <section className="flex flex-col gap-4 rounded-[1.4rem] border border-mint-400/30 bg-mint-400/[0.06] p-4 dark:border-mint-300/20 dark:bg-mint-300/[0.04] sm:p-6"><div className="flex flex-col justify-between gap-4 md:flex-row md:items-start"><div className="max-w-3xl"><h2 className="flex items-center gap-2 text-xl font-black text-ink-900 dark:text-white"><ShieldCheck className="text-mint-500 dark:text-mint-300" size={21} />{t('systemRecoveryTitle')}</h2><p className="pt-2 text-sm font-medium leading-6 text-stone-600 dark:text-stone-300">{t('systemRecoveryScopeDescription')}</p><p className="pt-2 text-xs font-bold leading-5 text-amber-700 dark:text-amber-300">{t('manualSystemRestoreRequired')}</p><bdi dir="ltr" className="mt-2 block break-all font-mono text-[0.7rem] text-stone-500 dark:text-stone-400">sh docker/recover.sh</bdi></div><button type="button" className={`${primaryButton} shrink-0`} onClick={openCreate}><KeyRound size={16} />{t('createSystemBackup')}</button></div>
    {error && <Alert>{error}</Alert>}
    {loading ? <Loading t={t} /> : <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">{backups.length === 0 ? <div className={`${panelClass} p-5 text-sm font-bold text-stone-400`}>{t('noSystemBackups')}</div> : backups.map((backup) => <article key={backup.id} className={`${panelClass} min-w-0 p-4 sm:p-5`}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><bdi dir="ltr" className="block truncate font-mono text-[0.68rem] text-stone-400">#{backup.id}</bdi><p className="pt-2 text-xs font-bold text-stone-500 dark:text-stone-300">{t(backup.target === 'local' ? 'localTarget' : 'nasTarget')} · {formatDate(backup.createdAt, locale)}</p></div><SystemStatus status={backup.status} t={t} /></div>{backup.sizeBytes !== null && <p className="pt-3 text-xs font-bold text-stone-500 dark:text-stone-300">{t('backupSize')}: <bdi dir="ltr">{formatBytes(backup.sizeBytes, locale)}</bdi></p>}{backup.status === 'failed' && <p className="pt-3 text-xs font-bold text-rose-600 dark:text-rose-300">{t('systemBackupFailedHelp')}</p>}{backup.status === 'succeeded' && <button type="button" className={`${secondaryButton} mt-4 w-full`} onClick={() => openRestore(backup)}><RotateCcw size={15} />{t('stageSystemRestore')}</button>}</article>)}</div>}
    <div><h3 className="pb-3 text-sm font-black text-ink-900 dark:text-white">{t('systemRestoreHistory')}</h3>{restores.length === 0 ? <p className="text-xs font-bold text-stone-400">{t('noRestores')}</p> : <div className="grid grid-cols-1 gap-2 md:grid-cols-2">{restores.map((restore) => <div key={restore.id} className={`${panelClass} p-3 text-xs`}><div className="flex items-center justify-between gap-2"><bdi dir="ltr" className="truncate font-mono text-stone-400">#{restore.backupId}</bdi><span className="font-extrabold">{t(restore.status)}</span></div>{restore.status === 'failed' && <p className="pt-2 font-bold text-rose-600 dark:text-rose-300">{t('systemRestoreFailedHelp')}</p>}</div>)}</div>}</div>
  </section>
}

function RestoreCard({ restore, backup, stack, locale, t }: { restore: StackRestore; backup?: StackBackup; stack?: ManagedStack; locale: Locale; t: Translate }) { return <article className={`${panelClass} min-w-0 p-5 sm:p-6`}><div className="flex items-start justify-between gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-600 dark:text-amber-300"><RotateCcw size={20} /></span><OperationStatusPill status={restore.status} t={t} /></div><h3 className="truncate pt-4 text-base font-black text-ink-900 dark:text-white">{stack?.name || t('unknown')}</h3><bdi dir="ltr" className="block truncate pt-1 font-mono text-[0.65rem] text-stone-400">#{restore.id}</bdi><div className="grid grid-cols-2 gap-3 pt-5"><Meta label={t('backupHistory')} value={backup ? `#${backup.id}` : t('unknown')} ltr /><Meta label={t('createdAt')} value={formatDate(restore.createdAt, locale)} /><Meta label={t('completedAt')} value={restore.completedAt ? formatDate(restore.completedAt, locale) : t('notCompleted')} /></div></article> }
function BackupCard({ backup, stack, locale, role, t, busy, confirm }: { backup: StackBackup; stack?: ManagedStack; locale: Locale; role: Role; t: Translate; busy: string; confirm: () => void }) { return <article className={`${panelClass} flex min-w-0 flex-col p-5 sm:p-6`}><div className="flex items-start justify-between gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-mint-400/10 text-mint-500 dark:text-mint-300"><DatabaseBackup size={21} /></span><OperationStatusPill status={backup.status} t={t} /></div><h3 className="truncate pt-4 text-base font-black text-ink-900 dark:text-white">{stack?.name || t('unknown')}</h3><bdi dir="ltr" className="block truncate pt-1 font-mono text-[0.65rem] text-stone-400">#{backup.id}</bdi><div className="grid grid-cols-2 gap-3 pt-5"><Meta label={t('backupTarget')} value={t(backup.target === 'local' ? 'localTarget' : 'nasTarget')} /><Meta label={t('revision')} value={`#${backup.stackRevision}`} ltr /><Meta label={t('createdAt')} value={formatDate(backup.createdAt, locale)} /><Meta label={t('completedAt')} value={backup.completedAt ? formatDate(backup.completedAt, locale) : t('notCompleted')} /></div>{backup.result && <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-stone-200/70 pt-4 dark:border-white/[0.06]">{typeof backup.result.sizeBytes === 'number' && <Result label={t('backupSize')} value={formatBytes(backup.result.sizeBytes, locale)} />}{typeof backup.result.fileCount === 'number' && <Result label={t('fileCount')} value={formatNumber(backup.result.fileCount, locale)} />}{backup.result.checksum && <Result label={t('checksum')} value={backup.result.checksum} ltr />}</div>}{role === 'owner' && backup.status === 'succeeded' && <button type="button" disabled={busy !== ''} onClick={confirm} className={`${secondaryButton} mt-5 w-full`}><RotateCcw size={15} />{t('restoreBackup')}</button>}</article> }
function Summary({ icon: Icon, label, value }: { icon: typeof Archive; label: string; value: string }) { return <article className={`${panelClass} min-w-0 p-4 sm:p-5`}><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="text-[0.68rem] font-bold text-stone-400">{label}</p><bdi dir="ltr" className="block truncate pt-2 text-2xl font-black text-ink-900 dark:text-white sm:text-3xl">{value}</bdi></div><Icon className="shrink-0 text-mint-500 dark:text-mint-300" size={20} /></div></article> }
function Target({ active, icon: Icon, label, onClick }: { active: boolean; icon: typeof HardDrive; label: string; onClick: () => void }) { return <button type="button" role="radio" aria-checked={active} onClick={onClick} className={`flex min-h-12 items-center justify-center gap-2 rounded-xl border px-3 text-xs font-extrabold transition ${active ? 'border-mint-400 bg-mint-400/10 text-ink-900 ring-2 ring-mint-400/10 dark:text-white' : 'border-stone-200 bg-white dark:border-white/10 dark:bg-white/5'}`}><Icon size={16} />{label}</button> }
function PassphraseField({ label, value, visible, showLabel, hideLabel, onChange, toggleVisibility }: { label: string; value: string; visible: boolean; showLabel: string; hideLabel: string; onChange: (value: string) => void; toggleVisibility: () => void }) { return <div className="flex min-w-0 flex-col gap-2"><span className="text-xs font-extrabold text-ink-800 dark:text-stone-100">{label}</span><div className="relative"><input aria-label={label} dir="ltr" type={visible ? 'text' : 'password'} required minLength={16} maxLength={1024} autoComplete="new-password" value={value} onChange={(event) => onChange(event.target.value)} className={`${inputClass} pe-14 text-left font-mono`} /><button type="button" aria-label={visible ? hideLabel : showLabel} title={visible ? hideLabel : showLabel} onClick={toggleVisibility} className="absolute end-1 top-1 flex h-10 w-10 items-center justify-center rounded-lg text-stone-500 transition hover:bg-stone-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-mint-400/20 dark:text-stone-300 dark:hover:bg-white/5">{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></div> }
function OperationStatusPill({ status, t }: { status: OperationStatus; t: Translate }) { const styles = status === 'succeeded' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : status === 'failed' ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'; return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.65rem] font-extrabold ${styles}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{t(status)}</span> }
function SystemStatus({ status, t }: { status: SystemBackup['status']; t: Translate }) { return <span className={`shrink-0 rounded-full px-2.5 py-1 text-[0.65rem] font-extrabold ${status === 'succeeded' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : status === 'failed' ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'}`}>{t(status)}</span> }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="flex min-w-0 flex-col gap-2"><span className="text-xs font-extrabold text-ink-800 dark:text-stone-100">{label}</span>{children}</label> }
function Meta({ label, value, ltr = false }: { label: string; value: string; ltr?: boolean }) { return <div className="min-w-0 rounded-xl bg-stone-100/70 p-3 dark:bg-white/[0.03]"><span className="block text-[0.62rem] font-bold text-stone-400">{label}</span><bdi dir={ltr ? 'ltr' : undefined} className="block truncate pt-1 text-xs font-bold text-ink-800 dark:text-stone-200">{value}</bdi></div> }
function Result({ label, value, ltr = false }: { label: string; value: string; ltr?: boolean }) { return <div className="min-w-0"><span className="block text-[0.62rem] font-bold text-stone-400">{label}</span><bdi dir={ltr ? 'ltr' : undefined} className="block truncate pt-1 text-xs font-semibold text-stone-600 dark:text-stone-300" title={value}>{value}</bdi></div> }
function Alert({ children }: { children: React.ReactNode }) { return <div role="alert" className="flex items-start gap-2 rounded-xl bg-rose-500/10 px-3.5 py-3 text-xs font-bold leading-5 text-rose-700 dark:text-rose-300"><TriangleAlert className="mt-0.5 shrink-0" size={15} />{children}</div> }
function Notice({ children }: { children: React.ReactNode }) { return <div className="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3.5 py-3 text-xs font-bold leading-5 text-amber-700 dark:text-amber-300"><TriangleAlert className="mt-0.5 shrink-0" size={15} />{children}</div> }
function Success({ children }: { children: React.ReactNode }) { return <div role="status" className="flex items-start gap-2 rounded-xl bg-emerald-500/10 px-3.5 py-3 text-xs font-bold text-emerald-700 dark:text-emerald-300"><CheckCircle2 size={15} />{children}</div> }
function Loading({ t }: { t: Translate }) { return <div role="status" className={`${panelClass} flex items-center justify-center gap-3 p-8 text-sm font-bold text-stone-400`}><RefreshCw className="animate-spin" size={18} />{t('loadingData')}</div> }
function Empty({ t }: { t: Translate }) { return <div className={`${panelClass} flex min-h-52 flex-col items-center justify-center p-10 text-center`}><Server className="text-stone-300 dark:text-stone-600" size={31} /><p className="pt-3 text-sm font-bold text-stone-400">{t('noBackups')}</p></div> }
function formatNumber(value: number, locale: Locale) { return new Intl.NumberFormat(locale).format(value) }
function formatBytes(value: number, locale: Locale) { if (!Number.isFinite(value) || value < 0) return '-'; const units = ['B', 'KB', 'MB', 'GB', 'TB']; const index = value === 0 ? 0 : Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1); return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / 1024 ** index)} ${units[index]}` }
function formatDate(value: string, locale: Locale) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '-' : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date) }
function friendlyError(error: unknown, t: Translate) { if (error instanceof ApiError) { if (error.status === 403) return t('forbidden'); if (error.status === 409) return t('conflict'); if (error.status === 400) return t('validationError') } return t('requestFailed') }
function systemRecoveryError(error: unknown, t: Translate) { if (error instanceof ApiError) { const keys: Record<string, MessageKey> = { incorrect_passphrase: 'incorrectPassphrase', nas_unavailable: 'nasUnavailable', restore_already_staged: 'restoreAlreadyStaged', backup_mismatch: 'backupMismatch', invalid_backup: 'invalidBackup' }; if (error.code && keys[error.code]) return t(keys[error.code]) } return friendlyError(error, t) }

function generateSecurePassphrase(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const unbiasedLimit = Math.floor(256 / alphabet.length) * alphabet.length
  let passphrase = ''

  while (passphrase.length < 32) {
    const randomValues = new Uint8Array(32)
    crypto.getRandomValues(randomValues)
    for (const value of randomValues) {
      if (value < unbiasedLimit) passphrase += alphabet[value % alphabet.length]
      if (passphrase.length === 32) break
    }
  }

  return passphrase
}
