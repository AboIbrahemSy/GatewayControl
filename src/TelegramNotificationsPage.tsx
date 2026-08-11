import { Bell, BellOff, Bot, CheckCircle2, RefreshCw, Save, Send, Server, Settings, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, ApiError, type NotificationAgentPreference, type NotificationServicePreference, type NotificationTopology, type Role, type RuntimeServiceStatus } from './api'
import type { Translate } from './App'
import { HelpPopover } from './HelpPopover'
import { Modal } from './Modal'

const panelClass = 'rounded-[1.4rem] border border-stone-200/80 bg-sand-50 shadow-panel dark:border-white/[0.07] dark:bg-ink-900/80'
const inputClass = 'h-12 w-full rounded-xl border border-stone-200 bg-white px-3.5 text-sm font-semibold text-ink-800 outline-none transition focus:border-mint-400 focus:ring-4 focus:ring-mint-400/10 dark:border-white/[0.08] dark:bg-white/[0.035] dark:text-stone-100'
const buttonClass = 'flex min-h-11 items-center justify-center gap-2 rounded-xl border border-stone-200 bg-white px-4 text-xs font-extrabold transition hover:border-mint-400 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/5'
const primaryButton = 'flex min-h-11 items-center justify-center gap-2 rounded-xl bg-ink-900 px-5 text-xs font-extrabold text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-mint-400 dark:text-ink-950'

const notificationEvents = [
  ['agent.offline', 'agentOffline'], ['service.unhealthy', 'serviceUnhealthy'], ['deployment.failed', 'deploymentFailed'], ['deployment.succeeded', 'deploymentSucceeded'],
  ['certificate.expiring', 'certificateExpiring'], ['backup.failed', 'backupFailed'], ['backup.succeeded', 'backupSucceeded'],
  ['runtime.action.succeeded', 'runtimeActionSucceeded'], ['runtime.action.failed', 'runtimeActionFailed'],
] as const

export function TelegramNotificationsPage({ t, role }: { t: Translate; role: Role }) {
  const [topology, setTopology] = useState<NotificationTopology | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [configurationOpen, setConfigurationOpen] = useState(false)
  const [configurationTab, setConfigurationTab] = useState<'connection' | 'events'>('connection')
  const [events, setEvents] = useState<string[]>(notificationEvents.map(([value]) => value))
  const [botToken, setBotToken] = useState('')
  const [groupId, setGroupId] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<string[]>([])
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  async function load() {
    setError('')
    try {
      const result = await api.notificationTopology()
      setTopology(result)
      setEvents(result.selectedEvents)
      setSelectedAgentId((current) => result.agents.some((agent) => agent.id === current) ? current : result.agents[0]?.id || '')
    } catch (caught) { setError(friendlyError(caught, t)) }
    finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [])

  async function toggleAgent(agent: NotificationAgentPreference) {
    if (!topology || role === 'viewer') return
    const key = `agent:${agent.id}`
    const previous = topology
    const enabled = !agent.enabled
    setPending((current) => [...current, key])
    setTopology({ ...topology, agents: topology.agents.map((item) => item.id === agent.id ? effectiveAgent(item, enabled) : item) })
    setError('')
    try {
      const result = await api.setAgentNotifications(agent.id, enabled)
      setTopology((current) => current ? { ...current, agents: current.agents.map((item) => item.id === agent.id ? result.agent : item) } : current)
    } catch (caught) { setTopology(previous); setError(friendlyError(caught, t)) }
    finally { setPending((current) => current.filter((item) => item !== key)) }
  }

  async function toggleService(agent: NotificationAgentPreference, projectName: string, serviceName: string) {
    if (!topology || role === 'viewer') return
    const service = agent.services.find((item) => item.projectName === projectName && item.serviceName === serviceName)
    if (!service) return
    const key = `service:${agent.id}:${projectName}:${serviceName}`
    const previous = topology
    const directlyEnabled = !service.directlyEnabled
    setPending((current) => [...current, key])
    setTopology({ ...topology, agents: topology.agents.map((item) => item.id !== agent.id ? item : { ...item, services: item.services.map((candidate) => candidate.projectName === projectName && candidate.serviceName === serviceName ? { ...candidate, directlyEnabled, enabled: item.enabled && directlyEnabled, inherited: !item.enabled && directlyEnabled } : candidate) }) })
    setError('')
    try {
      const result = await api.setServiceNotifications(agent.id, projectName, serviceName, directlyEnabled)
      setTopology((current) => current ? { ...current, agents: current.agents.map((item) => item.id !== agent.id ? item : { ...item, services: item.services.map((candidate) => candidate.projectName === projectName && candidate.serviceName === serviceName ? result.service : candidate) }) } : current)
    } catch (caught) { setTopology(previous); setError(friendlyError(caught, t)) }
    finally { setPending((current) => current.filter((item) => item !== key)) }
  }

  async function saveConnection(event: React.FormEvent) {
    event.preventDefault(); if ((!botToken || !groupId) && !topology?.configured) { setError(t('enterReplacement')); return }
    setBusy(true); setError(''); setSuccess('')
    try { const result = await api.saveTelegram(botToken || undefined, groupId || undefined, events); setTopology((current) => current ? { ...current, ...result } : current); setBotToken(''); setGroupId(''); setSuccess(t('settingsSaved')) }
    catch (caught) { setError(friendlyError(caught, t)) } finally { setBusy(false) }
  }

  async function saveEvents(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setSuccess('')
    try { const result = await api.saveTelegram(undefined, undefined, events); setTopology((current) => current ? { ...current, ...result } : current); setSuccess(t('settingsSaved')) }
    catch (caught) { setError(friendlyError(caught, t)) } finally { setBusy(false) }
  }

  async function test() { setBusy(true); setError(''); setSuccess(''); try { await api.testTelegram(); setSuccess(t('testSent')) } catch (caught) { setError(friendlyError(caught, t)) } finally { setBusy(false) } }

  const selectedAgent = topology?.agents.find((agent) => agent.id === selectedAgentId)
  const projects = selectedAgent?.services.reduce((groups, service) => {
    const services = groups.get(service.projectName) ?? []
    services.push(service)
    groups.set(service.projectName, services)
    return groups
  }, new Map<string, NotificationServicePreference[]>()) ?? new Map<string, NotificationServicePreference[]>()
  return <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-6">
    <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><span className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.14em] text-[#229ED9]"><Send size={15} />Telegram</span><h1 className="pt-2 text-3xl font-black tracking-[-0.045em] text-ink-900 dark:text-white sm:text-4xl">{t('notificationsTitle')}</h1><div className="flex flex-wrap items-center gap-3 pt-2"><p className="text-sm font-medium text-stone-500 dark:text-stone-400">{t('notificationsDescription')}</p>{topology && <Status active={topology.configured} label={t(topology.configured ? 'configured' : 'notConfigured')} />}</div></div>{role === 'owner' && <button type="button" title={t('notificationConfiguration')} aria-label={t('notificationConfiguration')} onClick={() => setConfigurationOpen(true)} className="flex h-11 w-11 items-center justify-center self-end rounded-xl border border-stone-200 bg-white text-stone-500 transition hover:border-mint-400 hover:text-ink-900 dark:border-white/10 dark:bg-white/5 dark:text-stone-300"><Settings size={19} /></button>}</header>
    {role === 'viewer' && <Notice>{t('readOnly')}</Notice>}{topology && Object.values(topology.truncated).some(Boolean) && <Notice>{t('notificationTopologyTruncated')}</Notice>}{error && <Alert>{error}</Alert>}{success && <Success>{success}</Success>}
    {loading ? <Loading t={t} /> : !topology?.agents.length ? <Empty t={t} /> : <>
      <div className="sm:hidden"><label className="sr-only" htmlFor="notification-agent">{t('notificationServer')}</label><select id="notification-agent" className={inputClass} value={selectedAgentId} onChange={(event) => setSelectedAgentId(event.target.value)}>{topology.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></div>
      <div role="tablist" aria-label={t('notificationServers')} className="hidden gap-2 overflow-x-auto pb-2 sm:flex">{topology.agents.map((agent) => <button key={agent.id} role="tab" aria-selected={agent.id === selectedAgentId} aria-controls={`notification-agent-${agent.id}`} type="button" onClick={() => setSelectedAgentId(agent.id)} className={`flex min-h-11 shrink-0 items-center gap-2 rounded-xl border px-4 text-xs font-extrabold transition ${agent.id === selectedAgentId ? 'border-mint-400 bg-mint-400/10 text-ink-900 dark:text-white' : 'border-stone-200 bg-white text-stone-500 dark:border-white/10 dark:bg-white/5 dark:text-stone-300'}`}><Server size={15} />{agent.name}</button>)}</div>
      {selectedAgent && <section id={`notification-agent-${selectedAgent.id}`} role="tabpanel" className="flex flex-col gap-5"><div className={`${panelClass} flex flex-wrap items-center justify-between gap-4 p-5 sm:p-6`}><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="truncate text-lg font-black text-ink-900 dark:text-white">{selectedAgent.name}</h2><Health status={selectedAgent.healthStatus} t={t} /></div><p dir="ltr" className="break-all pt-1 font-mono text-[0.65rem] text-stone-400">{selectedAgent.id}</p></div><ScopeButton enabled={selectedAgent.enabled} disabled={role === 'viewer' || pending.includes(`agent:${selectedAgent.id}`)} label={t(selectedAgent.enabled ? 'muteServerNotifications' : 'enableServerNotifications')} onClick={() => void toggleAgent(selectedAgent)} /></div>
        {selectedAgent.services.length === 0 ? <div className={`${panelClass} p-10 text-center text-sm font-bold text-stone-400`}>{t(selectedAgent.healthStatus === 'offline' ? 'offlineNotificationServer' : 'noNotificationServices')}</div> : [...projects].map(([projectName, services]) => <section key={projectName} className="min-w-0"><h3 dir="ltr" className="break-all px-1 pb-3 text-left font-mono text-xs font-black text-stone-500 dark:text-stone-300">{projectName}</h3><div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">{services.map((service) => <article key={service.serviceName} className={`${panelClass} min-w-0 p-4 sm:p-5`}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><bdi dir="ltr" className="block break-all font-mono text-sm font-black text-ink-900 dark:text-white">{service.serviceName}</bdi><div className="flex flex-wrap gap-2 pt-2"><ServiceHealth status={service.status} t={t} />{!service.discovered && <span className="rounded-full bg-stone-500/10 px-2 py-1 text-[0.6rem] font-bold text-stone-500">{t('historicalService')}</span>}{service.inherited && <span className="rounded-full bg-amber-500/10 px-2 py-1 text-[0.6rem] font-bold text-amber-700 dark:text-amber-300">{t('inheritedServerMute')}</span>}{!service.directlyEnabled && <span className="rounded-full bg-rose-500/10 px-2 py-1 text-[0.6rem] font-bold text-rose-700 dark:text-rose-300">{t('directServiceMute')}</span>}</div></div><ScopeButton enabled={service.enabled} disabled={role === 'viewer' || pending.includes(`service:${selectedAgent.id}:${projectName}:${service.serviceName}`)} label={t(service.directlyEnabled ? 'muteServiceNotifications' : 'enableServiceNotifications')} onClick={() => void toggleService(selectedAgent, projectName, service.serviceName)} /></div></article>)}</div></section>)}
      </section>}
    </>}
    <Modal open={configurationOpen} title={t('notificationConfiguration')} description={t('notificationConfigurationDescription')} closeLabel={t('close')} busy={busy} onClose={() => setConfigurationOpen(false)}>
      <div role="tablist" aria-label={t('notificationConfiguration')} className="grid grid-cols-2 border-b border-stone-200 dark:border-white/[0.07]">{(['connection', 'events'] as const).map((tab) => <button key={tab} role="tab" aria-selected={configurationTab === tab} aria-controls={`telegram-${tab}-panel`} id={`telegram-${tab}-tab`} type="button" onClick={() => setConfigurationTab(tab)} className={`min-h-12 border-b-2 px-4 text-xs font-extrabold ${configurationTab === tab ? 'border-mint-400 text-ink-900 dark:text-white' : 'border-transparent text-stone-400'}`}>{t(tab === 'connection' ? 'connectionTab' : 'eventTypesTab')}</button>)}</div>
      {configurationTab === 'connection' ? <form id="telegram-connection-panel" role="tabpanel" aria-labelledby="telegram-connection-tab" onSubmit={saveConnection} className="flex flex-col gap-5 p-5 sm:p-6"><div className="flex items-start justify-between gap-3"><p className="text-xs font-semibold leading-5 text-stone-400">{t(topology?.configured ? 'existingSecretNotice' : 'notConfigured')}</p><CredentialsHelp t={t} /></div><div className="grid grid-cols-1 gap-5 sm:grid-cols-2"><Field label={t('botToken')}><input dir="ltr" type="password" autoComplete="new-password" value={botToken} placeholder={t('botTokenPlaceholder')} onChange={(event) => setBotToken(event.target.value)} className={`${inputClass} text-left font-mono`} /></Field><Field label={t('groupId')}><input dir="ltr" value={groupId} placeholder={t('groupIdPlaceholder')} onChange={(event) => setGroupId(event.target.value)} className={`${inputClass} text-left font-mono`} /></Field></div><div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" disabled={busy || !topology?.configured} onClick={() => void test()} className={buttonClass}><Send size={15} />{t('testConnection')}</button><button disabled={busy || Boolean(botToken) !== Boolean(groupId) || (!topology?.configured && (!botToken || !groupId))} className={primaryButton}><Save size={15} />{t('saveSettings')}</button></div></form> : <form id="telegram-events-panel" role="tabpanel" aria-labelledby="telegram-events-tab" onSubmit={saveEvents} className="flex flex-col gap-5 p-5 sm:p-6"><div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{notificationEvents.map(([value, label]) => <label key={value} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-stone-200/80 px-3.5 py-2 text-xs font-bold dark:border-white/[0.07]"><input type="checkbox" checked={events.includes(value)} onChange={() => setEvents((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value])} className="h-4 w-4 accent-emerald-500" /><span>{t(label)}</span></label>)}</div><button disabled={busy || !topology?.configured} className={`${primaryButton} self-end`}><Save size={15} />{t('saveSettings')}</button></form>}
    </Modal>
  </div>
}

function effectiveAgent(agent: NotificationAgentPreference, enabled: boolean): NotificationAgentPreference { return { ...agent, enabled, services: agent.services.map((service) => ({ ...service, enabled: enabled && service.directlyEnabled, inherited: !enabled && service.directlyEnabled })) } }
function ScopeButton({ enabled, disabled, label, onClick }: { enabled: boolean; disabled: boolean; label: string; onClick: () => void }) { const Icon = enabled ? Bell : BellOff; return <button type="button" disabled={disabled} title={label} aria-label={label} aria-pressed={!enabled} onClick={onClick} className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border transition disabled:cursor-not-allowed disabled:opacity-60 ${enabled ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300'}`}><Icon size={18} /></button> }
function Status({ active, label }: { active: boolean; label: string }) { return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.65rem] font-extrabold ${active ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{label}</span> }
function Health({ status, t }: { status: NotificationAgentPreference['healthStatus']; t: Translate }) { return <span className="rounded-full bg-stone-500/10 px-2 py-1 text-[0.6rem] font-bold text-stone-500">{t(status)}</span> }
function ServiceHealth({ status, t }: { status: RuntimeServiceStatus; t: Translate }) { const key = status === 'healthy' ? 'runtimeHealthy' : status; return <span className="rounded-full bg-stone-500/10 px-2 py-1 text-[0.6rem] font-bold text-stone-500">{t(key)}</span> }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="flex min-w-0 flex-col gap-2"><span className="text-xs font-extrabold">{label}</span>{children}</label> }
function CredentialsHelp({ t }: { t: Translate }) { return <HelpPopover label={t('credentialsHelp')} title={t('telegramCredentialsHelpTitle')} closeLabel={t('close')}><p>{t('telegramBotTokenSteps')}</p><p>{t('telegramGroupIdSteps')}</p><div className="flex flex-wrap gap-4"><a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="font-extrabold text-mint-600 underline dark:text-mint-300">{t('openBotFather')}</a><a href="https://core.telegram.org/bots/api#getupdates" target="_blank" rel="noreferrer" className="font-extrabold text-mint-600 underline dark:text-mint-300">{t('openTelegramGetUpdates')}</a></div></HelpPopover> }
function Alert({ children }: { children: React.ReactNode }) { return <div role="alert" className="flex items-start gap-2 rounded-xl bg-rose-500/10 px-3.5 py-3 text-xs font-bold text-rose-700 dark:text-rose-300"><TriangleAlert size={15} />{children}</div> }
function Notice({ children }: { children: React.ReactNode }) { return <div className="rounded-xl bg-amber-500/10 px-3.5 py-3 text-xs font-bold text-amber-700 dark:text-amber-300">{children}</div> }
function Success({ children }: { children: React.ReactNode }) { return <div role="status" className="flex items-center gap-2 rounded-xl bg-emerald-500/10 px-3.5 py-3 text-xs font-bold text-emerald-700 dark:text-emerald-300"><CheckCircle2 size={15} />{children}</div> }
function Loading({ t }: { t: Translate }) { return <div role="status" className={`${panelClass} flex items-center justify-center gap-3 p-8 text-sm font-bold text-stone-400`}><RefreshCw className="animate-spin" size={18} />{t('loadingData')}</div> }
function Empty({ t }: { t: Translate }) { return <div className={`${panelClass} flex min-h-52 flex-col items-center justify-center p-10 text-center`}><Bot className="text-stone-300 dark:text-stone-600" size={31} /><p className="pt-3 text-sm font-bold text-stone-400">{t('noNotificationServers')}</p></div> }
function friendlyError(error: unknown, t: Translate) { if (error instanceof ApiError) { if (error.status === 403) return t('forbidden'); if (error.status === 400) return t('validationError') } return t('requestFailed') }
