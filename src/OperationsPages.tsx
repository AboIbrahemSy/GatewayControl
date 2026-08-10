import {
  Activity,
  Cable,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  Cloud,
  Container,
  ExternalLink,
  Globe2,
  Layers3,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  Save,
  Server,
  Trash2,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  api,
  ApiError,
  type Agent,
  type ManagedRoute,
  type ManagedStack,
  type Role,
  type RuntimeServiceStatus,
  type TelemetrySnapshot,
} from './api'
import type { Page, Translate } from './App'
import { Modal } from './Modal'

export type OperationsPage = 'services' | 'routes' | 'stacks'
type Navigate = (page: Page) => void

const panelClass = 'rounded-[1.4rem] border border-stone-200/80 bg-sand-50 shadow-panel dark:border-white/[0.07] dark:bg-ink-900/80'
const inputClass = 'h-12 w-full rounded-xl border border-stone-200 bg-white px-3.5 text-sm font-semibold text-ink-800 outline-none transition placeholder:text-stone-300 focus:border-mint-400 focus:ring-4 focus:ring-mint-400/10 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/[0.08] dark:bg-white/[0.035] dark:text-stone-100 dark:placeholder:text-stone-600'
const textareaClass = `${inputClass} h-72 resize-y py-3 font-mono leading-6`
const primaryButton = 'flex min-h-12 items-center justify-center gap-2 rounded-xl bg-ink-900 px-5 text-sm font-extrabold text-white transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 dark:bg-mint-400 dark:text-ink-950'
const secondaryButton = 'flex min-h-11 items-center justify-center gap-2 rounded-xl border border-stone-200 bg-white px-4 text-xs font-extrabold transition hover:border-mint-400 dark:border-white/10 dark:bg-white/5'
const serviceIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const postgresIdentifierPattern = /^[A-Za-z0-9_.-]{1,128}$/

export function StacksPage({ t, role }: { t: Translate; role: Role }) {
  const [stacks, setStacks] = useState<ManagedStack[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [editing, setEditing] = useState<ManagedStack | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [tab, setTab] = useState<'identity' | 'compose' | 'database'>('identity')
  const [agentId, setAgentId] = useState('')
  const [name, setName] = useState('')
  const [projectName, setProjectName] = useState('')
  const [composeYaml, setComposeYaml] = useState('')
  const [postgresService, setPostgresService] = useState('')
  const [postgresDatabase, setPostgresDatabase] = useState('')
  const [postgresUser, setPostgresUser] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  async function load() {
    setLoading(true); setError('')
    try {
      const [stackResult, agentResult] = await Promise.all([api.stacks(), api.agents()])
      setStacks(stackResult.stacks); setAgents(agentResult.agents)
      setAgentId((current) => current || agentResult.agents[0]?.id || '')
    } catch (caught) { setError(friendlyError(caught, t)) } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  function resetForm() {
    setEditing(null); setName(''); setProjectName(''); setComposeYaml(''); setPostgresService(''); setPostgresDatabase(''); setPostgresUser(''); setEnabled(true); setTab('identity')
    setAgentId(agents[0]?.id || ''); setError(''); setSuccess(''); setCreateOpen(false)
  }
  function edit(stack: ManagedStack) {
    setEditing(stack); setAgentId(stack.agentId); setName(stack.name); setProjectName(stack.projectName)
    setComposeYaml(''); setPostgresService(stack.postgresBackupConfig?.service || ''); setPostgresDatabase(stack.postgresBackupConfig?.database || ''); setPostgresUser(stack.postgresBackupConfig?.user || ''); setEnabled(stack.enabled); setTab('identity'); setError(''); setSuccess('')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!agentId || !name.trim() || !projectName.trim() || !/^[a-z0-9_-]+$/.test(projectName) || (!editing && !composeYaml.trim())) { setTab(!agentId || !name.trim() || !projectName.trim() || !/^[a-z0-9_-]+$/.test(projectName) ? 'identity' : 'compose'); setError(t('validationError')); return }
    const postgresBackupConfig = { service: postgresService.trim(), database: postgresDatabase.trim(), user: postgresUser.trim() }
    const postgresBackupDisabled = Object.values(postgresBackupConfig).every((value) => value === '')
    if (!postgresBackupDisabled && (!serviceIdentifierPattern.test(postgresBackupConfig.service) || !postgresIdentifierPattern.test(postgresBackupConfig.database) || !postgresIdentifierPattern.test(postgresBackupConfig.user))) { setTab('database'); setError(t('validationError')); return }
    setBusy('save'); setError(''); setSuccess('')
    try {
      const result = editing
        ? await api.updateStack(editing.id, { name, enabled, postgresBackupConfig: postgresBackupDisabled ? null : postgresBackupConfig, ...(composeYaml.trim() ? { composeYaml } : {}) })
        : await api.createStack({ agentId, name, projectName, composeYaml, enabled, ...(!postgresBackupDisabled ? { postgresBackupConfig } : {}) })
      setStacks((current) => editing ? current.map((item) => item.id === result.stack.id ? result.stack : item) : [result.stack, ...current])
      setSuccess(t('stackSaved')); resetForm(); setSuccess(t('stackSaved'))
    } catch (caught) { setError(friendlyError(caught, t)) } finally { setBusy('') }
  }
  async function toggle(stack: ManagedStack) {
    setBusy(stack.id); setError('')
    try {
      const result = await api.updateStack(stack.id, { enabled: !stack.enabled })
      setStacks((current) => current.map((item) => item.id === stack.id ? result.stack : item))
    } catch (caught) { setError(friendlyError(caught, t)) } finally { setBusy('') }
  }
  async function action(stack: ManagedStack, kind: 'restart' | 'stop') {
    setBusy(`${stack.id}:${kind}`); setError(''); setSuccess('')
    try { await (kind === 'restart' ? api.restartStack(stack.id) : api.stopStack(stack.id)); setSuccess(t('commandQueued')) }
    catch (caught) { setError(friendlyError(caught, t)) } finally { setBusy('') }
  }

  const formBody = <>
    <Tabs tabs={[["identity", t('basicDetails')], ["compose", t('composeConfiguration')], ["database", t('postgresBackup')]]} active={tab} setActive={(value) => setTab(value as typeof tab)} />
    <div className="p-5 sm:p-6">
      {tab === 'identity' ? <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-2 xl:grid-cols-4">
        <Field label={t('agent')} hint={t('chooseAgent')}><select required disabled={Boolean(editing)} value={agentId} onChange={(event) => setAgentId(event.target.value)} className={inputClass}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></Field>
        <Field label={t('name')}><input required maxLength={63} value={name} onChange={(event) => setName(event.target.value)} className={inputClass} /></Field>
        <Field label={t('projectName')} hint={t('projectNameHint')}><input required disabled={Boolean(editing)} maxLength={63} dir="ltr" pattern="[a-z0-9_-]+" value={projectName} onChange={(event) => setProjectName(event.target.value)} className={inputClass} /></Field>
        <div className="flex flex-col gap-2"><span className="hidden select-none text-xs font-extrabold text-transparent md:block" aria-hidden="true">&nbsp;</span><div className="flex h-12 items-center gap-3"><Toggle enabled={enabled} setEnabled={setEnabled} label={t('enabled')} /><span className="text-xs font-extrabold">{t(enabled ? 'enabled' : 'disabled')}</span></div></div>
      </div> : tab === 'compose' ? <Field label={t('composeYaml')} hint={t(editing ? 'updateComposeHint' : 'composeHint')}><textarea required={!editing} spellCheck={false} dir="ltr" value={composeYaml} onChange={(event) => setComposeYaml(event.target.value)} className={textareaClass} /></Field> : <div className="flex flex-col gap-5"><p className="text-xs font-semibold leading-5 text-stone-400">{t('postgresBackupDescription')}</p><div className="grid grid-cols-1 gap-5 md:grid-cols-3"><Field label={t('postgresService')}><input maxLength={128} dir="ltr" pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,127}" value={postgresService} onChange={(event) => setPostgresService(event.target.value)} className={inputClass} /></Field><Field label={t('postgresDatabase')}><input maxLength={128} dir="ltr" pattern="[A-Za-z0-9_.-]+" value={postgresDatabase} onChange={(event) => setPostgresDatabase(event.target.value)} className={inputClass} /></Field><Field label={t('postgresUser')}><input maxLength={128} dir="ltr" pattern="[A-Za-z0-9_.-]+" value={postgresUser} onChange={(event) => setPostgresUser(event.target.value)} className={inputClass} /></Field></div></div>}
      <div className="flex flex-col-reverse gap-3 pt-6 sm:flex-row sm:justify-end">
        {tab === 'compose' && <button type="button" className={secondaryButton} onClick={() => setTab('identity')}>{t('basicDetails')}</button>}
        {tab === 'database' && <button type="button" className={secondaryButton} onClick={() => setTab('compose')}>{t('composeConfiguration')}</button>}
        {tab === 'identity' ? <button type="button" className={primaryButton} onClick={() => { if (!agentId || !name.trim() || !projectName.trim() || !/^[a-z0-9_-]+$/.test(projectName)) { setError(t('validationError')); return } setError(''); setTab('compose') }}>{t('composeConfiguration')}<ChevronRight className="rtl:rotate-180" size={16} /></button> : tab === 'compose' ? <button type="button" className={primaryButton} onClick={() => { if (!editing && !composeYaml.trim()) { setError(t('validationError')); return } setError(''); setTab('database') }}>{t('postgresBackup')}<ChevronRight className="rtl:rotate-180" size={16} /></button> : <button disabled={busy === 'save'} className={primaryButton}><Save size={16} />{t(editing ? 'saveChanges' : 'createStack')}</button>}
      </div>
    </div>
  </>

  return <PageShell icon={Cable} title={t('stacksTitle')} description={t('stacksDescription')} refresh={load} t={t} action={role !== 'viewer' ? <button type="button" disabled={loading || agents.length === 0} className={primaryButton} onClick={() => { resetForm(); setCreateOpen(true) }}><Plus size={17} />{t('newStack')}</button> : undefined}>
    {role === 'viewer' && <Notice>{t('readOnly')}</Notice>}{error && <Alert>{error}</Alert>}{success && <Success>{success}</Success>}
    {role !== 'viewer' && !loading && agents.length === 0 && <Notice>{t('noAgentsForResources')}</Notice>}
    {role !== 'viewer' && agents.length > 0 && editing && <form onSubmit={submit} className={`${panelClass} overflow-hidden`}><FormHeader title={t('editStack')} editing cancel={resetForm} t={t} />{formBody}</form>}
    <Modal open={createOpen} title={t('newStack')} description={t('stacksDescription')} closeLabel={t('cancel')} busy={busy === 'save'} maxWidthClass="max-w-6xl" onClose={resetForm}><form onSubmit={submit}>{formBody}</form></Modal>
    <CatalogHeading icon={Layers3} title={t('stackCatalog')} />
    {loading ? <Loading t={t} /> : <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">{stacks.map((stack) => <StackCard key={stack.id} stack={stack} agent={agents.find((agent) => agent.id === stack.agentId)} role={role} busy={busy} t={t} edit={() => edit(stack)} toggle={() => void toggle(stack)} action={(kind) => void action(stack, kind)} />)}{stacks.length === 0 && <Empty icon={Cable} text={t('noStacks')} />}</div>}
  </PageShell>
}

function StackCard({ stack, agent, role, busy, t, edit, toggle, action }: { stack: ManagedStack; agent?: Agent; role: Role; busy: string; t: Translate; edit: () => void; toggle: () => void; action: (kind: 'restart' | 'stop') => void }) {
  const cardBusy = busy.startsWith(`${stack.id}:`) || busy === stack.id
  return <article aria-busy={cardBusy} className={`${panelClass} flex min-w-0 flex-col p-5 sm:p-6`}><div className="flex items-start justify-between gap-4"><span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-mint-400/10 text-mint-500 dark:text-mint-300"><Cable size={21} /></span><div className="text-end"><span className="mb-1 block text-[0.6rem] font-bold text-stone-400">{t('deploymentState')}</span><DeploymentStatus status={stack.status} t={t} /></div></div><h2 className="truncate pt-5 text-base font-black text-ink-900 dark:text-white">{stack.name}</h2><p dir="ltr" className="truncate pt-1 text-start font-mono text-xs text-stone-400">{stack.projectName}</p><div className="grid grid-cols-1 gap-3 pt-5 sm:grid-cols-3"><Meta label={t('agent')} value={agent?.name || t('unknown')} /><Meta label={t('revision')} value={`#${stack.revision}`} /><Meta label={t('postgresBackup')} value={t(stack.postgresBackupConfig ? 'configured' : 'notConfigured')} /></div><div className="mt-auto flex flex-wrap items-center gap-2 pt-5"><StatusPill active={stack.enabled} label={t(stack.enabled ? 'enabled' : 'disabled')} />{stack.configured && <StatusPill active label={t('configured')} />}</div>{role !== 'viewer' && <div className="grid grid-cols-1 gap-2 pt-5 sm:grid-cols-3"><ActionButton icon={Pencil} label={t('editStack')} onClick={edit} /><ActionButton icon={RotateCw} label={t('restart')} disabled={cardBusy || !stack.enabled} busy={busy === `${stack.id}:restart`} onClick={() => action('restart')} /><ActionButton icon={CircleStop} label={t('stop')} disabled={cardBusy || !stack.enabled} busy={busy === `${stack.id}:stop`} onClick={() => action('stop')} /><div className="flex min-h-11 items-center justify-center sm:col-span-3"><Toggle enabled={stack.enabled} setEnabled={toggle} label={t(stack.enabled ? 'enabled' : 'disabled')} disabled={cardBusy} /></div></div>}</article>
}

export function RoutesPage({ t, role }: { t: Translate; role: Role }) {
  const [routes, setRoutes] = useState<ManagedRoute[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [editing, setEditing] = useState<ManagedRoute | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [tab, setTab] = useState<'identity' | 'backends'>('identity')
  const [gatewayAgentId, setGatewayAgentId] = useState('')
  const [name, setName] = useState('')
  const [hostname, setHostname] = useState('')
  const [exposure, setExposure] = useState<'tunnel' | 'public'>('tunnel')
  const [backends, setBackends] = useState([''])
  const [enabled, setEnabled] = useState(true)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  async function load() {
    setLoading(true); setError('')
    try {
      const [routeResult, agentResult] = await Promise.all([api.routes(), api.agents()])
      setRoutes(routeResult.routes); setAgents(agentResult.agents)
      setGatewayAgentId((current) => current || agentResult.agents[0]?.id || '')
    } catch (caught) { setError(friendlyError(caught, t)) } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  function resetForm() { setEditing(null); setName(''); setHostname(''); setExposure('tunnel'); setBackends(['']); setEnabled(true); setTab('identity'); setGatewayAgentId(agents[0]?.id || ''); setError(''); setSuccess(''); setCreateOpen(false) }
  function edit(route: ManagedRoute) { setEditing(route); setGatewayAgentId(route.gatewayAgentId); setName(route.name); setHostname(route.hostname); setExposure(route.exposure); setBackends(route.backends); setEnabled(route.enabled); setTab('identity'); setError(''); setSuccess(''); window.scrollTo({ top: 0, behavior: 'smooth' }) }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); const targets = backends.map((backend) => backend.trim()).filter(Boolean)
    if (!gatewayAgentId || !name.trim() || !hostname.trim() || targets.length === 0) { setTab(!gatewayAgentId || !name.trim() || !hostname.trim() ? 'identity' : 'backends'); setError(t('validationError')); return }
    setBusy('save'); setError(''); setSuccess('')
    try {
      const input = { gatewayAgentId, name, hostname, exposure, backends: targets, enabled }
      const result = editing ? await api.updateRoute(editing.id, input) : await api.createRoute(input)
      setRoutes((current) => editing ? current.map((item) => item.id === result.route.id ? result.route : item) : [result.route, ...current])
      resetForm(); setSuccess(t('routeSaved'))
    } catch (caught) { setError(friendlyError(caught, t)) } finally { setBusy('') }
  }
  async function toggle(route: ManagedRoute) {
    setBusy(route.id); setError('')
    try { const result = await api.updateRoute(route.id, { enabled: !route.enabled }); setRoutes((current) => current.map((item) => item.id === route.id ? result.route : item)) }
    catch (caught) { setError(friendlyError(caught, t)) } finally { setBusy('') }
  }
  function setBackend(index: number, value: string) { setBackends((current) => current.map((item, itemIndex) => itemIndex === index ? value : item)) }

  return <PageShell icon={Globe2} title={t('routesTitle')} description={t('routesDescription')} refresh={load} t={t} action={role !== 'viewer' ? <button type="button" disabled={loading || agents.length === 0} className={primaryButton} onClick={() => { resetForm(); setCreateOpen(true) }}><Plus size={17} />{t('newRoute')}</button> : undefined}>
    {role === 'viewer' && <Notice>{t('readOnly')}</Notice>}{error && <Alert>{error}</Alert>}{success && <Success>{success}</Success>}
    {role !== 'viewer' && !loading && agents.length === 0 && <Notice>{t('noAgentsForResources')}</Notice>}
    {role !== 'viewer' && agents.length > 0 && <CreateFormContainer editing={Boolean(editing)} open={createOpen} title={t('newRoute')} description={t('routesDescription')} closeLabel={t('cancel')} busy={busy === 'save'} onClose={resetForm}><form onSubmit={submit} className={editing ? `${panelClass} overflow-hidden` : ''}>
      {editing && <FormHeader title={t('editRoute')} editing cancel={resetForm} t={t} />}
      <Tabs tabs={[['identity', t('basicDetails')], ['backends', t('backends')]]} active={tab} setActive={(value) => setTab(value as typeof tab)} />
      <div className="p-5 sm:p-6">{tab === 'identity' ? <div className="flex flex-col gap-6"><div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3"><Field label={t('gatewayAgent')}><select required value={gatewayAgentId} onChange={(event) => setGatewayAgentId(event.target.value)} className={inputClass}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></Field><Field label={t('name')}><input required maxLength={63} value={name} onChange={(event) => setName(event.target.value)} className={inputClass} /></Field><Field label={t('hostname')}><input required maxLength={253} dir="ltr" placeholder={t('hostnamePlaceholder')} value={hostname} onChange={(event) => setHostname(event.target.value)} className={inputClass} /></Field></div><div><p className="pb-3 text-xs font-extrabold">{t('exposure')}</p><div className="grid grid-cols-1 gap-3 md:grid-cols-2"><ExposureCard active={exposure === 'tunnel'} icon={Cloud} title={t('tunnel')} description={t('tunnelDescription')} onClick={() => setExposure('tunnel')} /><ExposureCard active={exposure === 'public'} icon={Globe2} title={t('publicIp')} description={t('publicIpDescription')} onClick={() => setExposure('public')} /></div></div><div className="flex items-center gap-3"><Toggle enabled={enabled} setEnabled={setEnabled} label={t('enabled')} /><span className="text-xs font-extrabold">{t(enabled ? 'enabled' : 'disabled')}</span></div></div> : <div className="flex flex-col gap-3"><p className="text-xs font-extrabold">{t('backends')}</p>{backends.map((backend, index) => <div key={index} className="flex min-w-0 gap-2"><input required type="url" dir="ltr" value={backend} onChange={(event) => setBackend(index, event.target.value)} className={inputClass} /><button type="button" disabled={backends.length === 1} onClick={() => setBackends((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={t('removeBackend')} className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-stone-200 text-rose-600 disabled:opacity-30 dark:border-white/10"><Trash2 size={17} /></button></div>)}<button type="button" onClick={() => setBackends((current) => [...current, ''])} className={`${secondaryButton} w-fit`}><Plus size={15} />{t('addBackend')}</button></div>}
        <div className="flex flex-col-reverse gap-3 pt-6 sm:flex-row sm:justify-end">{tab === 'backends' && <button type="button" className={secondaryButton} onClick={() => setTab('identity')}>{t('basicDetails')}</button>}{tab === 'identity' ? <button type="button" className={primaryButton} onClick={() => { if (!gatewayAgentId || !name.trim() || !hostname.trim()) { setError(t('validationError')); return } setError(''); setTab('backends') }}>{t('backends')}<ChevronRight className="rtl:rotate-180" size={16} /></button> : <button disabled={busy === 'save'} className={primaryButton}><Save size={16} />{t(editing ? 'saveChanges' : 'createRoute')}</button>}</div>
      </div>
    </form></CreateFormContainer>}
    <CatalogHeading icon={Globe2} title={t('routeCatalog')} />
    {loading ? <Loading t={t} /> : <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">{routes.map((route) => <RouteCard key={route.id} route={route} agent={agents.find((agent) => agent.id === route.gatewayAgentId)} role={role} busy={busy} t={t} edit={() => edit(route)} toggle={() => void toggle(route)} />)}{routes.length === 0 && <Empty icon={Globe2} text={t('noRoutes')} />}</div>}
  </PageShell>
}

function RouteCard({ route, agent, role, busy, t, edit, toggle }: { route: ManagedRoute; agent?: Agent; role: Role; busy: string; t: Translate; edit: () => void; toggle: () => void }) {
  return <article className={`${panelClass} flex min-w-0 flex-col p-5 sm:p-6`}><div className="flex items-start justify-between gap-4"><span className={`flex h-11 w-11 items-center justify-center rounded-2xl ${route.exposure === 'tunnel' ? 'bg-violet-500/10 text-violet-600 dark:text-violet-300' : 'bg-sky-500/10 text-sky-600 dark:text-sky-300'}`}>{route.exposure === 'tunnel' ? <Cloud size={21} /> : <Globe2 size={21} />}</span><DeploymentStatus status={route.status} t={t} /></div><h2 className="truncate pt-5 text-base font-black text-ink-900 dark:text-white">{route.name}</h2><p dir="ltr" className="truncate pt-1 text-start text-xs font-bold text-stone-400">{route.hostname}</p><div className="grid grid-cols-2 gap-3 pt-5"><Meta label={t('gatewayAgent')} value={agent?.name || t('unknown')} /><Meta label={t('revision')} value={`#${route.revision}`} /></div><div className="flex flex-col gap-2 pt-5">{route.backends.map((backend) => <span key={backend} dir="ltr" className="truncate rounded-lg bg-stone-100 px-2.5 py-2 text-start font-mono text-[0.65rem] text-stone-500 dark:bg-white/5 dark:text-stone-400">{backend}</span>)}</div><div className="mt-auto flex items-center justify-between gap-3 pt-5"><StatusPill active={route.enabled} label={t(route.enabled ? 'enabled' : 'disabled')} /><span className="text-[0.65rem] font-extrabold text-stone-400">{t(route.exposure === 'tunnel' ? 'tunnel' : 'publicIp')}</span></div>{role !== 'viewer' && <div className="flex items-center justify-end gap-3 border-t border-stone-200/70 pt-4 mt-4 dark:border-white/[0.06]"><button type="button" onClick={edit} className={secondaryButton}><Pencil size={15} />{t('editRoute')}</button><Toggle enabled={route.enabled} setEnabled={toggle} label={t(route.enabled ? 'enabled' : 'disabled')} disabled={busy === route.id} /></div>}</article>
}

export function ServicesPage({ t, navigate }: { t: Translate; navigate: Navigate }) {
  const [stacks, setStacks] = useState<ManagedStack[]>([]); const [routes, setRoutes] = useState<ManagedRoute[]>([]); const [agents, setAgents] = useState<Agent[]>([]); const [telemetry, setTelemetry] = useState<TelemetrySnapshot[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState('')
  async function load() { setLoading(true); setError(''); try { const [stackResult, routeResult, agentResult, monitoringResult] = await Promise.all([api.stacks(), api.routes(), api.agents(), api.monitoringSummary().catch(() => ({ agents: [] }))]); setStacks(stackResult.stacks); setRoutes(routeResult.routes); setAgents(agentResult.agents); setTelemetry(monitoringResult.agents) } catch (caught) { setError(friendlyError(caught, t)) } finally { setLoading(false) } }
  useEffect(() => { void load() }, [])
  return <PageShell icon={Container} title={t('servicesTitle')} description={t('servicesDescription')} refresh={load} t={t}>{error && <Alert>{error}</Alert>}{loading ? <Loading t={t} /> : <><div className="grid grid-cols-2 gap-3 xl:grid-cols-4"><SummaryCard icon={Cable} title={t('manageStacks')} count={stacks.length} onClick={() => navigate('stacks')} /><SummaryCard icon={Globe2} title={t('manageRoutes')} count={routes.length} onClick={() => navigate('routes')} /><SummaryCard icon={Activity} title={t('monitoringContext')} count={telemetry.length} onClick={() => navigate('monitoring')} /><SummaryCard icon={ExternalLink} title={t('logsContext')} count={telemetry.flatMap((item) => item.services).length} onClick={() => navigate('logs')} /></div><div className="flex flex-wrap gap-2"><ContextButton label={t('monitoringContext')} onClick={() => navigate('monitoring')} /><ContextButton label={t('logsContext')} onClick={() => navigate('logs')} /><ContextButton label={t('backupContext')} onClick={() => navigate('backups')} /></div><CatalogHeading icon={Layers3} title={t('serviceCatalog')} /><div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">{stacks.map((stack) => { const snapshot = telemetry.find((item) => item.agentId === stack.agentId); const services = snapshot?.services.filter((service) => service.projectName === stack.projectName) || []; return <ServiceCard key={`stack:${stack.id}`} icon={Cable} name={stack.name} detail={stack.projectName} agent={agents.find((item) => item.id === stack.agentId)?.name} status={stack.status} runtimeStatus={aggregateRuntimeStatus(services.map((service) => service.status))} stale={snapshot ? Date.now() - new Date(snapshot.receivedAt).getTime() > 90_000 : undefined} enabled={stack.enabled} type={t('stacksTitle')} t={t} onClick={() => navigate('stacks')} /> })}{routes.map((route) => <ServiceCard key={`route:${route.id}`} icon={route.exposure === 'tunnel' ? Cloud : Globe2} name={route.name} detail={route.hostname} agent={agents.find((item) => item.id === route.gatewayAgentId)?.name} status={route.status} enabled={route.enabled} type={t('routesTitle')} t={t} onClick={() => navigate('routes')} />)}{stacks.length + routes.length === 0 && <Empty icon={Container} text={t('noServices')} />}</div></>}</PageShell>
}

function PageShell({ icon: Icon, title, description, refresh, t, action, children }: { icon: LucideIcon; title: string; description: string; refresh: () => Promise<void>; t: Translate; action?: React.ReactNode; children: React.ReactNode }) { return <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-6"><section className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end"><div className="max-w-3xl"><span className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.14em] text-mint-500 dark:text-mint-300"><Icon size={15} />GatewayControl</span><h1 className="pt-2 text-3xl font-black tracking-[-0.045em] text-ink-900 dark:text-white sm:text-4xl">{title}</h1><p className="max-w-2xl pt-2 text-sm font-medium leading-6 text-stone-500 dark:text-stone-400 sm:text-base">{description}</p></div><div className="flex flex-col-reverse gap-2 sm:flex-row">{action}<button type="button" className={secondaryButton} onClick={() => void refresh()}><RefreshCw size={15} />{t('refresh')}</button></div></section>{children}</div> }
function CreateFormContainer({ editing, open, title, description, closeLabel, busy, onClose, children }: { editing: boolean; open: boolean; title: string; description: string; closeLabel: string; busy: boolean; onClose: () => void; children: React.ReactNode }) { return editing ? <>{children}</> : <Modal open={open} title={title} description={description} closeLabel={closeLabel} busy={busy} maxWidthClass="max-w-6xl" onClose={onClose}>{children}</Modal> }
function FormHeader({ title, editing, cancel, t }: { title: string; editing: boolean; cancel: () => void; t: Translate }) { return <div className="flex items-center justify-between gap-3 border-b border-stone-200/80 px-5 py-4 dark:border-white/[0.06]"><h2 className="font-black text-ink-900 dark:text-white">{title}</h2>{editing && <button type="button" onClick={cancel} className="flex min-h-10 items-center gap-2 rounded-xl px-3 text-xs font-extrabold text-stone-500"><X size={15} />{t('cancelEdit')}</button>}</div> }
function Tabs({ tabs, active, setActive }: { tabs: Array<[string, string]>; active: string; setActive: (value: string) => void }) { return <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-stone-200/80 bg-stone-100/40 px-3 pt-2 dark:border-white/[0.06] dark:bg-white/[0.02]">{tabs.map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={active === value} onClick={() => setActive(value)} className={`min-h-11 whitespace-nowrap border-b-2 px-4 text-xs font-extrabold transition ${active === value ? 'border-mint-500 text-ink-900 dark:text-white' : 'border-transparent text-stone-400'}`}>{label}</button>)}</div> }
function ExposureCard({ active, icon: Icon, title, description, onClick }: { active: boolean; icon: LucideIcon; title: string; description: string; onClick: () => void }) { return <button type="button" role="radio" aria-checked={active} onClick={onClick} className={`flex min-h-28 items-start gap-4 rounded-2xl border p-4 text-start transition ${active ? 'border-mint-400 bg-mint-400/10 ring-4 ring-mint-400/10' : 'border-stone-200 bg-white/50 dark:border-white/[0.07] dark:bg-white/[0.02]'}`}><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-mint-400/10 text-mint-500 dark:text-mint-300"><Icon size={20} /></span><span><strong className="block text-sm text-ink-900 dark:text-white">{title}</strong><span className="block pt-1 text-xs font-medium leading-5 text-stone-400">{description}</span></span></button> }
function CatalogHeading({ icon: Icon, title }: { icon: LucideIcon; title: string }) { return <h2 className="flex items-center gap-2 text-lg font-black text-ink-900 dark:text-white"><Icon className="text-mint-500 dark:text-mint-300" size={19} />{title}</h2> }
function SummaryCard({ icon: Icon, title, count, onClick }: { icon: LucideIcon; title: string; count: number; onClick: () => void }) { return <button type="button" onClick={onClick} className={`${panelClass} group flex min-w-0 flex-col items-start gap-3 p-4 text-start transition hover:-translate-y-0.5 hover:border-mint-400/40 sm:flex-row sm:items-center sm:p-5`}><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-mint-400/10 text-mint-500 dark:text-mint-300"><Icon size={21} /></span><span className="min-w-0 flex-1"><strong className="block truncate text-xs text-ink-900 dark:text-white sm:text-sm">{title}</strong><span className="block pt-1 text-2xl font-black">{count}</span></span><ExternalLink className="hidden text-stone-300 transition group-hover:text-mint-500 sm:block" size={18} /></button> }
function ContextButton({ label, onClick }: { label: string; onClick: () => void }) { return <button type="button" onClick={onClick} className={secondaryButton}>{label}<ExternalLink size={14} /></button> }
function ServiceCard({ icon: Icon, name, detail, agent, status, runtimeStatus, stale, enabled, type, t, onClick }: { icon: LucideIcon; name: string; detail: string; agent?: string; status: ManagedStack['status']; runtimeStatus?: RuntimeServiceStatus; stale?: boolean; enabled: boolean; type: string; t: Translate; onClick: () => void }) { return <button type="button" onClick={onClick} className={`${panelClass} group min-w-0 p-5 text-start transition hover:-translate-y-0.5 hover:border-mint-400/40 sm:p-6`}><div className="flex items-start justify-between gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-mint-400/10 text-mint-500 dark:text-mint-300"><Icon size={21} /></span><div className="text-end"><span className="mb-1 block text-[0.6rem] font-bold text-stone-400">{t('deploymentState')}</span><DeploymentStatus status={status} t={t} /></div></div><p className="pt-4 text-[0.65rem] font-extrabold uppercase tracking-wider text-stone-400">{type}</p><h3 className="truncate pt-1 text-base font-black text-ink-900 dark:text-white">{name}</h3><p dir="ltr" className="truncate pt-1 text-start text-xs text-stone-400">{detail}</p><div className="mt-4 rounded-xl bg-stone-100/70 p-3 dark:bg-white/[0.03]"><span className="block text-[0.62rem] font-bold text-stone-400">{t('runtimeState')}</span><div className="flex items-center justify-between gap-2 pt-1"><strong className="text-xs text-ink-800 dark:text-stone-200">{runtimeStatus ? t(runtimeStatus === 'healthy' ? 'runtimeHealthy' : runtimeStatus) : t('telemetryUnavailable')}</strong>{stale !== undefined && <span className={`text-[0.62rem] font-extrabold ${stale ? 'text-amber-600 dark:text-amber-300' : 'text-emerald-600 dark:text-emerald-300'}`}>{t(stale ? 'stale' : 'fresh')}</span>}</div></div><div className="flex items-center justify-between gap-3 pt-5"><span className="flex min-w-0 items-center gap-2 truncate text-[0.68rem] font-bold text-stone-400"><Server size={14} />{agent || t('unknown')}</span><StatusPill active={enabled} label={t(enabled ? 'enabled' : 'disabled')} /></div></button> }
function DeploymentStatus({ status, t }: { status: ManagedStack['status']; t: Translate }) { const styles = status === 'active' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : status === 'failed' ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'; return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.65rem] font-extrabold ${styles}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{t(status)}</span> }
function StatusPill({ active, label }: { active: boolean; label: string }) { return <span className={`inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.65rem] font-extrabold ${active ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-stone-500/10 text-stone-500 dark:text-stone-400'}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{label}</span> }
function Meta({ label, value }: { label: string; value: string }) { return <div className="min-w-0 rounded-xl bg-stone-100/70 p-3 dark:bg-white/[0.03]"><span className="block text-[0.62rem] font-bold text-stone-400">{label}</span><strong className="block truncate pt-1 text-xs text-ink-800 dark:text-stone-200">{value}</strong></div> }
function ActionButton({ icon: Icon, label, disabled, busy, onClick }: { icon: LucideIcon; label: string; disabled?: boolean; busy?: boolean; onClick: () => void }) { return <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick} className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-stone-200 px-3 text-[0.68rem] font-extrabold transition hover:border-mint-400 disabled:opacity-40 dark:border-white/10">{busy ? <RefreshCw className="animate-spin" size={14} /> : <Icon size={14} />}<span>{label}</span></button> }
function Toggle({ enabled, setEnabled, label, disabled = false }: { enabled: boolean; setEnabled: (enabled: boolean) => void; label: string; disabled?: boolean }) { return <button type="button" role="switch" aria-checked={enabled} aria-label={label} disabled={disabled} onClick={() => setEnabled(!enabled)} className="relative h-11 w-12 shrink-0 rounded-full transition disabled:opacity-50"><span className={`absolute inset-x-0 top-2 h-7 rounded-full transition ${enabled ? 'bg-mint-400' : 'bg-stone-300 dark:bg-stone-700'}`} /><span className={`absolute top-3 h-5 w-5 rounded-full bg-white shadow transition-all ${enabled ? 'end-1' : 'start-1'}`} /></button> }
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) { return <label className="flex min-w-0 flex-col gap-2"><span className="text-xs font-extrabold text-ink-800 dark:text-stone-100">{label}</span>{children}{hint && <span className="text-[0.66rem] font-medium leading-5 text-stone-400">{hint}</span>}</label> }
function Alert({ children }: { children: React.ReactNode }) { return <div role="alert" className="flex items-start gap-2 rounded-xl bg-rose-500/10 px-3.5 py-3 text-xs font-bold leading-5 text-rose-700 dark:text-rose-300"><TriangleAlert className="mt-0.5 shrink-0" size={15} />{children}</div> }
function Notice({ children }: { children: React.ReactNode }) { return <div className="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3.5 py-3 text-xs font-bold leading-5 text-amber-700 dark:text-amber-300"><TriangleAlert className="mt-0.5 shrink-0" size={15} />{children}</div> }
function Success({ children }: { children: React.ReactNode }) { return <div role="status" className="flex items-start gap-2 rounded-xl bg-emerald-500/10 px-3.5 py-3 text-xs font-bold text-emerald-700 dark:text-emerald-300"><CheckCircle2 size={15} />{children}</div> }
function Loading({ t }: { t: Translate }) { return <div role="status" className={`${panelClass} flex items-center justify-center gap-3 p-8 text-sm font-bold text-stone-400`}><RefreshCw className="animate-spin" size={18} />{t('loadingData')}</div> }
function Empty({ icon: Icon, text }: { icon: LucideIcon; text: string }) { return <div className={`${panelClass} flex min-h-52 flex-col items-center justify-center p-10 text-center md:col-span-2 2xl:col-span-3`}><Icon className="text-stone-300 dark:text-stone-600" size={31} /><p className="pt-3 text-sm font-bold text-stone-400">{text}</p></div> }
function friendlyError(error: unknown, t: Translate) { if (error instanceof ApiError && error.status === 400) return t('validationError'); return t('requestFailed') }
function aggregateRuntimeStatus(statuses: RuntimeServiceStatus[]): RuntimeServiceStatus | undefined { if (statuses.length === 0) return undefined; if (statuses.includes('unhealthy')) return 'unhealthy'; if (statuses.includes('starting')) return 'starting'; if (statuses.includes('stopped')) return 'stopped'; if (statuses.every((status) => status === 'healthy')) return 'healthy'; return 'unknown' }
