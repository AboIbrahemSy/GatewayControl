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
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  api,
  ApiError,
  type CloudflareAccount,
  type CloudflarePublicHostname,
  type CloudflareZone,
  type Connector,
  type ManagedRoute,
  type Role,
} from "./api";
import type { Locale, MessageKey, Translate } from "./App";
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
  const [publicHostnames, setPublicHostnames] = useState<
    CloudflarePublicHostname[]
  >([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [createModal, setCreateModal] = useState<"account" | "hostname" | null>(
    null,
  );
  const [accountName, setAccountName] = useState("");
  const [accountIdentifier, setAccountIdentifier] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [accountEnabled, setAccountEnabled] = useState(true);
  const [zoneId, setZoneId] = useState("");
  const [connectorId, setConnectorId] = useState("");
  const [routeId, setRouteId] = useState("");
  const [proxied, setProxied] = useState(true);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [accountResult, connectorResult, routeResult, hostnameResult] =
        await Promise.all([
          api.cloudflareAccounts(),
          api.connectors(),
          api.routes(),
          api.cloudflarePublicHostnames(),
        ]);
      setAccounts(accountResult.accounts);
      setConnectors(connectorResult.connectors);
      setRoutes(routeResult.routes);
      setPublicHostnames(hostnameResult.publicHostnames);
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
    setSelectedAccountId(id);
    setError("");
    setSuccess("");
    if (openZones) setTab("zones");
    setBusy(`zones:${id}`);
    try {
      const result = await api.cloudflareZones(id);
      setZonesByAccount((current) => ({ ...current, [id]: result.zones }));
      setZoneId(result.zones[0]?.id || "");
    } catch (caught) {
      setError(friendlyError(caught, t));
    } finally {
      setBusy("");
    }
  }

  async function createAccount(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setSuccess("");
    if (!/^[a-fA-F0-9]{32}$/.test(accountIdentifier) || apiToken.length < 20) {
      setError(t("validationError"));
      return;
    }
    setBusy("create-account");
    try {
      const result = await api.createCloudflareAccount({
        name: accountName.trim(),
        accountIdentifier,
        apiToken,
        enabled: accountEnabled,
      });
      setAccounts((current) => [result.account, ...current]);
      setZonesByAccount((current) => ({ ...current, [result.account.id]: [] }));
      setSelectedAccountId(result.account.id);
      setAccountName("");
      setAccountIdentifier("");
      setApiToken("");
      setAccountEnabled(true);
      setCreateModal(null);
      setSuccess(t("cloudflareAccountCreated"));
    } catch (caught) {
      setError(friendlyError(caught, t));
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

  async function accountAction(
    account: CloudflareAccount,
    action: "test" | "sync",
  ) {
    setBusy(`${action}:${account.id}`);
    setError("");
    setSuccess("");
    try {
      if (action === "test") {
        await api.testCloudflareAccount(account.id);
        setSuccess(t("cloudflareTestSucceeded"));
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
        setSuccess(t("cloudflareSyncSucceeded"));
      }
    } catch (caught) {
      setError(friendlyError(caught, t));
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
      connector.tunnelId &&
      connector.cloudflareAccountId === selectedZone?.cloudflareAccountId,
  );
  const eligibleRoutes = routes.filter(
    (route) =>
      route.enabled &&
      route.exposure === "tunnel" &&
      selectedZone &&
      hostnameWithinZone(route.hostname, selectedZone.name),
  );

  async function createPublicHostname(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setSuccess("");
    if (!zoneId || !connectorId || !routeId) {
      setError(t("validationError"));
      return;
    }
    setBusy("create-hostname");
    try {
      const result = await api.createCloudflarePublicHostname({
        zoneId,
        connectorId,
        routeId,
        proxied,
      });
      setPublicHostnames((current) => [result.publicHostname, ...current]);
      setConnectorId("");
      setRouteId("");
      setProxied(true);
      setCreateModal(null);
      setSuccess(t("publicHostnameCreated"));
    } catch (caught) {
      setError(friendlyError(caught, t));
    } finally {
      setBusy("");
    }
  }

  async function togglePublicHostname(item: CloudflarePublicHostname) {
    setBusy(`hostname:${item.id}`);
    setError("");
    setSuccess("");
    try {
      const result = await api.updateCloudflarePublicHostname(
        item.id,
        item.status === "failed" ? true : !item.enabled,
      );
      setPublicHostnames((current) =>
        current.map((hostname) =>
          hostname.id === item.id ? result.publicHostname : hostname,
        ),
      );
      setSuccess(
        t(
          item.status === "failed"
            ? "publicHostnameRetryQueued"
            : "publicHostnameUpdated",
        ),
      );
    } catch (caught) {
      setError(friendlyError(caught, t));
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
              {t("cloudflareManagementTitle")}
            </h1>
            <p className="max-w-2xl pt-3 text-sm font-medium leading-7 text-stone-400 sm:text-base">
              {t("cloudflareManagementDescription")}
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 rounded-2xl border border-white/10 bg-white/[0.04] p-2 text-center">
            <HeroStat value={accounts.length} label={t("cloudflareAccounts")} />
            <HeroStat
              value={Object.values(zonesByAccount).flat().length}
              label={t("cloudflareZones")}
            />
            <HeroStat
              value={publicHostnames.length}
              label={t("publicHostnames")}
            />
          </div>
        </div>
      </section>
      <div className="max-w-full overflow-hidden rounded-2xl border border-stone-200/80 bg-white/70 p-1.5 dark:border-white/[0.07] dark:bg-white/[0.025]">
        <div
          role="tablist"
          aria-label={t("cloudflareManagementTitle")}
          className="flex max-w-full gap-1 overflow-x-auto overscroll-x-contain"
        >
          {(
            [
              ["accounts", "cloudflareAccounts", KeyRound],
              ["zones", "cloudflareZones", Globe2],
              ["hostnames", "publicHostnames", Link2],
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
          createOpen={createModal === "account"}
          openCreate={() => setCreateModal("account")}
          closeCreate={() => {
            setAccountName("");
            setAccountIdentifier("");
            setApiToken("");
            setAccountEnabled(true);
            setError("");
            setCreateModal(null);
          }}
          form={{
            accountName,
            accountIdentifier,
            apiToken,
            accountEnabled,
            setAccountName,
            setAccountIdentifier,
            setApiToken,
            setAccountEnabled,
            submit: createAccount,
          }}
          selectAccount={(id) => void selectAccount(id, true)}
          toggleAccount={(account) => void toggleAccount(account)}
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
          t={t}
          role={role}
          zones={Object.values(zonesByAccount).flat()}
          connectors={connectors}
          routes={routes}
          publicHostnames={publicHostnames}
          selectedAccountId={selectedAccountId}
          zoneId={zoneId}
          connectorId={connectorId}
          routeId={routeId}
          proxied={proxied}
          eligibleConnectors={eligibleConnectors}
          eligibleRoutes={eligibleRoutes}
          busy={busy}
          createOpen={createModal === "hostname"}
          openCreate={() => setCreateModal("hostname")}
          closeCreate={() => {
            setConnectorId("");
            setRouteId("");
            setProxied(true);
            setError("");
            setCreateModal(null);
          }}
          setSelectedAccountId={(id) => {
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
          setProxied={setProxied}
          submit={createPublicHostname}
          toggle={(item) => void togglePublicHostname(item)}
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
  setAccountName: (value: string) => void;
  setAccountIdentifier: (value: string) => void;
  setApiToken: (value: string) => void;
  setAccountEnabled: (value: boolean) => void;
  submit: (event: React.FormEvent) => void;
};

function AccountsArea({
  t,
  locale,
  role,
  accounts,
  selectedAccountId,
  busy,
  createOpen,
  openCreate,
  closeCreate,
  form,
  selectAccount,
  toggleAccount,
  action,
}: {
  t: Translate;
  locale: Locale;
  role: Role;
  accounts: CloudflareAccount[];
  selectedAccountId: string;
  busy: string;
  createOpen: boolean;
  openCreate: () => void;
  closeCreate: () => void;
  form: AccountForm;
  selectAccount: (id: string) => void;
  toggleAccount: (account: CloudflareAccount) => void;
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
          maxWidthClass="max-w-5xl"
          onClose={closeCreate}
        >
          <form onSubmit={form.submit}>
          <div className="grid grid-cols-1 gap-5 p-5 sm:p-6 lg:grid-cols-2 2xl:grid-cols-12 items-start">
            <div className="2xl:col-span-3">
              <Field label={t("accountName")}>
                <input
                  required
                  maxLength={120}
                  value={form.accountName}
                  onChange={(event) => form.setAccountName(event.target.value)}
                  className={inputClass}
                />
              </Field>
            </div>
            <div className="2xl:col-span-3">
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
            </div>
            <div className="2xl:col-span-3">
              <Field
                label={t("cloudflareApiToken")}
                hint={t("apiTokenNeverShown")}
              >
                <input
                  required
                  type="password"
                  minLength={20}
                  autoComplete="new-password"
                  value={form.apiToken}
                  onChange={(event) => form.setApiToken(event.target.value)}
                  className={inputClass}
                />
              </Field>
            </div>
            <div className="flex flex-col gap-2 2xl:col-span-1">
              <span
                className="hidden text-xs font-extrabold text-transparent select-none 2xl:block"
                aria-hidden="true"
              >
                &nbsp;
              </span>
              <div className="flex h-12 items-center gap-3">
                <Toggle
                  enabled={form.accountEnabled}
                  setEnabled={form.setAccountEnabled}
                  label={t("enabled")}
                />
                <span className="text-xs font-extrabold">{t("enabled")}</span>
              </div>
            </div>
            <div className="flex flex-col gap-2 2xl:col-span-2">
              <span
                className="hidden text-xs font-extrabold text-transparent select-none 2xl:block"
                aria-hidden="true"
              >
                &nbsp;
              </span>
              <button
                disabled={busy === "create-account"}
                className={primaryButton}
              >
                <Plus size={17} />
                {t("addAccount")}
              </button>
            </div>
          </div>
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
              className={`grid grid-cols-1 gap-2 pt-5 ${role === "viewer" ? "" : "sm:grid-cols-3"}`}
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
                    {t("testAccount")}
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
  t: Translate;
  role: Role;
  accounts: CloudflareAccount[];
  zones: CloudflareZone[];
  connectors: Connector[];
  routes: ManagedRoute[];
  publicHostnames: CloudflarePublicHostname[];
  selectedAccountId: string;
  zoneId: string;
  connectorId: string;
  routeId: string;
  proxied: boolean;
  eligibleConnectors: Connector[];
  eligibleRoutes: ManagedRoute[];
  busy: string;
  createOpen: boolean;
  openCreate: () => void;
  closeCreate: () => void;
  setSelectedAccountId: (value: string) => void;
  setZoneId: (value: string) => void;
  setConnectorId: (value: string) => void;
  setRouteId: (value: string) => void;
  setProxied: (value: boolean) => void;
  submit: (event: React.FormEvent) => void;
  toggle: (item: CloudflarePublicHostname) => void;
};

function HostnamesArea(props: HostnamesAreaProps) {
  const { t } = props;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {props.role !== "viewer" && (
        <div className="flex justify-end">
          <button type="button" className={primaryButton} onClick={props.openCreate}>
            <Plus size={17} />
            {t("publishHostname")}
          </button>
        </div>
      )}
      {props.role !== "viewer" && (
        <Modal
          open={props.createOpen}
          title={t("publishHostname")}
          description={t("publicHostnameRelationshipHint")}
          closeLabel={t("cancel")}
          busy={props.busy === "create-hostname"}
          maxWidthClass="max-w-6xl"
          onClose={props.closeCreate}
        >
          <form onSubmit={props.submit}>
          <div className="grid grid-cols-1 gap-5 p-5 sm:p-6 lg:grid-cols-2 2xl:grid-cols-4">
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
                      zone.cloudflareAccountId === props.selectedAccountId,
                  )
                  .map((zone) => (
                    <option key={zone.id} value={zone.id}>
                      {zone.name}
                    </option>
                  ))}
              </select>
            </RelationshipField>
            <RelationshipField number="03" label={t("cloudflareConnector")}>
              <select
                required
                disabled={!props.zoneId}
                value={props.connectorId}
                onChange={(event) => props.setConnectorId(event.target.value)}
                className={inputClass}
              >
                <option value="">{t("chooseTunnelConnector")}</option>
                {props.eligibleConnectors.map((connector) => (
                  <option key={connector.id} value={connector.id}>
                    {connector.name}
                  </option>
                ))}
              </select>
            </RelationshipField>
            <RelationshipField number="04" label={t("tunnelRoute")}>
              <select
                required
                disabled={!props.zoneId}
                value={props.routeId}
                onChange={(event) => props.setRouteId(event.target.value)}
                className={inputClass}
              >
                <option value="">{t("chooseEligibleRoute")}</option>
                {props.eligibleRoutes.map((route) => (
                  <option key={route.id} value={route.id}>
                    {route.hostname}
                  </option>
                ))}
              </select>
            </RelationshipField>
          </div>
          <div className="flex flex-col gap-4 border-t border-stone-200/80 p-5 dark:border-white/[0.06] sm:flex-row sm:items-center sm:justify-between sm:p-6">
            <div className="flex items-center gap-3">
              <Toggle
                enabled={props.proxied}
                setEnabled={props.setProxied}
                label={t("proxied")}
              />
              <div>
                <p className="text-xs font-extrabold text-ink-900 dark:text-white">
                  {t("proxied")}
                </p>
                <p className="pt-1 text-[0.66rem] font-medium text-stone-400">
                  {t("proxiedHint")}
                </p>
              </div>
            </div>
            <button
              disabled={
                props.busy === "create-hostname" ||
                !props.zoneId ||
                !props.connectorId ||
                !props.routeId
              }
              className={primaryButton}
            >
              <Plus size={17} />
              {t("publishHostname")}
            </button>
          </div>
          </form>
        </Modal>
      )}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {props.publicHostnames.map((item) => {
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
              aria-busy={props.busy === `hostname:${item.id}`}
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
                  label={t("cloudflareConnector")}
                  value={connector?.name || t("unknown")}
                />
                <Meta
                  label={t("tunnelRoute")}
                  value={route?.name || route?.hostname || t("unknown")}
                />
                <Meta
                  label={t("proxyMode")}
                  value={t(item.proxied ? "proxied" : "dnsOnly")}
                />
              </div>
              {item.lastError && (
                <p className="flex items-start gap-2 pt-4 text-xs font-bold leading-5 text-rose-600 dark:text-rose-300">
                  <TriangleAlert className="mt-0.5 shrink-0" size={14} />
                  {t("publicHostnameDeploymentFailed")}
                </p>
              )}
              <div className="flex items-center justify-between gap-3 pt-5">
                <Status
                  active={item.enabled}
                  label={t(item.enabled ? "enabled" : "disabled")}
                />
                {props.role !== "viewer" && (
                  <div className="flex items-center gap-2">
                    <span className="text-[0.66rem] font-bold text-stone-400">
                      {item.status === "failed"
                        ? t("retryDeployment")
                        : t(
                            item.enabled ? "disableHostname" : "enableHostname",
                          )}
                    </span>
                    <Toggle
                      enabled={item.enabled}
                      setEnabled={() => props.toggle(item)}
                      disabled={props.busy === `hostname:${item.id}`}
                      label={t(
                        item.enabled ? "disableHostname" : "enableHostname",
                      )}
                    />
                  </div>
                )}
              </div>
            </article>
          );
        })}
        {props.publicHostnames.length === 0 && (
          <Empty icon={Link2} text={t("noPublicHostnames")} />
        )}
      </section>
    </div>
  );
}

function HeroStat({ value, label }: { value: number; label: string }) {
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
  status: CloudflarePublicHostname["status"];
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
function friendlyError(error: unknown, t: Translate) {
  if (error instanceof ApiError) {
    if (error.status === 403) return t("forbidden");
    if (error.status === 409) return t("cloudflareRelationshipConflict");
    if (error.status === 400) return t("validationError");
  }
  return t("requestFailed");
}
