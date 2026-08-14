import {
  CheckCircle2,
  Cloud,
  Globe2,
  KeyRound,
  Link2,
  Plus,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  type CloudflareAccount,
  type CloudflareDomainAccess,
  type CloudflareZone,
  type Agent,
  type Connector,
  type ManagedRoute,
  type Role,
} from "./api";
import type { Locale, MessageKey, Translate } from "./App";
import { HelpPopover } from "./HelpPopover";
import { Modal } from "./Modal";

type Tab = "accounts" | "zones" | "hostnames";

const panelClass =
  "rounded-[1.4rem] border border-stone-200/80 bg-sand-50 shadow-panel dark:border-white/[0.07] dark:bg-ink-900/80";
const inputClass =
  "h-12 w-full min-w-0 rounded-xl border border-stone-200 bg-white px-3.5 text-sm font-semibold text-ink-800 outline-none transition placeholder:text-stone-300 focus:border-mint-400 focus:ring-4 focus:ring-mint-400/10 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/[0.08] dark:bg-white/[0.035] dark:text-stone-100 dark:placeholder:text-stone-600";
const primaryButton =
  "flex min-h-12 items-center justify-center gap-2 rounded-xl bg-ink-900 px-5 text-sm font-extrabold text-white transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 dark:bg-mint-400 dark:text-ink-950";
const secondaryButton =
  "flex min-h-11 items-center justify-center gap-2 rounded-xl border border-stone-200 bg-white px-4 text-xs font-extrabold transition hover:border-mint-400 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/5";

export function CloudflareManagementPage({
  t,
  locale,
  role,
}: {
  t: Translate;
  locale: Locale;
  role: Role;
}) {
  const [tab, setTab] = useState<Tab>("accounts");
  const [accounts, setAccounts] = useState<CloudflareAccount[]>([]);
  const [zonesByAccount, setZonesByAccount] = useState<
    Record<string, CloudflareZone[]>
  >({});
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [routes, setRoutes] = useState<ManagedRoute[]>([]);
  const [domainAccess, setDomainAccess] = useState<CloudflareDomainAccess[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [accountModalError, setAccountModalError] = useState("");
  const [domainModalError, setDomainModalError] = useState("");
  const [success, setSuccess] = useState("");
  const [createModal, setCreateModal] = useState<"account" | "hostname" | null>(
    null,
  );
  const [accountName, setAccountName] = useState("");
  const [accountIdentifier, setAccountIdentifier] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [accountEnabled, setAccountEnabled] = useState(true);
  const [createManagedTunnel, setCreateManagedTunnel] = useState(true);
  const [accountAgentId, setAccountAgentId] = useState("");
  const [accountConnectorName, setAccountConnectorName] = useState("gateway-tunnel");
  const [zoneId, setZoneId] = useState("");
  const [connectorId, setConnectorId] = useState("");
  const [routeId, setRouteId] = useState("");
  const [accessMethod, setAccessMethod] = useState<"tunnel" | "public_ip">("tunnel");
  const [publicIpv4, setPublicIpv4] = useState("");
  const [publicIpv6, setPublicIpv6] = useState("");
  const [proxied, setProxied] = useState(true);
  const [wizardStep, setWizardStep] = useState(1);
  const [publishHostname, setPublishHostname] = useState("");
  const [publishAgentId, setPublishAgentId] = useState("");
  const [targetKind, setTargetKind] = useState<"host_port" | "url">("host_port");
  const [publishTarget, setPublishTarget] = useState("5800");
  const [publishKey, setPublishKey] = useState(() => crypto.randomUUID());
  const [pendingPublishId, setPendingPublishId] = useState("");
  const accountSelectionGeneration = useRef(0);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [accountResult, connectorResult, routeResult, hostnameResult, agentResult] =
        await Promise.all([
          api.cloudflareAccounts(),
          api.connectors(),
          api.routes(),
          api.cloudflareDomainAccess(),
          api.agents(),
        ]);
      setAccounts(accountResult.accounts);
      setConnectors(connectorResult.connectors);
      setRoutes(routeResult.routes);
      setDomainAccess(hostnameResult.domainAccess);
      setAgents(agentResult.agents);
      setAccountAgentId((current) => current || agentResult.agents.find((agent) => agent.enabled && agent.enrolledAt)?.id || "");
      const selected =
        selectedAccountId &&
        accountResult.accounts.some(
          (account) => account.id === selectedAccountId,
        )
          ? selectedAccountId
          : accountResult.accounts[0]?.id || "";
      setSelectedAccountId(selected);
      const zoneResults = await Promise.all(
        accountResult.accounts.map(
          async (account) =>
            [
              account.id,
              (await api.cloudflareZones(account.id)).zones,
            ] as const,
        ),
      );
      const nextZones = Object.fromEntries(zoneResults);
      setZonesByAccount(nextZones);
      setZoneId((current) =>
        Object.values(nextZones)
          .flat()
          .some((zone) => zone.id === current)
          ? current
          : nextZones[selected]?.[0]?.id || "",
      );
    } catch (caught) {
      setError(friendlyError(caught, t));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function selectAccount(id: string, openZones = false) {
    const generation = ++accountSelectionGeneration.current;
    setSelectedAccountId(id);
    setZoneId("");
    setConnectorId("");
    setRouteId("");
    setError("");
    setSuccess("");
    if (openZones) setTab("zones");
    if (!id) {
      setBusy("");
      return;
    }
    setBusy(`zones:${id}`);
    try {
      const result = await api.cloudflareZones(id);
      if (generation !== accountSelectionGeneration.current) return;
      setZonesByAccount((current) => ({ ...current, [id]: result.zones }));
      setZoneId(result.zones[0]?.id || "");
    } catch (caught) {
      if (generation !== accountSelectionGeneration.current) return;
      setError(friendlyError(caught, t));
    } finally {
      if (generation === accountSelectionGeneration.current) setBusy("");
    }
  }

  async function createAccount(event: React.FormEvent) {
    event.preventDefault();
    setAccountModalError("");
    setSuccess("");
    if (!/^[a-fA-F0-9]{32}$/.test(accountIdentifier) || apiToken.length < 20 || (createManagedTunnel && (!accountAgentId || !accountConnectorName.trim()))) {
      setAccountModalError(t("validationError"));
      return;
    }
    setBusy("create-account");
    try {
      const result = await api.createCloudflareAccount({
        name: accountName.trim(),
        accountIdentifier,
        apiToken,
        enabled: accountEnabled,
        createManagedTunnel,
        ...(createManagedTunnel ? { agentId: accountAgentId, connectorName: accountConnectorName.trim() } : {}),
      });
      setAccounts((current) => [result.account, ...current]);
      setZonesByAccount((current) => ({ ...current, [result.account.id]: [] }));
      setSelectedAccountId(result.account.id);
      setAccountName("");
      setAccountIdentifier("");
      setApiToken("");
      setAccountEnabled(true);
      setCreateManagedTunnel(true);
      setAccountConnectorName("gateway-tunnel");
      setCreateModal(null);
      if (result.connector) setConnectors((current) => [result.connector!, ...current]);
      setSuccess(result.tunnel ? `${zoneResultMessage(t, locale, "cloudflareSyncWithZones", "cloudflareSyncNoZones", result.zoneCount ?? 0)} ${result.tunnel.name} · ${result.connector?.deploymentStatus ?? "pending"}` : t("cloudflareAccountCreated"));
    } catch (caught) {
      setAccountModalError(friendlyError(caught, t));
    } finally {
      setBusy("");
    }
  }

  async function toggleAccount(account: CloudflareAccount) {
    setBusy(`account:${account.id}`);
    setError("");
    setSuccess("");
    try {
      const result = await api.updateCloudflareAccount(account.id, {
        enabled: !account.enabled,
      });
      setAccounts((current) =>
        current.map((item) => (item.id === account.id ? result.account : item)),
      );
    } catch (caught) {
      setError(friendlyError(caught, t));
    } finally {
      setBusy("");
    }
  }

  async function deleteAccount(account: CloudflareAccount) {
    if (!window.confirm(t("confirmDeleteCloudflareAccount"))) return;
    setBusy(`delete:${account.id}`);
    setError("");
    setSuccess("");
    try {
      await api.deleteCloudflareAccount(account.id);
      setAccounts((current) => current.filter((item) => item.id !== account.id));
      setZonesByAccount((current) => {
        const next = { ...current };
        delete next[account.id];
        return next;
      });
      if (selectedAccountId === account.id) setSelectedAccountId("");
      setSuccess(t("cloudflareAccountDeleted"));
    } catch (caught) {
      setError(caught instanceof ApiError && caught.code === "cloudflare_account_delete_blocked" ? t("cloudflareAccountDeleteBlocked") : friendlyError(caught, t));
    } finally {
      setBusy("");
    }
  }

  async function accountAction(
    account: CloudflareAccount,
    action: "test" | "sync",
  ) {
    setBusy(`${action}:${account.id}`);
    setError("");
    setSuccess("");
    try {
      if (action === "test") {
        const result = await api.testCloudflareAccount(account.id);
        setSuccess(zoneResultMessage(t, locale, "cloudflareTestWithZones", "cloudflareNoZoneAccess", result.zoneCount, "cloudflareTestSucceeded"));
      } else {
        const result = await api.syncCloudflareAccount(account.id);
        setZonesByAccount((current) => ({
          ...current,
          [account.id]: result.zones,
        }));
        setSelectedAccountId(account.id);
        setZoneId(result.zones[0]?.id || "");
        const refreshed = await api.cloudflareAccounts();
        setAccounts(refreshed.accounts);
        setSuccess(zoneResultMessage(t, locale, "cloudflareSyncWithZones", "cloudflareSyncNoZones", result.zoneCount ?? result.zones.length));
      }
    } catch (caught) {
      setError(friendlyError(caught, t));
      try {
        const refreshed = await api.cloudflareAccounts();
        setAccounts(refreshed.accounts);
      } catch {
        // Preserve the actionable operation error if refreshing account state also fails.
      }
    } finally {
      setBusy("");
    }
  }

  const selectedZones = zonesByAccount[selectedAccountId] || [];
  const selectedZone = Object.values(zonesByAccount)
    .flat()
    .find((zone) => zone.id === zoneId);
  const eligibleConnectors = connectors.filter(
    (connector) =>
      connector.enabled &&
      connector.identityStatus === "verified" &&
      connector.tokenTunnelId && connector.tunnelId === connector.tokenTunnelId &&
      connector.cloudflareAccountId === selectedZone?.cloudflareAccountId &&
      (!publishAgentId || connector.agentId === publishAgentId),
  );

  const parsedIpv4 = parseIpList(publicIpv4);
  const parsedIpv6 = parseIpList(publicIpv6);

  function advanceWizard() {
    setDomainModalError("");
    if (wizardStep === 1 && (!selectedAccountId || !zoneId || !publishHostname || !selectedZone || !hostnameWithinZone(publishHostname, selectedZone.name))) return setDomainModalError(t("validationError"));
    if (wizardStep === 2 && (!publishAgentId || !publishTarget.trim())) return setDomainModalError(t("validationError"));
    if (wizardStep === 3 && ((accessMethod === "tunnel" && !connectorId) || (accessMethod === "public_ip" && (parsedIpv4.length + parsedIpv6.length === 0 || parsedIpv4.length > 4 || parsedIpv6.length > 4)))) return setDomainModalError(t("validationError"));
    setWizardStep((current) => Math.min(4, current + 1));
  }

  async function createDomainAccess(event: React.FormEvent) {
    event.preventDefault();
    setDomainModalError("");
    setSuccess("");
    if (!selectedAccountId || !zoneId || !publishHostname || !publishAgentId || !publishTarget || (accessMethod === "tunnel" && !connectorId) || (accessMethod === "public_ip" && parsedIpv4.length + parsedIpv6.length === 0)) {
      setDomainModalError(t("validationError"));
      return;
    }
    setBusy("create-hostname");
    try {
      const result = await api.guidedPublishDomain({
        accountId: selectedAccountId,
        zoneId,
        hostname: publishHostname,
        agentId: publishAgentId,
        targetKind,
        target: publishTarget,
        accessMethod,
        ...(accessMethod === "tunnel" ? { connectorId } : { publicIpv4: parsedIpv4, publicIpv6: parsedIpv6 }),
      }, publishKey);
      if (result.route) setRoutes((current) => current.some((route) => route.id === result.route.id) ? current.map((route) => route.id === result.route.id ? result.route : route) : [result.route, ...current]);
      if (result.domainAccess) setDomainAccess((current) => [result.domainAccess!, ...current]);
      setPendingPublishId(result.operation.status === "waiting" ? result.operation.id : "");
      setConnectorId("");
      setRouteId("");
      setAccessMethod("tunnel");
      setPublicIpv4("");
      setPublicIpv6("");
      setProxied(true);
      setPublishHostname("");
      setPublishTarget("5800");
      setPublishKey(crypto.randomUUID());
      setWizardStep(1);
      setCreateModal(null);
      setSuccess(result.operation.status === "waiting" ? t("pending") : t("domainAccessCreated"));
    } catch (caught) {
      setDomainModalError(friendlyError(caught, t));
    } finally {
      setBusy("");
    }
  }

  async function reconcilePendingPublish() {
    if (!pendingPublishId) return;
    setBusy("guided-reconcile"); setError("");
    try {
      const result = await api.reconcileGuidedPublish(pendingPublishId);
      if (result.route) setRoutes((current) => current.map((route) => route.id === result.route.id ? result.route : route));
      if (result.domainAccess) setDomainAccess((current) => current.some((item) => item.id === result.domainAccess!.id) ? current : [result.domainAccess!, ...current]);
      if (result.operation.status === "succeeded") setPendingPublishId("");
      setSuccess(result.operation.status === "succeeded" ? t("domainAccessCreated") : t("pending"));
    } catch (caught) { setError(friendlyError(caught, t)); } finally { setBusy(""); }
  }

  async function domainAccessAction(item: CloudflareDomainAccess, action: "toggle" | "reconcile") {
    setBusy(`access:${item.id}`);
    setError("");
    setSuccess("");
    try {
      const result = action === "reconcile"
        ? await api.reconcileCloudflareDomainAccess(item.id)
        : await api.updateCloudflareDomainAccess(item.id, !item.enabled);
      setDomainAccess((current) =>
        current.map((access) => access.id === item.id ? result.domainAccess : access),
      );
      setSuccess(t(action === "reconcile" ? "domainAccessReconciled" : "domainAccessUpdated"));
    } catch (caught) {
      setError(friendlyError(caught, t));
      try { setDomainAccess((await api.cloudflareDomainAccess()).domainAccess); } catch { /* Keep the primary error visible. */ }
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[112rem] min-w-0 flex-col gap-6">
      <section className="surface-glow relative overflow-hidden rounded-[1.75rem] bg-ink-900 p-6 text-white shadow-xl sm:p-8 lg:p-10">
        <div className="relative grid gap-8 lg:grid-cols-[1fr_auto] lg:items-end">
          <div className="max-w-3xl">
            <p className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.14em] text-orange-300">
              <Cloud size={15} />
              Cloudflare
            </p>
            <h1 className="pt-3 text-3xl font-black tracking-[-0.045em] sm:text-4xl">
              {t("domainAccessTitle")}
            </h1>
            <p className="max-w-2xl pt-3 text-sm font-medium leading-7 text-stone-400 sm:text-base">
              {t("domainAccessDescription")}
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 rounded-2xl border border-white/10 bg-white/[0.04] p-2 text-center">
            <HeroStat value={new Intl.NumberFormat(locale).format(accounts.length)} label={t("cloudflareAccounts")} />
            <HeroStat
              value={new Intl.NumberFormat(locale).format(Object.values(zonesByAccount).flat().length)}
              label={t("cloudflareZones")}
            />
            <HeroStat
              value={new Intl.NumberFormat(locale).format(domainAccess.length)}
              label={t("domainAccess")}
            />
          </div>
        </div>
      </section>
      <div className="max-w-full overflow-hidden rounded-2xl border border-stone-200/80 bg-white/70 p-1.5 dark:border-white/[0.07] dark:bg-white/[0.025]">
        <div
          role="tablist"
          aria-label={t("domainAccessTitle")}
          className="flex max-w-full gap-1 overflow-x-auto overscroll-x-contain"
        >
          {(
            [
              ["accounts", "cloudflareAccounts", KeyRound],
              ["zones", "cloudflareZones", Globe2],
               ["hostnames", "domainAccess", Link2],
            ] as Array<[Tab, MessageKey, LucideIcon]>
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              role="tab"
              aria-selected={tab === value}
              type="button"
              onClick={() => setTab(value)}
              className={`flex min-h-12 min-w-max flex-1 items-center justify-center gap-2 rounded-xl px-4 text-sm font-extrabold transition ${tab === value ? "bg-ink-900 text-white shadow-lg dark:bg-mint-400 dark:text-ink-950" : "text-stone-500 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-white/5"}`}
            >
              <Icon size={17} />
              {t(label)}
            </button>
          ))}
        </div>
      </div>
      {role === "viewer" && <Notice>{t("cloudflareViewerNotice")}</Notice>}
      {error && <Alert>{error}</Alert>}
      {success && <Success>{success}</Success>}
      {loading ? (
        <Loading t={t} />
      ) : tab === "accounts" ? (
        <AccountsArea
          t={t}
          locale={locale}
          role={role}
          accounts={accounts}
          selectedAccountId={selectedAccountId}
          busy={busy}
          modalError={accountModalError}
          createOpen={createModal === "account"}
           openCreate={() => { setAccountModalError(""); setError(""); setSuccess(""); setCreateModal("account") }}
          closeCreate={() => {
            setAccountName("");
            setAccountIdentifier("");
            setApiToken("");
            setAccountEnabled(true);
            setCreateManagedTunnel(true);
            setAccountConnectorName("gateway-tunnel");
             setAccountModalError("");
            setCreateModal(null);
          }}
          form={{
            accountName,
            accountIdentifier,
            apiToken,
            accountEnabled,
            createManagedTunnel,
            accountAgentId,
            accountConnectorName,
            agents,
            setAccountName,
            setAccountIdentifier,
            setApiToken,
            setAccountEnabled,
            setCreateManagedTunnel,
            setAccountAgentId,
            setAccountConnectorName,
            submit: createAccount,
          }}
          selectAccount={(id) => void selectAccount(id, true)}
          toggleAccount={(account) => void toggleAccount(account)}
          deleteAccount={(account) => void deleteAccount(account)}
          action={(account, action) => void accountAction(account, action)}
        />
      ) : tab === "zones" ? (
        <ZonesArea
          t={t}
          accounts={accounts}
          selectedAccountId={selectedAccountId}
          zones={selectedZones}
          busy={busy}
          selectAccount={(id) => void selectAccount(id)}
          refresh={() =>
            selectedAccountId && void selectAccount(selectedAccountId)
          }
        />
      ) : (
        <HostnamesArea
           modalError={domainModalError}
          t={t}
          role={role}
          zones={Object.values(zonesByAccount).flat()}
          connectors={connectors}
          routes={routes}
           domainAccess={domainAccess}
          selectedAccountId={selectedAccountId}
          zoneId={zoneId}
          connectorId={connectorId}
           routeId={routeId}
           accessMethod={accessMethod}
           publicIpv4={publicIpv4}
           publicIpv6={publicIpv6}
           proxied={proxied}
           wizardStep={wizardStep}
           eligibleConnectors={eligibleConnectors}
           agents={agents}
           publishHostname={publishHostname}
           publishAgentId={publishAgentId}
           targetKind={targetKind}
           publishTarget={publishTarget}
           pendingPublishId={pendingPublishId}
          busy={busy}
          createOpen={createModal === "hostname"}
           openCreate={() => { setDomainModalError(""); setError(""); setSuccess(""); setCreateModal("hostname") }}
          closeCreate={() => {
             setConnectorId("");
             setRouteId("");
             setPublishHostname("");
             setPublishTarget("5800");
             setAccessMethod("tunnel");
             setPublicIpv4("");
             setPublicIpv6("");
             setProxied(true);
             setWizardStep(1);
             setDomainModalError("");
            setCreateModal(null);
          }}
           setSelectedAccountId={(id) => {
             accountSelectionGeneration.current += 1;
             setSelectedAccountId(id);
            setZoneId(zonesByAccount[id]?.[0]?.id || "");
            setConnectorId("");
            setRouteId("");
          }}
          setZoneId={(id) => {
            setZoneId(id);
            setConnectorId("");
            setRouteId("");
          }}
           setConnectorId={setConnectorId}
           setRouteId={setRouteId}
           setAccessMethod={(method) => { setAccessMethod(method); setConnectorId(""); setRouteId(""); setPublicIpv4(""); setPublicIpv6("") }}
           setPublicIpv4={setPublicIpv4}
           setPublicIpv6={setPublicIpv6}
           setProxied={setProxied}
           setPublishHostname={setPublishHostname}
           setPublishAgentId={(id) => { setPublishAgentId(id); setConnectorId(""); }}
           setTargetKind={setTargetKind}
           setPublishTarget={setPublishTarget}
           setWizardStep={setWizardStep}
           next={advanceWizard}
           submit={createDomainAccess}
           action={(item, action) => void domainAccessAction(item, action)}
           reconcilePending={() => void reconcilePendingPublish()}
          accounts={accounts}
        />
      )}
    </div>
  );
}

type AccountForm = {
  accountName: string;
  accountIdentifier: string;
  apiToken: string;
  accountEnabled: boolean;
  createManagedTunnel: boolean;
  accountAgentId: string;
  accountConnectorName: string;
  agents: Agent[];
  setAccountName: (value: string) => void;
  setAccountIdentifier: (value: string) => void;
  setApiToken: (value: string) => void;
  setAccountEnabled: (value: boolean) => void;
  setCreateManagedTunnel: (value: boolean) => void;
  setAccountAgentId: (value: string) => void;
  setAccountConnectorName: (value: string) => void;
  submit: (event: React.FormEvent) => void;
};

function AccountsArea({
  t,
  locale,
  role,
  accounts,
  selectedAccountId,
  busy,
  modalError,
  createOpen,
  openCreate,
  closeCreate,
  form,
  selectAccount,
  toggleAccount,
  deleteAccount,
  action,
}: {
  t: Translate;
  locale: Locale;
  role: Role;
  accounts: CloudflareAccount[];
  selectedAccountId: string;
  busy: string;
  modalError: string;
  createOpen: boolean;
  openCreate: () => void;
  closeCreate: () => void;
  form: AccountForm;
  selectAccount: (id: string) => void;
  toggleAccount: (account: CloudflareAccount) => void;
  deleteAccount: (account: CloudflareAccount) => void;
  action: (account: CloudflareAccount, action: "test" | "sync") => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {role !== "viewer" && (
        <div className="flex justify-end">
          <button type="button" className={primaryButton} onClick={openCreate}>
            <Plus size={17} />
            {t("addAccount")}
          </button>
        </div>
      )}
      {role !== "viewer" && (
        <Modal
          open={createOpen}
          title={t("addCloudflareAccount")}
          description={t("cloudflareCredentialsHint")}
          closeLabel={t("cancel")}
          busy={busy === "create-account"}
          maxWidthClass="max-w-3xl"
          onClose={closeCreate}
        >
          <form onSubmit={form.submit} className="flex min-h-0 flex-col">
            {modalError && <div className="px-5 pt-5 sm:px-6"><Alert>{modalError}</Alert></div>}
            <div className="flex items-start justify-between gap-3 border-b border-stone-200/80 px-5 py-4 dark:border-white/[0.06] sm:px-6">
              <p className="max-w-xl text-xs font-semibold leading-5 text-stone-500 dark:text-stone-400">
                {t("cloudflareCredentialsHelpSummary")}
              </p>
              <CloudflareCredentialsHelp t={t} />
            </div>
            <div className="grid grid-cols-1 items-start gap-4 p-5 sm:grid-cols-2 sm:p-6">
              <Field label={t("accountName")}>
                <input
                  autoFocus
                  required
                  maxLength={120}
                  value={form.accountName}
                  onChange={(event) => form.setAccountName(event.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field
                label={t("accountIdentifier")}
                hint={t("accountIdentifierHint")}
              >
                <input
                  required
                  dir="ltr"
                  minLength={32}
                  maxLength={32}
                  pattern="[a-fA-F0-9]{32}"
                  value={form.accountIdentifier}
                  onChange={(event) =>
                    form.setAccountIdentifier(event.target.value.trim())
                  }
                  className={`${inputClass} text-left font-mono`}
                />
              </Field>
              <div className="sm:col-span-2">
              <Field
                label={t("cloudflareApiToken")}
                hint={t("apiTokenNeverShown")}
              >
                <input
                  required
                  dir="ltr"
                  type="password"
                  minLength={20}
                  autoComplete="new-password"
                  value={form.apiToken}
                  onChange={(event) => form.setApiToken(event.target.value)}
                  className={`${inputClass} text-left font-mono`}
                />
              </Field>
              </div>
              <div className="sm:col-span-2 rounded-2xl border border-mint-400/30 bg-mint-400/5 p-4">
                <div className="flex items-center gap-3">
                  <Toggle enabled={form.createManagedTunnel} setEnabled={form.setCreateManagedTunnel} label={t("tunnel")} />
                  <div><p className="text-xs font-extrabold text-ink-900 dark:text-white">{t("createManagedTunnelLabel")}</p><p className="pt-1 text-[0.68rem] font-medium text-stone-500 dark:text-stone-400">{t("createManagedTunnelHint")}</p></div>
                </div>
                {form.createManagedTunnel && <div className="grid grid-cols-1 gap-4 pt-4 sm:grid-cols-2">
                  <Field label={t("assignedAgent")}><select required value={form.accountAgentId} onChange={(event) => form.setAccountAgentId(event.target.value)} className={inputClass}><option value="">{t("chooseAgent")}</option>{form.agents.filter((agent) => agent.enabled && agent.enrolledAt).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></Field>
                  <Field label={t("connectorName")}><input required maxLength={120} value={form.accountConnectorName} onChange={(event) => form.setAccountConnectorName(event.target.value)} className={inputClass} /></Field>
                </div>}
              </div>
            </div>
            <footer className="flex flex-col gap-4 border-t border-stone-200/80 p-5 dark:border-white/[0.06] sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-4">
              <div className="flex min-h-11 items-center gap-3">
                <Toggle
                  enabled={form.accountEnabled}
                  setEnabled={form.setAccountEnabled}
                  label={t(form.accountEnabled ? "enabled" : "disabled")}
                />
                <span className="text-xs font-extrabold">{t(form.accountEnabled ? "enabled" : "disabled")}</span>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:flex">
                <button type="button" disabled={busy === "create-account"} className={secondaryButton} onClick={closeCreate}>
                  {t("cancel")}
                </button>
              <button
                disabled={busy === "create-account"}
                className={primaryButton}
              >
                <Plus size={17} />
                {t("addAccount")}
              </button>
              </div>
            </footer>
          </form>
        </Modal>
      )}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {accounts.map((account) => (
          <article
            key={account.id}
            className={`${panelClass} min-w-0 p-5 sm:p-6 ${selectedAccountId === account.id ? "ring-2 ring-orange-400/50" : ""}`}
          >
            <div className="flex items-start justify-between gap-4">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-orange-500/10 text-orange-600 dark:text-orange-300">
                <Cloud size={21} />
              </span>
              {role === "viewer" ? (
                <Status
                  active={account.enabled}
                  label={t(account.enabled ? "enabled" : "disabled")}
                />
              ) : (
                <Toggle
                  enabled={account.enabled}
                  setEnabled={() => toggleAccount(account)}
                  disabled={busy === `account:${account.id}`}
                  label={t(account.enabled ? "enabled" : "disabled")}
                />
              )}
            </div>
            <h2 className="truncate pt-5 text-base font-black text-ink-900 dark:text-white">
              {account.name}
            </h2>
            <TechnicalValue
              label={t("accountIdentifier")}
              value={account.accountIdentifier}
            />
            <div className="grid grid-cols-1 gap-3 pt-4 sm:grid-cols-2">
              <Meta
                label={t("lastSync")}
                value={
                  account.lastSyncedAt
                    ? formatDate(account.lastSyncedAt, locale)
                    : t("never")
                }
              />
              <Meta
                label={t("lastError")}
                value={
                  account.lastErrorAt
                    ? formatDate(account.lastErrorAt, locale)
                    : t("none")
                }
                danger={Boolean(account.lastError)}
              />
            </div>
            {account.lastError && (
              <p className="flex items-start gap-2 pt-4 text-xs font-bold leading-5 text-rose-600 dark:text-rose-300">
                <TriangleAlert className="mt-0.5 shrink-0" size={14} />
                {t("cloudflareOperationFailed")}
              </p>
            )}
            <p className="flex items-center gap-2 pt-4 text-[0.68rem] font-bold text-stone-400">
              <ShieldCheck size={14} className="text-mint-500" />
              {t("apiTokenNeverShown")}
            </p>
            <div
              className={`grid grid-cols-1 gap-2 pt-5 ${role === "viewer" ? "" : role === "owner" ? "sm:grid-cols-2 xl:grid-cols-4" : "sm:grid-cols-3"}`}
            >
              <button
                type="button"
                className={secondaryButton}
                onClick={() => selectAccount(account.id)}
              >
                <Globe2 size={15} />
                {t("viewZones")}
              </button>
              {role !== "viewer" && (
                <>
                  <button
                    type="button"
                    disabled={busy === `test:${account.id}`}
                    className={secondaryButton}
                    onClick={() => action(account, "test")}
                  >
                    <ShieldCheck size={15} />
                    {t("testZoneAccess")}
                  </button>
                  <button
                    type="button"
                    disabled={busy === `sync:${account.id}`}
                    className={secondaryButton}
                    onClick={() => action(account, "sync")}
                  >
                    <RotateCw
                      className={
                        busy === `sync:${account.id}` ? "animate-spin" : ""
                      }
                      size={15}
                    />
                    {t("syncZones")}
                  </button>
                  {role === "owner" && <button
                    type="button"
                    disabled={busy === `delete:${account.id}`}
                    className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-rose-300/70 bg-white px-4 text-xs font-extrabold text-rose-700 transition hover:border-rose-400 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-400/30 dark:bg-white/5 dark:text-rose-300"
                    onClick={() => deleteAccount(account)}
                  >
                    <Trash2 size={15} />
                    {t("deleteAccount")}
                  </button>}
                </>
              )}
            </div>
          </article>
        ))}
        {accounts.length === 0 && (
          <Empty icon={Cloud} text={t("noCloudflareAccounts")} />
        )}
      </section>
    </div>
  );
}

function CloudflareCredentialsHelp({ t }: { t: Translate }) {
  return (
    <HelpPopover label={t("credentialsHelp")} title={t("cloudflareCredentialsHelpTitle")} closeLabel={t("close")}>
      <p>{t("cloudflareAccountIdSteps")}</p>
      <p>{t("cloudflareApiTokenSteps")}</p>
      <div>
        <p className="font-extrabold text-ink-900 dark:text-white">{t("cloudflareRequiredScopes")}</p>
        <ul className="list-disc space-y-1 pt-1 ps-4">
          <li><bdi dir="ltr">Account / Cloudflare Tunnel / Edit</bdi></li>
          <li><bdi dir="ltr">Zone / Zone / Read</bdi></li>
          <li><bdi dir="ltr">Zone / DNS / Edit</bdi></li>
        </ul>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        <a href="https://dash.cloudflare.com/" target="_blank" rel="noreferrer" className="font-extrabold text-mint-600 underline underline-offset-4 dark:text-mint-300">{t("openCloudflareDashboard")}</a>
        <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer" className="font-extrabold text-mint-600 underline underline-offset-4 dark:text-mint-300">{t("openCloudflareApiTokens")}</a>
      </div>
    </HelpPopover>
  );
}

function ZonesArea({
  t,
  accounts,
  selectedAccountId,
  zones,
  busy,
  selectAccount,
  refresh,
}: {
  t: Translate;
  accounts: CloudflareAccount[];
  selectedAccountId: string;
  zones: CloudflareZone[];
  busy: string;
  selectAccount: (id: string) => void;
  refresh: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <section
        className={`${panelClass} flex flex-col gap-4 p-5 sm:flex-row sm:items-end sm:justify-between sm:p-6`}
      >
        <div className="w-full max-w-xl">
          <Field label={t("cloudflareAccount")} hint={t("zoneAccountHint")}>
            <select
              value={selectedAccountId}
              onChange={(event) => selectAccount(event.target.value)}
              className={inputClass}
            >
              <option value="">{t("chooseAccount")}</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <button
          type="button"
          disabled={!selectedAccountId || busy === `zones:${selectedAccountId}`}
          className={secondaryButton}
          onClick={refresh}
        >
          <RefreshCw
            className={
              busy === `zones:${selectedAccountId}` ? "animate-spin" : ""
            }
            size={15}
          />
          {t("refreshZones")}
        </button>
      </section>
      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {zones.map((zone) => (
          <article key={zone.id} className={`${panelClass} min-w-0 p-5 sm:p-6`}>
            <div className="flex items-center justify-between gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-sky-500/10 text-sky-600 dark:text-sky-300">
                <Globe2 size={21} />
              </span>
              <Status
                active={zone.status === "active"}
                label={zone.status}
                technical
              />
            </div>
            <h2 className="break-words pt-5 text-lg font-black text-ink-900 dark:text-white">
              <bdi dir="ltr">{zone.name}</bdi>
            </h2>
            <TechnicalValue
              label={t("zoneIdentifier")}
              value={zone.zoneIdentifier}
            />
          </article>
        ))}
        {selectedAccountId && zones.length === 0 && (
          <Empty icon={Globe2} text={t("noSyncedZones")} />
        )}
        {!selectedAccountId && (
          <Empty icon={Cloud} text={t("chooseAccountForZones")} />
        )}
      </section>
    </div>
  );
}

type HostnamesAreaProps = {
  modalError: string;
  t: Translate;
  role: Role;
  accounts: CloudflareAccount[];
  zones: CloudflareZone[];
  connectors: Connector[];
  routes: ManagedRoute[];
  domainAccess: CloudflareDomainAccess[];
  selectedAccountId: string;
  zoneId: string;
  connectorId: string;
  routeId: string;
  accessMethod: "tunnel" | "public_ip";
  publicIpv4: string;
  publicIpv6: string;
  proxied: boolean;
  wizardStep: number;
  eligibleConnectors: Connector[];
  agents: Agent[];
  publishHostname: string;
  publishAgentId: string;
  targetKind: "host_port" | "url";
  publishTarget: string;
  pendingPublishId: string;
  busy: string;
  createOpen: boolean;
  openCreate: () => void;
  closeCreate: () => void;
  setSelectedAccountId: (value: string) => void;
  setZoneId: (value: string) => void;
  setConnectorId: (value: string) => void;
  setRouteId: (value: string) => void;
  setAccessMethod: (value: "tunnel" | "public_ip") => void;
  setPublicIpv4: (value: string) => void;
  setPublicIpv6: (value: string) => void;
  setProxied: (value: boolean) => void;
  setPublishHostname: (value: string) => void;
  setPublishAgentId: (value: string) => void;
  setTargetKind: (value: "host_port" | "url") => void;
  setPublishTarget: (value: string) => void;
  setWizardStep: (value: number) => void;
  next: () => void;
  submit: (event: React.FormEvent) => void;
  action: (item: CloudflareDomainAccess, action: "toggle" | "reconcile") => void;
  reconcilePending: () => void;
};

function HostnamesArea(props: HostnamesAreaProps) {
  const { t } = props;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {props.role !== "viewer" && (
        <div className="flex flex-wrap justify-end gap-2">
          {props.pendingPublishId && <button type="button" disabled={props.busy === "guided-reconcile"} className={secondaryButton} onClick={props.reconcilePending}><RefreshCw size={16} />{t("reconcile")}</button>}
          <button type="button" className={primaryButton} onClick={props.openCreate}>
            <Plus size={17} />
            {t("createDomainAccess")}
          </button>
        </div>
      )}
      {props.role !== "viewer" && (
        <Modal
          open={props.createOpen}
          title={t("createDomainAccess")}
          description={t("domainAccessWizardHint")}
          closeLabel={t("cancel")}
          busy={props.busy === "create-hostname"}
          maxWidthClass="max-w-6xl"
          onClose={props.closeCreate}
        >
          <form onSubmit={props.submit} className="min-w-0">
          {props.modalError && <div className="px-5 pt-5 sm:px-6"><Alert>{props.modalError}</Alert></div>}
          <div className="grid grid-cols-4 gap-1 border-b border-stone-200/80 p-4 dark:border-white/[0.06] sm:gap-2 sm:p-6">
            {["domainAccessScope", "domainAccessTarget", "accessMethod", "review"].map((label, index) => (
              <div key={label} className={`min-w-0 rounded-xl px-2 py-2 text-center text-[0.62rem] font-extrabold sm:px-3 sm:text-xs ${props.wizardStep === index + 1 ? "bg-ink-900 text-white dark:bg-mint-400 dark:text-ink-950" : "bg-stone-100 text-stone-400 dark:bg-white/5"}`}>
                <span dir="ltr" className="block text-[0.56rem] opacity-70">{index + 1}/4</span>
                <span className="block truncate pt-1">{t(label as MessageKey)}</span>
              </div>
            ))}
          </div>
          <div className="min-h-[18rem] p-5 sm:p-6">
          {props.wizardStep === 1 && <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <RelationshipField number="01" label={t("cloudflareAccount")}>
              <select
                value={props.selectedAccountId}
                onChange={(event) =>
                  props.setSelectedAccountId(event.target.value)
                }
                className={inputClass}
              >
                <option value="">{t("chooseAccount")}</option>
                {props.accounts
                  .filter((account) => account.enabled)
                  .map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
              </select>
            </RelationshipField>
            <RelationshipField number="02" label={t("cloudflareZone")}>
              <select
                required
                value={props.zoneId}
                onChange={(event) => props.setZoneId(event.target.value)}
                className={inputClass}
              >
                <option value="">{t("chooseZone")}</option>
                {props.zones
                   .filter(
                     (zone) =>
                       zone.cloudflareAccountId === props.selectedAccountId && zone.status === "active",
                  )
                  .map((zone) => (
                    <option key={zone.id} value={zone.id}>
                      {zone.name}
                    </option>
                  ))}
              </select>
            </RelationshipField>
            <RelationshipField number="03" label={t("hostname")}>
              <input required dir="ltr" maxLength={253} value={props.publishHostname} onChange={(event) => props.setPublishHostname(event.target.value.trim().toLowerCase())} className={`${inputClass} text-left font-mono`} placeholder="app.example.com" />
            </RelationshipField>
          </div>}
          {props.wizardStep === 2 && <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <Field label={t("assignedAgent")}><select required value={props.publishAgentId} onChange={(event) => props.setPublishAgentId(event.target.value)} className={inputClass}><option value="">{t("chooseAgent")}</option>{props.agents.filter((agent) => agent.enabled && agent.enrolledAt).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></Field>
            <Field label={t("targetKind")}><select value={props.targetKind} onChange={(event) => props.setTargetKind(event.target.value as "host_port" | "url")} className={inputClass}><option value="host_port">{t("hostPortTarget")}</option><option value="url">{t("explicitUrlTarget")}</option></select></Field>
            <div className="md:col-span-2"><Field label={t("domainAccessTarget")} hint={t("targetSecurityHint")}><input required dir="ltr" maxLength={2048} value={props.publishTarget} onChange={(event) => props.setPublishTarget(event.target.value)} className={`${inputClass} text-left font-mono`} placeholder={props.targetKind === "host_port" ? "5800" : "http://service:8080"} /></Field></div>
          </div>}
          {props.wizardStep === 3 && <div className="flex flex-col gap-5"><div role="radiogroup" aria-label={t("accessMethod")} className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {(["tunnel", "public_ip"] as const).map((method) => (
              <button key={method} type="button" role="radio" aria-checked={props.accessMethod === method} onClick={() => { props.setAccessMethod(method); props.setConnectorId(""); }} className={`min-h-40 rounded-2xl border p-5 text-start transition ${props.accessMethod === method ? "border-mint-400 bg-mint-400/10 ring-4 ring-mint-400/10" : "border-stone-200 bg-white/50 dark:border-white/10 dark:bg-white/[0.02]"}`}>
                <span className="text-base font-black text-ink-900 dark:text-white">{t(method === "tunnel" ? "tunnel" : "publicIp")}</span>
                <span className="block pt-3 text-xs font-medium leading-6 text-stone-500 dark:text-stone-400">{t(method === "tunnel" ? "domainAccessTunnelPath" : "domainAccessPublicPath")}</span>
              </button>
            ))}
          </div>
            {props.accessMethod === "tunnel" ? <Field label={t("cloudflareConnector")} hint={t("sameAgentConnectorHint")}>
              <select required value={props.connectorId} onChange={(event) => props.setConnectorId(event.target.value)} className={inputClass}>
                <option value="">{t("chooseTunnelConnector")}</option>
                {props.eligibleConnectors.map((connector) => <option key={connector.id} value={connector.id}>{connector.name}</option>)}
              </select>
            </Field> : <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <Field label={t("publicIpv4")} hint={t("publicIpListPerFamilyHint")}><textarea dir="ltr" rows={4} value={props.publicIpv4} onChange={(event) => props.setPublicIpv4(event.target.value)} className={`${inputClass} h-auto py-3 font-mono`} placeholder="198.41.0.4" /></Field>
              <Field label={t("publicIpv6")} hint={t("publicIpListPerFamilyHint")}><textarea dir="ltr" rows={4} value={props.publicIpv6} onChange={(event) => props.setPublicIpv6(event.target.value)} className={`${inputClass} h-auto py-3 font-mono`} placeholder="2606:4700:4700::1111" /></Field>
            </div>}
            <Notice>{t(props.accessMethod === "tunnel" ? "tunnelCertificateNotice" : "publicCertificateNotice")}</Notice>
          </div>}
          {props.wizardStep === 4 && <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_1fr]">
            <div className="rounded-2xl bg-ink-900 p-5 text-white">
              <p className="text-xs font-extrabold text-orange-300">{t("trafficPath")}</p>
               <bdi dir="ltr" className="block break-all pt-4 font-mono text-sm">{props.publishHostname || t("unknown")}</bdi>
              <p className="pt-4 text-sm font-bold">{t(props.accessMethod === "tunnel" ? "domainAccessTunnelReview" : "domainAccessPublicReview")}</p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Meta label={t("cloudflareAccount")} value={props.accounts.find((account) => account.id === props.selectedAccountId)?.name || t("unknown")} />
              <Meta label={t("cloudflareZone")} value={props.zones.find((zone) => zone.id === props.zoneId)?.name || t("unknown")} technical />
               <Meta label={t("assignedAgent")} value={props.agents.find((agent) => agent.id === props.publishAgentId)?.name || t("unknown")} />
               <Meta label={t("accessMethod")} value={t(props.accessMethod === "tunnel" ? "tunnel" : "publicIp")} />
               <Meta label={t("domainAccessTarget")} value={props.publishTarget} technical />
              {props.accessMethod === "tunnel" ? <Meta label={t("cloudflareConnector")} value={props.connectors.find((connector) => connector.id === props.connectorId)?.name || t("unknown")} /> : <Meta label={t("publicIp")} value={[...parseIpList(props.publicIpv4), ...parseIpList(props.publicIpv6)].join(", ")} technical />}
               <Meta label={t("proxyMode")} value={t(props.accessMethod === "tunnel" ? "proxied" : "dnsOnly")} />
            </div>
            <div className="lg:col-span-2"><Notice>{t("domainAccessOwnershipWarning")}</Notice></div>
          </div>}
          </div>
          <div className="flex flex-col-reverse gap-3 border-t border-stone-200/80 p-5 dark:border-white/[0.06] sm:flex-row sm:justify-between sm:p-6">
            <button type="button" disabled={props.wizardStep === 1 || props.busy === "create-hostname"} onClick={() => props.setWizardStep(Math.max(1, props.wizardStep - 1))} className={secondaryButton}>{t("back")}</button>
            {props.wizardStep < 4 ? <button type="button" onClick={props.next} className={primaryButton}>{t("continue")}</button> : <button disabled={props.busy === "create-hostname"} className={primaryButton}><Plus size={17} />{t("createDomainAccess")}</button>}
          </div>
          </form>
        </Modal>
      )}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {props.domainAccess.map((item) => {
          const zone = props.zones.find(
            (candidate) => candidate.id === item.cloudflareZoneId,
          );
          const connector = props.connectors.find(
            (candidate) => candidate.id === item.connectorId,
          );
          const route = props.routes.find(
            (candidate) => candidate.id === item.routeId,
          );
          return (
            <article
              key={item.id}
               aria-busy={props.busy === `access:${item.id}`}
              className={`${panelClass} min-w-0 p-5 sm:p-6`}
            >
              <div className="flex items-start justify-between gap-4">
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-orange-500/10 text-orange-600 dark:text-orange-300">
                  <Link2 size={21} />
                </span>
                <DeploymentStatus status={item.status} t={t} />
              </div>
              <h2 className="break-words pt-5 text-lg font-black text-ink-900 dark:text-white">
                <bdi dir="ltr">{item.hostname}</bdi>
              </h2>
              <div className="grid grid-cols-1 gap-3 pt-5 sm:grid-cols-2">
                <Meta
                  label={t("cloudflareZone")}
                  value={zone?.name || t("unknown")}
                  technical
                />
                <Meta
                  label={t("accessMethod")}
                  value={t(item.accessMethod === "tunnel" ? "tunnel" : "publicIp")}
                />
                <Meta
                  label={t("domainRoute")}
                  value={route?.name || route?.hostname || t("unknown")}
                />
                <Meta
                  label={t("proxyMode")}
                  value={t(item.proxied ? "proxied" : "dnsOnly")}
                />
                <Meta label={t("domainAccessTarget")} value={route?.backends.join(", ") || t("unknown")} technical />
                <Meta label={t("cloudflareConnector")} value={connector?.name || (item.accessMethod === "public_ip" ? t("none") : t("unknown"))} />
              </div>
              <div className="mt-4 rounded-xl bg-ink-900 p-3 text-xs font-bold leading-6 text-stone-200"><span className="block text-[0.65rem] uppercase tracking-wider text-orange-300">{t("trafficPath")}</span>{t(item.accessMethod === "tunnel" ? "domainAccessTunnelReview" : "domainAccessPublicReview")}</div>
              <div className="flex flex-wrap gap-2 pt-4" dir="ltr">
                {item.ownedDnsRecords.map((record) => <span key={record.cloudflareRecordId} className={`max-w-full truncate rounded-lg bg-stone-100 px-2.5 py-1 font-mono text-[0.65rem] text-stone-600 dark:bg-white/5 dark:text-stone-300 ${record.status === "deleted" ? "line-through opacity-50" : ""}`}>{record.type} {record.content}</span>)}
              </div>
              <div className="grid grid-cols-1 gap-3 pt-4 sm:grid-cols-2">
                <Meta label={t("certificateMode")} value={item.accessMethod === "tunnel" ? "Cloudflare browser edge" : "Traefik Let’s Encrypt TLS-ALPN"} />
                <Meta label={t("certificateStatus")} value={item.accessMethod === "tunnel" ? t("cloudflareEdgeManaged") : t(({ not_observed: "tlsNotObserved", valid: "tlsValid", expiring: "tlsExpiring", expired: "tlsExpired", error: "tlsError" } as const)[item.tlsStatus])} danger={item.tlsStatus === "expired" || item.tlsStatus === "error"} />
                {item.tlsIssuer && <Meta label={t("certificateIssuer")} value={item.tlsIssuer} />}
                {item.tlsValidTo && <Meta label={t("certificateExpiry")} value={item.tlsValidTo} technical />}
                {item.tlsError && <Meta label={t("lastError")} value={item.tlsError} danger />}
                <Meta label={t("nextAction")} value={item.status === "pending" || item.status === "failed" ? t("reconcile") : item.enabled ? t("none") : t("enableDomainAccess")} />
              </div>
              {item.lastError && (
                <p className="flex items-start gap-2 pt-4 text-xs font-bold leading-5 text-rose-600 dark:text-rose-300">
                  <TriangleAlert className="mt-0.5 shrink-0" size={14} />
                   {t("domainAccessDeploymentFailed")}
                </p>
              )}
              <div className="flex items-center justify-between gap-3 pt-5">
                <Status
                  active={item.enabled}
                  label={t(item.enabled ? "enabled" : "disabled")}
                />
                 {props.role !== "viewer" && <div className="flex flex-wrap items-center justify-end gap-2">
                     <button type="button" onClick={() => props.action(item, "reconcile")} disabled={props.busy === `access:${item.id}`} className={secondaryButton}><RefreshCw size={14} />{t("reconcile")}</button>
                     <Toggle
                       enabled={item.enabled}
                       setEnabled={() => props.action(item, "toggle")}
                       disabled={props.busy === `access:${item.id}`}
                       label={t(item.enabled ? "disableDomainAccess" : "enableDomainAccess")}
                     />
                   </div>}
              </div>
            </article>
          );
        })}
        {props.domainAccess.length === 0 && (
          <Empty icon={Link2} text={t("noDomainAccess")} />
        )}
      </section>
    </div>
  );
}

function HeroStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="min-w-[5rem] rounded-xl px-2 py-2">
      <strong className="block text-xl font-black text-orange-300">
        {value}
      </strong>
      <span className="block pt-1 text-[0.58rem] font-bold text-stone-400">
        {label}
      </span>
    </div>
  );
}
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-2">
      <span className="text-xs font-extrabold text-ink-800 dark:text-stone-100">
        {label}
      </span>
      {children}
      {hint && (
        <span className="text-[0.66rem] font-medium leading-5 text-stone-400">
          {hint}
        </span>
      )}
    </label>
  );
}
function RelationshipField({
  number,
  label,
  children,
}: {
  number: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-3 rounded-2xl border border-stone-200/80 bg-white/50 p-4 dark:border-white/[0.06] dark:bg-white/[0.02]">
      <span className="flex items-center gap-2 text-xs font-extrabold text-ink-800 dark:text-stone-100">
        <span dir="ltr" className="text-[0.62rem] text-orange-500">
          {number}
        </span>
        {label}
      </span>
      {children}
    </label>
  );
}
function Toggle({
  enabled,
  setEnabled,
  label,
  disabled = false,
}: {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      disabled={disabled}
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      onClick={() => setEnabled(!enabled)}
      className={`relative h-8 w-14 shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ${enabled ? "bg-mint-400" : "bg-stone-300 dark:bg-stone-700"}`}
    >
      <span
        className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-all ${enabled ? "end-1" : "start-1"}`}
      />
    </button>
  );
}
function Status({
  active,
  label,
  technical = false,
}: {
  active: boolean;
  label: string;
  technical?: boolean;
}) {
  return (
    <span
      className={`inline-flex w-fit max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.65rem] font-extrabold ${active ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-amber-500/10 text-amber-700 dark:text-amber-300"}`}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? "bg-emerald-500" : "bg-amber-500"}`}
      />
      {technical ? (
        <bdi dir="ltr" className="truncate">
          {label}
        </bdi>
      ) : (
        label
      )}
    </span>
  );
}
function DeploymentStatus({
  status,
  t,
}: {
  status: CloudflareDomainAccess["status"];
  t: Translate;
}) {
  const styles =
    status === "active"
      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : status === "failed"
        ? "bg-rose-500/10 text-rose-700 dark:text-rose-300"
        : "bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.65rem] font-extrabold ${styles}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {t(status)}
    </span>
  );
}
function TechnicalValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="pt-4">
      <p className="text-[0.62rem] font-bold text-stone-400">{label}</p>
      <bdi
        dir="ltr"
        className="block break-all pt-1 text-left font-mono text-xs text-stone-600 dark:text-stone-300"
      >
        {value}
      </bdi>
    </div>
  );
}
function Meta({
  label,
  value,
  danger = false,
  technical = false,
}: {
  label: string;
  value: string;
  danger?: boolean;
  technical?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-xl bg-stone-100/70 p-3 dark:bg-white/[0.035]">
      <p className="text-[0.6rem] font-bold text-stone-400">{label}</p>
      <p
        className={`break-words pt-1 text-xs font-extrabold ${danger ? "text-rose-600 dark:text-rose-300" : "text-ink-800 dark:text-stone-200"}`}
      >
        {technical ? <bdi dir="ltr">{value}</bdi> : value}
      </p>
    </div>
  );
}
function Alert({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-xl bg-rose-500/10 px-3.5 py-3 text-xs font-bold leading-5 text-rose-700 dark:text-rose-300"
    >
      <TriangleAlert className="mt-0.5 shrink-0" size={15} />
      {children}
    </div>
  );
}
function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3.5 py-3 text-xs font-bold leading-5 text-amber-700 dark:text-amber-300">
      <TriangleAlert className="mt-0.5 shrink-0" size={15} />
      {children}
    </div>
  );
}
function Success({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-xl bg-emerald-500/10 px-3.5 py-3 text-xs font-bold text-emerald-700 dark:text-emerald-300"
    >
      <CheckCircle2 size={15} />
      {children}
    </div>
  );
}
function Loading({ t }: { t: Translate }) {
  return (
    <div
      role="status"
      className={`${panelClass} flex items-center justify-center gap-3 p-8 text-sm font-bold text-stone-400`}
    >
      <RefreshCw className="animate-spin" size={18} />
      {t("loadingData")}
    </div>
  );
}
function Empty({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div
      className={`${panelClass} flex min-h-44 flex-col items-center justify-center p-8 text-center lg:col-span-2 2xl:col-span-3`}
    >
      <Icon className="text-stone-300 dark:text-stone-600" size={31} />
      <p className="max-w-md pt-3 text-sm font-bold leading-6 text-stone-400">
        {text}
      </p>
    </div>
  );
}
function formatDate(value: string, locale: Locale) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat(locale === "ar" ? "ar" : "en", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}
function hostnameWithinZone(hostname: string, zone: string) {
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/, "");
  const normalizedZone = zone.toLowerCase().replace(/\.$/, "");
  return (
    normalizedHostname === normalizedZone ||
    normalizedHostname.endsWith(`.${normalizedZone}`)
  );
}
function parseIpList(value: string) {
  return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}
function zoneResultMessage(t: Translate, locale: Locale, successKey: MessageKey, emptyKey: MessageKey, zoneCount: number | undefined, unavailableKey?: MessageKey) {
  if (zoneCount === undefined && unavailableKey) return t(unavailableKey);
  const count = typeof zoneCount === "number" && Number.isFinite(zoneCount) && zoneCount > 0 ? Math.floor(zoneCount) : 0;
  return t(count > 0 ? successKey : emptyKey).replace("{count}", new Intl.NumberFormat(locale).format(count));
}
function friendlyError(error: unknown, t: Translate) {
  if (error instanceof ApiError) {
    const codeMessages: Partial<Record<string, MessageKey>> = {
      cloudflare_account_unavailable: "cloudflareAccountUnavailable",
      cloudflare_zone_invalid: "cloudflareZoneInvalid",
      domain_access_route_invalid: "domainAccessRouteInvalid",
      tunnel_topology_mismatch: "tunnelTopologyMismatch",
      domain_access_duplicate: "domainAccessDuplicate",
      domain_access_invalid: "cloudflareRelationshipConflict",
      dns_record_conflict: "dnsRecordConflict",
      cloudflare_reconciliation_failed: "cloudflareReconciliationFailed",
      domain_access_dependency_enabled: "linkedDomainAccessEnabled",
      cloudflare_token_invalid: "cloudflareTokenInvalid",
      cloudflare_token_inactive: "cloudflareTokenInactive",
      cloudflare_token_verification_failed: "cloudflareTokenVerificationFailed",
      cloudflare_account_mismatch: "cloudflareAccountMismatch",
      cloudflare_zone_access_denied: "cloudflareZoneAccessDenied",
      cloudflare_zone_access_forbidden: "cloudflareZoneAccessDenied",
      cloudflare_zone_list_failed: "cloudflareZoneListFailed",
      cloudflare_rate_limited: "cloudflareRateLimited",
      cloudflare_service_unavailable: "cloudflareServiceUnavailable",
    };
    const mappedCode = error.code ? codeMessages[error.code] : undefined;
    if (mappedCode) return t(mappedCode);
    if (error.status === 403) return t("forbidden");
    if (error.status === 409) return t("cloudflareRelationshipConflict");
    if (error.status === 400) return t("validationError");
  }
  return t("requestFailed");
}
