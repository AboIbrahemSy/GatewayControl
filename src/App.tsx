import {
  Activity,
  BellRing,
  Bot,
  Cable,
  Check,
  CheckCircle2,
  ChevronRight,
  Clipboard,
  Cloud,
  CloudCog,
  Container,
  DatabaseBackup,
  FileText,
  Globe2,
  Languages,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Menu,
  Moon,
  Network,
  Plus,
  RefreshCw,
  Save,
  Send,
  Server,
  ShieldCheck,
  Sun,
  Trash2,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, ApiError, type Agent, type Connector, type Role, type User } from './api'
import { RoutesPage, ServicesPage, StacksPage } from './OperationsPages'
import { LogsPage, MonitoringPage } from './ObservabilityPages'
import { BackupsPage } from './BackupsPage'
import { CloudflareManagementPage } from './CloudflareManagementPage'
import { copyText } from './clipboard'

export type Locale = 'en' | 'ar'
type Theme = 'light' | 'dark'
export type Page = 'dashboard' | 'agents' | 'connectors' | 'cloudflareManagement' | 'notifications' | 'services' | 'routes' | 'stacks' | 'monitoring' | 'logs' | 'backups'
type Gate = 'loading' | 'setup' | 'login' | 'app' | 'error'

const messages = {
  en: {
    appName: 'GatewayControl', controlPlane: 'Control plane', loading: 'Opening your control plane',
    startupError: 'The control plane could not be reached.', retry: 'Try again', changeLanguage: 'Change language',
    changeTheme: 'Change theme', setupEyebrow: 'First-run setup', setupTitle: 'Build your private control room.',
    setupDescription: 'Create the owner account that will manage this GatewayControl instance.', ownerIdentity: 'Owner identity',
    secureAccount: 'Secure account', step: 'Step', of: 'of', email: 'Email address', emailHint: 'Use the address for the primary owner.',
    password: 'Password', passwordHint: 'Use at least 12 characters.', passwordConfirmation: 'Confirm password',
    continue: 'Continue', back: 'Back', createControlPlane: 'Create control plane', setupSecurity: 'Credentials are sent only to this same-origin control plane.',
    passwordsMismatch: 'The passwords do not match.', passwordTooShort: 'The password must contain at least 12 characters.',
    loginTitle: 'Welcome back.', loginDescription: 'Sign in to manage your gateways and agents.', signIn: 'Sign in',
    invalidCredentials: 'The email or password is incorrect.', requestFailed: 'The request could not be completed. Please try again.',
    forbidden: 'Your account does not have permission for this action.', conflict: 'That value already exists or the operation was already completed.',
    dashboard: 'Dashboard', infrastructure: 'Infrastructure', agents: 'Agents', networking: 'Networking', connectors: 'Cloudflare connectors',
    services: 'Services', routes: 'Routes & domains', stacks: 'Compose stacks', system: 'System', notifications: 'Telegram notifications',
    closeNavigation: 'Close navigation', openNavigation: 'Open navigation', signedInAs: 'Signed in as', logout: 'Sign out',
    owner: 'Owner', operator: 'Operator', viewer: 'Viewer', healthy: 'Control plane online', overviewEyebrow: 'Operational overview',
    overviewTitle: 'Your infrastructure, one calm control room.', overviewDescription: 'Enroll agents, connect Cloudflare tunnels, and route operational alerts from one secure workspace.',
    manageAgents: 'Manage agents', addConnector: 'Add connector', secureSession: 'Secure cookie session', noSecretsStored: 'Secrets stay server-side',
    agentsTitle: 'Agent fleet', agentsDescription: 'Enroll the machines that execute control-plane work and report heartbeats.', addAgent: 'Enroll agent',
    agentName: 'Agent name', agentNamePlaceholder: 'production-edge-01', controlBaseUrl: 'Control base URL',
    controlBaseUrlHint: 'The URL this agent can use to reach GatewayControl.', containerImage: 'Agent image', createAgent: 'Create enrollment',
    enrollmentCommand: 'One-time enrollment command', enrollmentWarning: 'This command contains a short-lived secret. It is shown once and is not stored by this browser.',
    copyCommand: 'Copy command', copied: 'Copied', expires: 'Expires', agent: 'Agent', enrollment: 'Enrollment', heartbeat: 'Heartbeat',
    enrolled: 'Enrolled', awaitingEnrollment: 'Awaiting enrollment', never: 'Not received', noAgents: 'No agents enrolled yet.', removeAgent: 'Remove', confirmAgentRemovalTitle: 'Confirm agent removal', agentRemovalDescription: 'Remove this agent from the active fleet:', agentRemovalWarning: 'Pending unused agents are permanently deleted. Enrolled agents are archived and their credentials are revoked. Existing stacks, routes, connectors, backups, restores, or active commands block removal.', confirmRemoveAgent: 'Remove agent', agentRemovalBlocked: 'Reassign the agent resources and wait for active commands to finish before removing it.', agentDeleted: 'The pending agent was permanently deleted.', agentArchived: 'The enrolled agent was archived and its credentials were revoked.', cleanupAgentTitle: 'Clean up the Agent host', cleanupAgentDescription: 'Run this command on the former Agent host to remove only its container and private state volume. Managed stacks, backups, and shared Traefik data are not removed.', copyCleanupCommand: 'Copy cleanup command',
    connectorsTitle: 'Cloudflare connectors', connectorsDescription: 'Store connector credentials securely and control which tunnels may operate.',
    connectorName: 'Connector name', connectorNamePlaceholder: 'primary-tunnel', connectorToken: 'Connector token',
    connectorTokenHint: 'The token is encrypted by the control plane and is never returned or displayed.', enabled: 'Enabled', disabled: 'Disabled',
    createConnector: 'Add connector', noConnectors: 'No connectors configured yet.', tokenNeverShown: 'Token protected',
    assignedAgent: 'Gateway agent', chooseAgent: 'Choose the agent that will run this connector', noConnectorAgents: 'Create an agent before adding a Cloudflare connector.',
    insecureHttpWarning: 'HTTP enrollment is intended only for the first local installation on a trusted network. Use an HTTPS control URL for remote nodes.',
    notificationsTitle: 'Telegram notifications', notificationsDescription: 'Choose the operational events delivered through your Telegram bot.',
    configured: 'Configured', notConfigured: 'Not configured', botToken: 'Bot token', botTokenPlaceholder: '123456789:AA...',
    groupId: 'Group or chat ID', groupIdPlaceholder: '-1001234567890', saveSettings: 'Save settings', testConnection: 'Send test',
    testSent: 'Test notification sent.', settingsSaved: 'Telegram settings saved.', selectEvents: 'Notification events',
    agentOffline: 'Agent goes offline', serviceUnhealthy: 'Service becomes unhealthy', deploymentFailed: 'Deployment fails',
    certificateExpiring: 'Certificate is expiring', backupFailed: 'Backup or restore fails', backupSucceeded: 'Backup completes successfully',
    existingSecretNotice: 'Existing credentials remain hidden. You can test them without entering the token again.',
    replacementRequired: 'The current server requires a new bot token and group ID to save any settings change. Existing credentials cannot yet be preserved by the update endpoint.',
    enterReplacement: 'Enter both replacement credentials to save changes.', readOnly: 'Your Viewer role has read-only access.',
    refresh: 'Refresh', loadingData: 'Loading data', lastHeartbeat: 'Last heartbeat', unknown: 'Unknown', previewTitle: 'Coming next',
    previewDescription: 'This area is ready for its control-plane workflow.', goDashboard: 'Back to dashboard', validationError: 'Check the highlighted fields and try again.',
    onlineAgents: 'Online agents', activeConnectors: 'Active connectors', fleetReadiness: 'Fleet readiness', liveTopology: 'Live topology',
    topologyDescription: 'The current path from the controller to managed infrastructure.', controller: 'Controller', databaseReady: 'PostgreSQL ready',
    encryptedSecrets: 'Encrypted secret store', connectedAgents: 'agents connected', connectorsRunning: 'connectors enabled', noOperationalData: 'Enroll your first agent to begin collecting live operational data.',
    stacksTitle: 'Managed Compose stacks', stacksDescription: 'Deploy and operate versioned Compose projects on enrolled agents.', newStack: 'New stack', editStack: 'Edit stack', basicDetails: 'Basic details', composeConfiguration: 'Compose configuration',
    name: 'Name', projectName: 'Project name', projectNameHint: 'Lowercase letters, numbers, underscores, and hyphens.', composeYaml: 'Compose YAML', composeHint: 'Paste the complete managed Compose document. It is sent directly to the control plane and is never saved in this browser.', updateComposeHint: 'Leave empty to keep the protected Compose document currently stored by the control plane.', createStack: 'Create stack', saveChanges: 'Save changes', cancelEdit: 'Cancel edit', stackSaved: 'Stack configuration saved.',
    stackCatalog: 'Stack catalog', noStacks: 'No managed stacks yet.', noAgentsForResources: 'Enroll and enable an agent before creating this resource.', revision: 'Revision', status: 'Status', pending: 'Pending', active: 'Active', failed: 'Failed', restart: 'Restart', stop: 'Stop',
    routesTitle: 'Routes & domains', routesDescription: 'Publish hostnames through a tunnel or public gateway and balance traffic across backend targets.', newRoute: 'New route', editRoute: 'Edit route', gatewayAgent: 'Gateway agent', hostname: 'Hostname', hostnamePlaceholder: 'app.example.com', exposure: 'Exposure', tunnel: 'Tunnel', tunnelDescription: 'Route through the private Cloudflare tunnel entrypoint.', publicIp: 'Public IP', publicIpDescription: 'Publish through the public TLS entrypoint with automatic certificates.',
    backends: 'Backend URLs', addBackend: 'Add backend', removeBackend: 'Remove backend', createRoute: 'Create route', routeSaved: 'Route configuration saved.', routeCatalog: 'Route catalog', noRoutes: 'No managed routes yet.', noBackends: 'No backend targets.',
    servicesTitle: 'Service catalog', servicesDescription: 'A unified inventory of deployment configuration and reported runtime health.', serviceCatalog: 'All services', manageStacks: 'Manage stacks', manageRoutes: 'Manage routes', noServices: 'No stacks or routes are configured yet.',
    observability: 'Observability', monitoring: 'Monitoring', logs: 'Service logs', backups: 'Backups & restore', monitoringTitle: 'Fleet monitoring', monitoringDescription: 'Current node resources and container runtime health reported by enrolled agents.', reportingAgents: 'Reporting agents', healthyServices: 'Healthy services', unhealthyServices: 'Unhealthy services', staleAgents: 'Stale agents', noMonitoringData: 'No telemetry has been reported yet.', runtimeHealth: 'Runtime health', runtimeHealthy: 'Healthy', uptime: 'Uptime', loadAverage: 'Load 1 / 5 / 15', lastObserved: 'Last observed', memoryUsage: 'Memory usage', runtimeServices: 'Runtime services', noRuntimeServices: 'No runtime services were reported.', receivedAt: 'Received', stale: 'Stale data', fresh: 'Fresh data', unhealthy: 'Unhealthy', starting: 'Starting', stopped: 'Stopped',
    logsTitle: 'Service logs', logsDescription: 'Request bounded recent logs for a Compose service from its managing agent.', logsPermissionNotice: 'Service log requests require the Operator or Owner role. Your Viewer role cannot invoke them.', stack: 'Stack', chooseStack: 'Choose a stack', composeService: 'Compose service', composeServiceHint: 'Enter the exact Compose service identifier.', tailLines: 'Tail lines', timeWindow: 'Time window', last15Minutes: 'Last 15 minutes', lastHour: 'Last hour', last6Hours: 'Last 6 hours', last24Hours: 'Last 24 hours', availableHistory: 'Available history', requestLogs: 'Request logs', invalidServiceName: 'Enter a valid Compose service identifier.', logRequestFailed: 'The agent could not complete this log request.', copyFailed: 'The log output could not be copied.', noStacksForLogs: 'No managed stacks are available for log requests.', logOutput: 'Log output', claimed: 'In progress', succeeded: 'Succeeded', wrapLines: 'Wrap lines', unwrapLines: 'Do not wrap', copy: 'Copy', waitingForLogs: 'Waiting for the agent to return logs', noLogOutput: 'No log output has been requested.', logsTruncated: 'This output was truncated to keep the response and browser memory bounded.',
    backupsTitle: 'Backups & restore', backupsDescription: 'Create and review stack backups, and restore succeeded revisions with explicit owner approval.', totalBackups: 'Total backups', succeededBackups: 'Succeeded', failedBackups: 'Failed', storedBackupSize: 'Reported size', backupTarget: 'Backup target', localTarget: 'Local', nasTarget: 'NAS', createBackup: 'Create backup', backupViewerNotice: 'Your Viewer role can review backup history but cannot create backups or restore them.', backupQueued: 'The backup was queued for the agent.', restoreQueued: 'The restore was queued for the agent.', confirmRestoreTitle: 'Confirm stack restore', confirmRestoreDescription: 'Restore the named stack from backup', restoreWarning: 'Restoring changes the running stack to the selected backup revision. Confirm only after checking the stack and backup identifiers.', cancel: 'Cancel', confirmRestore: 'Confirm restore', backupHistory: 'Backup history', restoreHistory: 'Restore history', operationsActive: 'Operations are active', noBackups: 'No backups have been created yet.', noRestores: 'No restore operations have been requested.', createdAt: 'Created', completedAt: 'Completed', notCompleted: 'Not completed', backupSize: 'Size', fileCount: 'Files', duration: 'Duration', checksum: 'Checksum', resultMessage: 'Result', restoreBackup: 'Restore backup', running: 'Running', backupContext: 'Backups', logsContext: 'Logs', monitoringContext: 'Monitoring', deploymentState: 'Deployment state', runtimeState: 'Runtime state', telemetryUnavailable: 'No runtime telemetry', commandQueued: 'The stack action was queued for the agent.',
    cloudflareManagement: 'Cloudflare management', cloudflareManagementTitle: 'Cloudflare edge management', cloudflareManagementDescription: 'Connect accounts, discover authoritative zones, and publish tunnel routes as managed public hostnames.', cloudflareAccounts: 'Accounts', cloudflareZones: 'Zones', publicHostnames: 'Public hostnames', cloudflareViewerNotice: 'Your Viewer role can inspect Cloudflare configuration and deployment state but cannot change it.', addCloudflareAccount: 'Connect an account', cloudflareCredentialsHint: 'Credentials are encrypted by the control plane. API tokens are write-only and never returned to this interface.', accountName: 'Account name', accountIdentifier: 'Account identifier', accountIdentifierHint: 'Exactly 32 hexadecimal characters from Cloudflare.', cloudflareApiToken: 'API token', apiTokenNeverShown: 'API token protected and never shown', addAccount: 'Add account', cloudflareAccountCreated: 'Cloudflare account connected.', lastSync: 'Last zone sync', lastError: 'Last error', none: 'None', cloudflareOperationFailed: 'The last Cloudflare operation failed. Test the credentials or retry synchronization.', viewZones: 'View zones', testAccount: 'Test', syncZones: 'Sync', cloudflareTestSucceeded: 'Cloudflare credentials verified.', cloudflareSyncSucceeded: 'Cloudflare zones synchronized.', noCloudflareAccounts: 'No Cloudflare accounts are connected yet.', cloudflareAccount: 'Cloudflare account', zoneAccountHint: 'Select an account to inspect only the zones discovered for it.', chooseAccount: 'Choose an account', refreshZones: 'Refresh zones', zoneIdentifier: 'Zone identifier', noSyncedZones: 'No zones have been discovered for this account. Run Sync from the Accounts tab.', chooseAccountForZones: 'Select a Cloudflare account to inspect its synchronized zones.', publishHostname: 'Publish hostname', publicHostnameRelationshipHint: 'Choose an account and zone, then pair its tunnel connector with an enabled tunnel route inside that zone. The route remains the authoritative source of the hostname.', cloudflareZone: 'Cloudflare zone', chooseZone: 'Choose a synced zone', cloudflareConnector: 'Tunnel connector', chooseTunnelConnector: 'Choose an assigned connector', tunnelRoute: 'Tunnel route', chooseEligibleRoute: 'Choose an eligible route', proxied: 'Cloudflare proxied', proxiedHint: 'Send traffic through the Cloudflare proxy instead of DNS-only resolution.', publicHostnameCreated: 'Public hostname deployment completed.', publicHostnameRetryQueued: 'The failed public hostname was retried.', publicHostnameUpdated: 'Public hostname deployment updated.', proxyMode: 'DNS mode', dnsOnly: 'DNS only', publicHostnameDeploymentFailed: 'The latest deployment failed. Review the relationships and retry.', retryDeployment: 'Retry', disableHostname: 'Disable hostname', enableHostname: 'Enable hostname', noPublicHostnames: 'No public hostnames are managed yet.', cloudflareRelationshipConflict: 'The selected zone, connector, tunnel, and route are not compatible or the hostname is already managed.', tunnelUuid: 'Tunnel UUID', tunnelUuidHint: 'Optional. Requires a Cloudflare account and must be a valid tunnel UUID.', optionalCloudflareAccount: 'Cloudflare account (optional)', noCloudflareAccount: 'No Cloudflare account', connectorAccountRequired: 'Choose a Cloudflare account before entering a tunnel UUID.', connectorAccount: 'Account', connectorTunnel: 'Tunnel',
  },
  ar: {
    appName: 'GatewayControl', controlPlane: 'مخدم التحكم', loading: 'جارٍ فتح مخدم التحكم',
    startupError: 'تعذر الوصول إلى مخدم التحكم.', retry: 'إعادة المحاولة', changeLanguage: 'تغيير اللغة',
    changeTheme: 'تغيير المظهر', setupEyebrow: 'الإعداد لأول مرة', setupTitle: 'أنشئ غرفة تحكمك الخاصة.',
    setupDescription: 'أنشئ حساب المالك الذي سيدير نسخة GatewayControl هذه.', ownerIdentity: 'هوية المالك',
    secureAccount: 'حساب آمن', step: 'الخطوة', of: 'من', email: 'البريد الإلكتروني', emailHint: 'استخدم عنوان المالك الرئيسي.',
    password: 'كلمة المرور', passwordHint: 'استخدم 12 محرفاً على الأقل.', passwordConfirmation: 'تأكيد كلمة المرور',
    continue: 'متابعة', back: 'رجوع', createControlPlane: 'إنشاء مخدم التحكم', setupSecurity: 'تُرسل بيانات الدخول إلى مخدم التحكم من نفس النطاق فقط.',
    passwordsMismatch: 'كلمتا المرور غير متطابقتين.', passwordTooShort: 'يجب ألا تقل كلمة المرور عن 12 محرفاً.',
    loginTitle: 'مرحباً بعودتك.', loginDescription: 'سجّل الدخول لإدارة البوابات والعملاء.', signIn: 'تسجيل الدخول',
    invalidCredentials: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.', requestFailed: 'تعذر إكمال الطلب. حاول مرة أخرى.',
    forbidden: 'لا يملك حسابك صلاحية تنفيذ هذا الإجراء.', conflict: 'هذه القيمة موجودة أو اكتملت العملية مسبقاً.',
    dashboard: 'لوحة التحكم', infrastructure: 'البنية التحتية', agents: 'العملاء', networking: 'الشبكات', connectors: 'موصلات كلاودفلير',
    services: 'الخدمات', routes: 'المسارات والنطاقات', stacks: 'حزم Compose', system: 'النظام', notifications: 'إشعارات تلغرام',
    closeNavigation: 'إغلاق التنقل', openNavigation: 'فتح التنقل', signedInAs: 'تم تسجيل الدخول باسم', logout: 'تسجيل الخروج',
    owner: 'المالك', operator: 'المشغّل', viewer: 'المشاهد', healthy: 'مخدم التحكم متصل', overviewEyebrow: 'نظرة تشغيلية',
    overviewTitle: 'بنيتك التحتية في غرفة تحكم هادئة.', overviewDescription: 'سجّل العملاء واربط أنفاق كلاودفلير ووجّه تنبيهات التشغيل من مساحة عمل آمنة واحدة.',
    manageAgents: 'إدارة العملاء', addConnector: 'إضافة موصل', secureSession: 'جلسة آمنة عبر ملفات الارتباط', noSecretsStored: 'الأسرار محفوظة في المخدم',
    agentsTitle: 'أسطول العملاء', agentsDescription: 'سجّل الأجهزة التي تنفذ أعمال مخدم التحكم وترسل نبضات الحالة.', addAgent: 'تسجيل عميل',
    agentName: 'اسم العميل', agentNamePlaceholder: 'production-edge-01', controlBaseUrl: 'الرابط الأساسي لمخدم التحكم',
    controlBaseUrlHint: 'الرابط الذي يستخدمه العميل للوصول إلى GatewayControl.', containerImage: 'صورة العميل', createAgent: 'إنشاء التسجيل',
    enrollmentCommand: 'أمر التسجيل لمرة واحدة', enrollmentWarning: 'يحتوي هذا الأمر على سر قصير الأجل. يظهر مرة واحدة ولا يخزنه هذا المتصفح.',
    copyCommand: 'نسخ الأمر', copied: 'تم النسخ', expires: 'ينتهي', agent: 'العميل', enrollment: 'التسجيل', heartbeat: 'نبض الحالة',
    enrolled: 'مسجّل', awaitingEnrollment: 'بانتظار التسجيل', never: 'لم يصل', noAgents: 'لا يوجد عملاء مسجّلون بعد.', removeAgent: 'إزالة', confirmAgentRemovalTitle: 'تأكيد إزالة العميل', agentRemovalDescription: 'إزالة هذا العميل من الأسطول النشط:', agentRemovalWarning: 'يُحذف العميل غير المسجّل وغير المستخدم نهائياً. يُؤرشف العميل المسجّل وتُبطل بيانات اعتماده. تمنع الحزم أو المسارات أو الموصلات أو النسخ أو الاستعادات المرتبطة والأوامر النشطة عملية الإزالة.', confirmRemoveAgent: 'إزالة العميل', agentRemovalBlocked: 'أعد تعيين موارد العميل وانتظر اكتمال الأوامر النشطة قبل إزالته.', agentDeleted: 'حُذف العميل غير المسجّل نهائياً.', agentArchived: 'أُرشف العميل المسجّل وأُبطلت بيانات اعتماده.', cleanupAgentTitle: 'تنظيف جهاز العميل', cleanupAgentDescription: 'شغّل هذا الأمر على جهاز العميل السابق لإزالة حاويته وVolume الحالة الخاصة به فقط. لن تُحذف الحزم المُدارة أو النسخ أو بيانات Traefik المشتركة.', copyCleanupCommand: 'نسخ أمر التنظيف',
    connectorsTitle: 'موصلات كلاودفلير', connectorsDescription: 'احفظ بيانات الموصل بأمان وتحكم في الأنفاق المسموح لها بالعمل.',
    connectorName: 'اسم الموصل', connectorNamePlaceholder: 'primary-tunnel', connectorToken: 'توكن الموصل',
    connectorTokenHint: 'يشفّر مخدم التحكم التوكن ولا يعيده أو يعرضه مطلقاً.', enabled: 'مفعّل', disabled: 'معطّل',
    createConnector: 'إضافة الموصل', noConnectors: 'لا توجد موصلات مضبوطة بعد.', tokenNeverShown: 'التوكن محمي',
    assignedAgent: 'عميل البوابة', chooseAgent: 'اختر العميل الذي سيشغّل هذا الموصل', noConnectorAgents: 'أنشئ عميلاً قبل إضافة موصل كلاودفلير.',
    insecureHttpWarning: 'التسجيل عبر HTTP مخصص فقط للتثبيت المحلي الأول ضمن شبكة موثوقة. استخدم رابط HTTPS للعقد البعيدة.',
    notificationsTitle: 'إشعارات تلغرام', notificationsDescription: 'اختر أحداث التشغيل التي يرسلها بوت تلغرام.',
    configured: 'تم الإعداد', notConfigured: 'غير معدّ', botToken: 'توكن البوت', botTokenPlaceholder: '123456789:AA...',
    groupId: 'معرف المجموعة أو المحادثة', groupIdPlaceholder: '-1001234567890', saveSettings: 'حفظ الإعدادات', testConnection: 'إرسال اختبار',
    testSent: 'تم إرسال إشعار الاختبار.', settingsSaved: 'تم حفظ إعدادات تلغرام.', selectEvents: 'أحداث الإشعارات',
    agentOffline: 'انقطاع اتصال العميل', serviceUnhealthy: 'تدهور صحة خدمة', deploymentFailed: 'فشل عملية نشر',
    certificateExpiring: 'اقتراب انتهاء شهادة', backupFailed: 'فشل النسخ أو الاستعادة', backupSucceeded: 'نجاح النسخ الاحتياطي',
    existingSecretNotice: 'تبقى بيانات الدخول الحالية مخفية، ويمكن اختبارها دون إدخال التوكن مجدداً.',
    replacementRequired: 'يتطلب المخدم الحالي توكن بوت ومعرف مجموعة جديدين لحفظ أي تغيير. لا تدعم واجهة التحديث إبقاء بيانات الدخول الحالية بعد.',
    enterReplacement: 'أدخل بيانات الاستبدال معاً لحفظ التغييرات.', readOnly: 'يملك دور المشاهد صلاحية القراءة فقط.',
    refresh: 'تحديث', loadingData: 'جارٍ تحميل البيانات', lastHeartbeat: 'آخر نبض حالة', unknown: 'غير معروف', previewTitle: 'قريباً',
    previewDescription: 'هذه المساحة جاهزة لمسار عمل مخدم التحكم.', goDashboard: 'العودة إلى لوحة التحكم', validationError: 'تحقق من الحقول وحاول مرة أخرى.',
    onlineAgents: 'العملاء المتصلون', activeConnectors: 'الموصلات الفعالة', fleetReadiness: 'جاهزية الأسطول', liveTopology: 'المخطط الحي',
    topologyDescription: 'المسار الحالي من مخدم التحكم إلى البنية التحتية المُدارة.', controller: 'مخدم التحكم', databaseReady: 'قاعدة PostgreSQL جاهزة',
    encryptedSecrets: 'مخزن الأسرار المشفر', connectedAgents: 'عملاء متصلون', connectorsRunning: 'موصلات مفعلة', noOperationalData: 'سجّل أول عميل للبدء بجمع بيانات التشغيل الحية.',
    stacksTitle: 'حزم Compose المُدارة', stacksDescription: 'انشر مشاريع Compose ذات الإصدارات وشغّلها على العملاء المسجّلين.', newStack: 'حزمة جديدة', editStack: 'تعديل الحزمة', basicDetails: 'التفاصيل الأساسية', composeConfiguration: 'إعداد Compose',
    name: 'الاسم', projectName: 'اسم المشروع', projectNameHint: 'أحرف إنجليزية صغيرة وأرقام وشرطات سفلية وعادية.', composeYaml: 'ملف Compose بصيغة YAML', composeHint: 'ألصق مستند Compose المُدار كاملاً. يُرسل مباشرة إلى مخدم التحكم ولا يُحفظ في هذا المتصفح.', updateComposeHint: 'اتركه فارغاً للإبقاء على مستند Compose المحمي والمحفوظ حالياً في مخدم التحكم.', createStack: 'إنشاء الحزمة', saveChanges: 'حفظ التغييرات', cancelEdit: 'إلغاء التعديل', stackSaved: 'تم حفظ إعداد الحزمة.',
    stackCatalog: 'دليل الحزم', noStacks: 'لا توجد حزم مُدارة بعد.', noAgentsForResources: 'سجّل عميلاً وفعّله قبل إنشاء هذا المورد.', revision: 'المراجعة', status: 'الحالة', pending: 'قيد الانتظار', active: 'فعّال', failed: 'فشل', restart: 'إعادة التشغيل', stop: 'إيقاف',
    routesTitle: 'المسارات والنطاقات', routesDescription: 'انشر أسماء المضيفين عبر نفق أو بوابة عامة ووزّع الحركة على الوجهات الخلفية.', newRoute: 'مسار جديد', editRoute: 'تعديل المسار', gatewayAgent: 'عميل البوابة', hostname: 'اسم المضيف', hostnamePlaceholder: 'app.example.com', exposure: 'طريقة الإتاحة', tunnel: 'نفق', tunnelDescription: 'وجّه عبر نقطة دخول نفق كلاودفلير الخاصة.', publicIp: 'عنوان IP عام', publicIpDescription: 'انشر عبر نقطة دخول TLS العامة مع شهادات تلقائية.',
    backends: 'روابط الوجهات الخلفية', addBackend: 'إضافة وجهة', removeBackend: 'إزالة الوجهة', createRoute: 'إنشاء المسار', routeSaved: 'تم حفظ إعداد المسار.', routeCatalog: 'دليل المسارات', noRoutes: 'لا توجد مسارات مُدارة بعد.', noBackends: 'لا توجد وجهات خلفية.',
    servicesTitle: 'دليل الخدمات', servicesDescription: 'قائمة موحّدة لإعدادات النشر وصحة التشغيل التي أبلغ عنها العملاء.', serviceCatalog: 'كل الخدمات', manageStacks: 'إدارة الحزم', manageRoutes: 'إدارة المسارات', noServices: 'لا توجد حزم أو مسارات مضبوطة بعد.',
    observability: 'المراقبة', monitoring: 'مراقبة التشغيل', logs: 'سجلات الخدمات', backups: 'النسخ والاستعادة', monitoringTitle: 'مراقبة الأسطول', monitoringDescription: 'موارد العقد الحالية وصحة تشغيل الحاويات التي أبلغ عنها العملاء المسجّلون.', reportingAgents: 'العملاء المبلّغون', healthyServices: 'الخدمات السليمة', unhealthyServices: 'الخدمات المتدهورة', staleAgents: 'العملاء ببيانات قديمة', noMonitoringData: 'لم تصل أي بيانات مراقبة بعد.', runtimeHealth: 'صحة التشغيل', runtimeHealthy: 'سليمة', uptime: 'مدة التشغيل', loadAverage: 'الحمل 1 / 5 / 15', lastObserved: 'آخر رصد', memoryUsage: 'استخدام الذاكرة', runtimeServices: 'خدمات التشغيل', noRuntimeServices: 'لم يُبلّغ عن خدمات تشغيل.', receivedAt: 'وقت الاستلام', stale: 'بيانات قديمة', fresh: 'بيانات حديثة', unhealthy: 'متدهورة', starting: 'قيد البدء', stopped: 'متوقفة',
    logsTitle: 'سجلات الخدمات', logsDescription: 'اطلب سجلات حديثة ومحدودة لخدمة Compose من العميل الذي يديرها.', logsPermissionNotice: 'يتطلب طلب سجلات الخدمات دور المشغّل أو المالك. لا يمكن لدور المشاهد تنفيذ الطلب.', stack: 'الحزمة', chooseStack: 'اختر حزمة', composeService: 'خدمة Compose', composeServiceHint: 'أدخل معرّف خدمة Compose المطابق تماماً.', tailLines: 'عدد الأسطر الأخيرة', timeWindow: 'الفترة الزمنية', last15Minutes: 'آخر 15 دقيقة', lastHour: 'آخر ساعة', last6Hours: 'آخر 6 ساعات', last24Hours: 'آخر 24 ساعة', availableHistory: 'السجل المتاح', requestLogs: 'طلب السجلات', invalidServiceName: 'أدخل معرّف خدمة Compose صالحاً.', logRequestFailed: 'تعذر على العميل إكمال طلب السجلات.', copyFailed: 'تعذر نسخ مخرجات السجل.', noStacksForLogs: 'لا توجد حزم مُدارة متاحة لطلبات السجلات.', logOutput: 'مخرجات السجل', claimed: 'قيد التنفيذ', succeeded: 'نجح', wrapLines: 'التفاف الأسطر', unwrapLines: 'دون التفاف', copy: 'نسخ', waitingForLogs: 'بانتظار إعادة السجلات من العميل', noLogOutput: 'لم تُطلب أي مخرجات سجل بعد.', logsTruncated: 'اقتُطعت هذه المخرجات لإبقاء الاستجابة وذاكرة المتصفح ضمن حدود آمنة.',
    backupsTitle: 'النسخ الاحتياطي والاستعادة', backupsDescription: 'أنشئ نسخ الحزم وراجعها، واستعد المراجعات الناجحة بموافقة صريحة من المالك.', totalBackups: 'إجمالي النسخ', succeededBackups: 'الناجحة', failedBackups: 'الفاشلة', storedBackupSize: 'الحجم المبلّغ', backupTarget: 'وجهة النسخ', localTarget: 'محلي', nasTarget: 'تخزين شبكي', createBackup: 'إنشاء نسخة', backupViewerNotice: 'يمكن لدور المشاهد مراجعة سجل النسخ، ولا يمكنه إنشاء نسخ أو استعادتها.', backupQueued: 'أُدرج النسخ الاحتياطي في قائمة انتظار العميل.', restoreQueued: 'أُدرجت الاستعادة في قائمة انتظار العميل.', confirmRestoreTitle: 'تأكيد استعادة الحزمة', confirmRestoreDescription: 'استعادة الحزمة المسماة من النسخة', restoreWarning: 'تغيّر الاستعادة الحزمة المشغّلة إلى مراجعة النسخة المحددة. أكّد فقط بعد التحقق من معرّفي الحزمة والنسخة.', cancel: 'إلغاء', confirmRestore: 'تأكيد الاستعادة', backupHistory: 'سجل النسخ', restoreHistory: 'سجل الاستعادة', operationsActive: 'توجد عمليات نشطة', noBackups: 'لم تُنشأ نسخ احتياطية بعد.', noRestores: 'لم تُطلب أي عملية استعادة.', createdAt: 'تاريخ الإنشاء', completedAt: 'تاريخ الاكتمال', notCompleted: 'لم تكتمل', backupSize: 'الحجم', fileCount: 'الملفات', duration: 'المدة', checksum: 'بصمة التحقق', resultMessage: 'النتيجة', restoreBackup: 'استعادة النسخة', running: 'قيد التشغيل', backupContext: 'النسخ', logsContext: 'السجلات', monitoringContext: 'المراقبة', deploymentState: 'حالة النشر', runtimeState: 'حالة التشغيل', telemetryUnavailable: 'لا توجد بيانات تشغيل', commandQueued: 'أُدرج إجراء الحزمة في قائمة انتظار العميل.',
    cloudflareManagement: 'إدارة كلاودفلير', cloudflareManagementTitle: 'إدارة حافة كلاودفلير', cloudflareManagementDescription: 'اربط الحسابات واكتشف النطاقات الموثوقة وانشر مسارات الأنفاق كأسماء مضيفين عامة مُدارة.', cloudflareAccounts: 'الحسابات', cloudflareZones: 'النطاقات', publicHostnames: 'أسماء المضيفين العامة', cloudflareViewerNotice: 'يمكن لدور المشاهد فحص إعدادات كلاودفلير وحالة النشر دون تغييرها.', addCloudflareAccount: 'ربط حساب', cloudflareCredentialsHint: 'يشفّر مخدم التحكم بيانات الدخول. توكنات API مخصصة للكتابة فقط ولا تعاد إلى هذه الواجهة.', accountName: 'اسم الحساب', accountIdentifier: 'معرّف الحساب', accountIdentifierHint: 'يتكون من 32 محرفاً ست عشرياً تماماً من كلاودفلير.', cloudflareApiToken: 'توكن API', apiTokenNeverShown: 'توكن API محمي ولا يُعرض مطلقاً', addAccount: 'إضافة الحساب', cloudflareAccountCreated: 'تم ربط حساب كلاودفلير.', lastSync: 'آخر مزامنة للنطاقات', lastError: 'آخر خطأ', none: 'لا يوجد', cloudflareOperationFailed: 'فشلت آخر عملية لكلاودفلير. اختبر بيانات الدخول أو أعد المزامنة.', viewZones: 'عرض النطاقات', testAccount: 'اختبار', syncZones: 'مزامنة', cloudflareTestSucceeded: 'تم التحقق من بيانات دخول كلاودفلير.', cloudflareSyncSucceeded: 'تمت مزامنة نطاقات كلاودفلير.', noCloudflareAccounts: 'لا توجد حسابات كلاودفلير مرتبطة بعد.', cloudflareAccount: 'حساب كلاودفلير', zoneAccountHint: 'اختر حساباً لفحص النطاقات المكتشفة له فقط.', chooseAccount: 'اختر حساباً', refreshZones: 'تحديث النطاقات', zoneIdentifier: 'معرّف النطاق', noSyncedZones: 'لم تُكتشف نطاقات لهذا الحساب. نفّذ المزامنة من تبويب الحسابات.', chooseAccountForZones: 'اختر حساب كلاودفلير لفحص نطاقاته المتزامنة.', publishHostname: 'نشر اسم المضيف', publicHostnameRelationshipHint: 'اختر حساباً ونطاقاً، ثم اربط موصل النفق بمسار نفق مفعّل داخل النطاق. يبقى المسار المصدر الموثوق لاسم المضيف.', cloudflareZone: 'نطاق كلاودفلير', chooseZone: 'اختر نطاقاً متزامناً', cloudflareConnector: 'موصل النفق', chooseTunnelConnector: 'اختر موصلاً مرتبطاً', tunnelRoute: 'مسار النفق', chooseEligibleRoute: 'اختر مساراً مؤهلاً', proxied: 'عبر وكيل كلاودفلير', proxiedHint: 'مرّر الحركة عبر وكيل كلاودفلير بدلاً من تحليل DNS فقط.', publicHostnameCreated: 'اكتمل نشر اسم المضيف العام.', publicHostnameRetryQueued: 'تمت إعادة محاولة اسم المضيف العام الفاشل.', publicHostnameUpdated: 'تم تحديث نشر اسم المضيف العام.', proxyMode: 'وضع DNS', dnsOnly: 'DNS فقط', publicHostnameDeploymentFailed: 'فشل آخر نشر. راجع العلاقات وأعد المحاولة.', retryDeployment: 'إعادة المحاولة', disableHostname: 'تعطيل اسم المضيف', enableHostname: 'تفعيل اسم المضيف', noPublicHostnames: 'لا توجد أسماء مضيفين عامة مُدارة بعد.', cloudflareRelationshipConflict: 'النطاق والموصل والنفق والمسار المحددة غير متوافقة أو أن اسم المضيف مُدار بالفعل.', tunnelUuid: 'معرّف UUID للنفق', tunnelUuidHint: 'اختياري. يتطلب حساب كلاودفلير ويجب أن يكون معرّف نفق UUID صالحاً.', optionalCloudflareAccount: 'حساب كلاودفلير (اختياري)', noCloudflareAccount: 'دون حساب كلاودفلير', connectorAccountRequired: 'اختر حساب كلاودفلير قبل إدخال معرّف UUID للنفق.', connectorAccount: 'الحساب', connectorTunnel: 'النفق',
  },
} as const

export type MessageKey = keyof typeof messages.en
export type Translate = (key: MessageKey) => string

const panelClass = 'rounded-[1.4rem] border border-stone-200/80 bg-sand-50 shadow-panel dark:border-white/[0.07] dark:bg-ink-900/80'
const inputClass = 'h-12 w-full rounded-xl border border-stone-200 bg-white px-3.5 text-sm font-semibold text-ink-800 outline-none transition placeholder:text-stone-300 focus:border-mint-400 focus:ring-4 focus:ring-mint-400/10 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/[0.08] dark:bg-white/[0.035] dark:text-stone-100 dark:placeholder:text-stone-600'
const primaryButton = 'flex min-h-12 items-center justify-center gap-2 rounded-xl bg-ink-900 px-5 text-sm font-extrabold text-white transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 dark:bg-mint-400 dark:text-ink-950'

function App() {
  const [locale, setLocale] = useState<Locale>(() => localStorage.getItem('gateway-control-locale') === 'ar' ? 'ar' : 'en')
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('gateway-control-theme') as Theme | null
    if (saved === 'dark' || saved === 'light') return saved
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  const [gate, setGate] = useState<Gate>('loading')
  const [user, setUser] = useState<User | null>(null)
  const [activePage, setActivePage] = useState<Page>('dashboard')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const t: Translate = (key) => messages[locale][key]

  useEffect(() => {
    document.documentElement.lang = locale
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
    const isDark = theme === 'dark'
    document.documentElement.classList.toggle('dark', isDark)
    localStorage.setItem('gateway-control-locale', locale)
    localStorage.setItem('gateway-control-theme', theme)
    const metaTheme = document.querySelector('meta[name="theme-color"]')
    if (metaTheme) metaTheme.setAttribute('content', isDark ? '#07100f' : '#f3f0e8')
  }, [locale, theme])

  useEffect(() => { void start() }, [])

  async function start() {
    setGate('loading')
    try {
      const status = await api.setupStatus()
      if (!status.setupComplete) {
        setGate('setup')
        return
      }
      try {
        const result = await api.me()
        setUser(result.user)
        setGate('app')
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          setGate('login')
          return
        }
        throw error
      }
    } catch {
      setGate('error')
    }
  }

  async function logout() {
    try { await api.logout() } catch { /* Clear local authenticated state even if the session already expired. */ }
    setUser(null)
    setActivePage('dashboard')
    setGate('login')
  }

  const common = { locale, theme, t, toggleLocale: () => setLocale(locale === 'en' ? 'ar' : 'en'), toggleTheme: () => setTheme(theme === 'light' ? 'dark' : 'light') }

  if (gate === 'loading' || gate === 'error') {
    return <StartupScreen {...common} failed={gate === 'error'} retry={() => void start()} />
  }
  if (gate === 'setup') {
    return <SetupScreen {...common} onAuthenticated={(owner) => { setUser(owner); setGate('app') }} />
  }
  if (gate === 'login') {
    return <LoginScreen {...common} onAuthenticated={(authenticatedUser) => { setUser(authenticatedUser); setGate('app') }} />
  }

  return (
    <div className="min-h-screen bg-sand-100 text-ink-800 transition-colors dark:bg-ink-950 dark:text-stone-100">
      <div className="flex min-h-screen">
        <Sidebar activePage={activePage} isOpen={sidebarOpen} locale={locale} t={t} navigate={(page) => { setActivePage(page); setSidebarOpen(false) }} close={() => setSidebarOpen(false)} />
        {sidebarOpen && <button type="button" aria-label={t('closeNavigation')} className="fixed inset-0 z-40 bg-ink-950/60 backdrop-blur-sm lg:hidden" onClick={() => setSidebarOpen(false)} />}
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar {...common} user={user!} openSidebar={() => setSidebarOpen(true)} logout={() => void logout()} />
          <main className="dashboard-grid flex-1 overflow-x-clip px-4 py-5 sm:px-6 sm:py-6 lg:px-8 lg:py-8 2xl:px-10">
            {activePage === 'dashboard' && <Dashboard t={t} navigate={setActivePage} />}
            {activePage === 'agents' && <AgentsPage t={t} locale={locale} role={user!.role} />}
            {activePage === 'connectors' && <ConnectorsPage t={t} role={user!.role} />}
            {activePage === 'cloudflareManagement' && <CloudflareManagementPage t={t} locale={locale} role={user!.role} />}
            {activePage === 'notifications' && <TelegramPage t={t} role={user!.role} />}
            {activePage === 'services' && <ServicesPage t={t} navigate={setActivePage} />}
            {activePage === 'routes' && <RoutesPage t={t} role={user!.role} />}
            {activePage === 'stacks' && <StacksPage t={t} role={user!.role} />}
            {activePage === 'monitoring' && <MonitoringPage t={t} locale={locale} />}
            {activePage === 'logs' && <LogsPage t={t} locale={locale} role={user!.role} />}
            {activePage === 'backups' && <BackupsPage t={t} locale={locale} role={user!.role} />}
          </main>
        </div>
      </div>
    </div>
  )
}

type CommonScreenProps = { locale: Locale; theme: Theme; t: Translate; toggleLocale: () => void; toggleTheme: () => void }

function PreferenceButtons({ locale, theme, t, toggleLocale, toggleTheme }: CommonScreenProps) {
  return <div className="flex items-center gap-2">
    <IconButton label={t('changeLanguage')} onClick={toggleLocale}><Languages size={18} /><span className="text-[0.65rem] font-black">{locale === 'en' ? 'AR' : 'EN'}</span></IconButton>
    <IconButton label={t('changeTheme')} onClick={toggleTheme}>
      <span className="inline-flex transition-transform duration-300 transform hover:scale-110 active:scale-95">
        {theme === 'light' ? <Moon size={18} className="text-violet-600 dark:text-violet-300" /> : <Sun size={18} className="text-amber-500" />}
      </span>
    </IconButton>
  </div>
}

function StartupScreen(props: CommonScreenProps & { failed: boolean; retry: () => void }) {
  return <AuthShell preferences={<PreferenceButtons {...props} />}>
    <div className="flex flex-col items-center text-center">
      <LogoMark large />
      <h1 className="pt-6 text-2xl font-black text-ink-900 dark:text-white">{props.failed ? props.t('startupError') : props.t('loading')}</h1>
      {props.failed ? <button type="button" className={`${primaryButton} mt-6`} onClick={props.retry}><RefreshCw size={17} />{props.t('retry')}</button> : <span className="mt-7 h-1.5 w-40 overflow-hidden rounded-full bg-stone-200 dark:bg-white/10"><span className="block h-full w-1/2 animate-pulse rounded-full bg-mint-400" /></span>}
    </div>
  </AuthShell>
}

function SetupScreen(props: CommonScreenProps & { onAuthenticated: (user: User) => void }) {
  const [step, setStep] = useState<1 | 2>(1)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (step === 1) { setStep(2); setError(''); return }
    if (password.length < 12) { setError(props.t('passwordTooShort')); return }
    if (password !== confirmation) { setError(props.t('passwordsMismatch')); return }
    setBusy(true); setError('')
    try {
      await api.setup(email, password)
      const result = await api.login(email, password)
      setPassword(''); setConfirmation('')
      props.onAuthenticated(result.user)
    } catch (caught) { setError(friendlyError(caught, props.t)); setBusy(false) }
  }

  return <AuthShell preferences={<PreferenceButtons {...props} />}>
    <div className="grid overflow-hidden rounded-[2rem] border border-stone-200/80 bg-sand-50 shadow-2xl shadow-ink-900/10 dark:border-white/[0.08] dark:bg-ink-900 lg:grid-cols-[0.82fr_1.18fr]">
      <div className="surface-glow relative overflow-hidden bg-ink-900 p-7 text-white sm:p-10">
        <LogoMark large />
        <p className="pt-10 text-xs font-extrabold uppercase tracking-[0.16em] text-mint-300">{props.t('setupEyebrow')}</p>
        <h1 className="max-w-md pt-3 text-3xl font-black leading-tight tracking-[-0.045em] sm:text-4xl">{props.t('setupTitle')}</h1>
        <p className="max-w-md pt-4 text-sm font-medium leading-7 text-stone-400">{props.t('setupDescription')}</p>
        <div className="relative mt-9 flex gap-3">
          {[props.t('ownerIdentity'), props.t('secureAccount')].map((label, index) => <div key={label} className={`flex-1 rounded-2xl border p-4 ${step === index + 1 ? 'border-mint-400/40 bg-mint-400/10' : 'border-white/[0.07] bg-white/[0.03]'}`}><span className="text-[0.65rem] font-black text-mint-300">0{index + 1}</span><span className="block pt-1 text-xs font-bold">{label}</span></div>)}
        </div>
      </div>
      <form onSubmit={submit} className="flex flex-col justify-center p-6 sm:p-10 lg:p-12">
        <p className="text-xs font-extrabold text-mint-500 dark:text-mint-300">{props.t('step')} {step} {props.t('of')} 2</p>
        <h2 className="pt-2 text-2xl font-black text-ink-900 dark:text-white">{props.t(step === 1 ? 'ownerIdentity' : 'secureAccount')}</h2>
        <div className="flex flex-col gap-5 pt-7">
          {step === 1 ? <Field label={props.t('email')} hint={props.t('emailHint')}><input autoFocus required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className={inputClass} /></Field> : <>
            <Field label={props.t('password')} hint={props.t('passwordHint')}><input autoFocus required minLength={12} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className={inputClass} /></Field>
            <Field label={props.t('passwordConfirmation')}><input required minLength={12} type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className={inputClass} /></Field>
          </>}
        </div>
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-col-reverse gap-3 pt-7 sm:flex-row sm:justify-end">
          {step === 2 && <button type="button" className="min-h-12 rounded-xl border border-stone-200 px-5 text-sm font-extrabold dark:border-white/10" onClick={() => { setStep(1); setError('') }}>{props.t('back')}</button>}
          <button disabled={busy} className={primaryButton}>{step === 1 ? props.t('continue') : props.t('createControlPlane')}<ChevronRight className="rtl:rotate-180" size={17} /></button>
        </div>
        <p className="flex items-start gap-2 pt-6 text-[0.68rem] font-semibold leading-5 text-stone-400"><ShieldCheck className="mt-0.5 shrink-0 text-mint-500" size={15} />{props.t('setupSecurity')}</p>
      </form>
    </div>
  </AuthShell>
}

function LoginScreen(props: CommonScreenProps & { onAuthenticated: (user: User) => void }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try { const result = await api.login(email, password); setPassword(''); props.onAuthenticated(result.user) }
    catch (caught) { setError(caught instanceof ApiError && caught.status === 401 ? props.t('invalidCredentials') : friendlyError(caught, props.t)); setBusy(false) }
  }
  return <AuthShell preferences={<PreferenceButtons {...props} />}>
    <div className={`${panelClass} mx-auto w-full max-w-md p-6 sm:p-9`}>
      <LogoMark large /><h1 className="pt-7 text-3xl font-black tracking-[-0.04em] text-ink-900 dark:text-white">{props.t('loginTitle')}</h1>
      <p className="pt-2 text-sm font-medium leading-6 text-stone-500 dark:text-stone-400">{props.t('loginDescription')}</p>
      <form onSubmit={submit} className="flex flex-col gap-5 pt-7">
        <Field label={props.t('email')}><input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className={inputClass} /></Field>
        <Field label={props.t('password')}><input required type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className={inputClass} /></Field>
        {error && <Alert>{error}</Alert>}
        <button disabled={busy} className={primaryButton}><LockKeyhole size={17} />{props.t('signIn')}</button>
      </form>
    </div>
  </AuthShell>
}

function AuthShell({ preferences, children }: { preferences: React.ReactNode; children: React.ReactNode }) {
  return <div className="dashboard-grid min-h-screen bg-sand-100 px-4 py-5 text-ink-800 dark:bg-ink-950 dark:text-stone-100 sm:px-6"><div className="mx-auto flex max-w-6xl justify-end">{preferences}</div><main className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-6xl items-center justify-center py-6">{children}</main></div>
}

const navigation: Array<{ label: MessageKey; items: Array<{ page: Page; label: MessageKey; icon: LucideIcon }> }> = [
  { label: 'dashboard', items: [{ page: 'dashboard', label: 'dashboard', icon: LayoutDashboard }] },
  { label: 'infrastructure', items: [{ page: 'agents', label: 'agents', icon: Server }, { page: 'services', label: 'services', icon: Container }, { page: 'stacks', label: 'stacks', icon: Cable }] },
  { label: 'networking', items: [{ page: 'connectors', label: 'connectors', icon: CloudCog }, { page: 'cloudflareManagement', label: 'cloudflareManagement', icon: Cloud }, { page: 'routes', label: 'routes', icon: Globe2 }] },
  { label: 'observability', items: [{ page: 'monitoring', label: 'monitoring', icon: Activity }, { page: 'logs', label: 'logs', icon: FileText }] },
  { label: 'system', items: [{ page: 'backups', label: 'backups', icon: DatabaseBackup }, { page: 'notifications', label: 'notifications', icon: BellRing }] },
]

function Sidebar({ activePage, isOpen, locale, t, navigate, close }: { activePage: Page; isOpen: boolean; locale: Locale; t: Translate; navigate: (page: Page) => void; close: () => void }) {
  return <aside style={{ insetInlineStart: 0 }} className={`surface-glow fixed inset-y-0 z-50 flex h-dvh w-[min(18rem,88vw)] shrink-0 flex-col overflow-hidden bg-ink-900 text-stone-200 shadow-2xl transition-transform duration-300 lg:sticky lg:top-0 lg:h-screen lg:w-[18rem] lg:translate-x-0 lg:self-start lg:shadow-none ${isOpen ? 'translate-x-0' : locale === 'ar' ? 'translate-x-full' : '-translate-x-full'}`}>
    <div className="relative flex h-[4.75rem] items-center justify-between border-b border-white/[0.07] px-5"><button type="button" onClick={() => navigate('dashboard')} className="flex items-center gap-3 text-start"><LogoMark /><span><strong className="block text-sm text-white">{t('appName')}</strong><span className="text-[0.62rem] font-bold uppercase tracking-[0.16em] text-mint-300/70">{t('controlPlane')}</span></span></button><button type="button" aria-label={t('closeNavigation')} className="rounded-xl p-2 lg:hidden" onClick={close}><X size={19} /></button></div>
    <nav aria-label={t('openNavigation')} className="relative flex-1 overflow-y-auto px-3 py-5"><div className="flex flex-col gap-6">{navigation.map((section) => <div key={section.label} className="flex flex-col gap-1.5"><p className="px-3 text-[0.65rem] font-extrabold uppercase tracking-[0.14em] text-stone-500">{t(section.label)}</p>{section.items.map(({ page, label, icon: Icon }) => <button key={page} type="button" onClick={() => navigate(page)} className={`flex min-h-11 items-center gap-3 rounded-xl px-3 text-start text-sm font-semibold transition ${activePage === page ? 'bg-mint-400 text-ink-950 shadow-glow' : 'text-stone-400 hover:bg-white/[0.06] hover:text-white'}`}><Icon size={18} /><span>{t(label)}</span></button>)}</div>)}</div></nav>
    <div className="relative border-t border-white/[0.07] p-4"><div className="flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.035] p-3.5"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-mint-400/10 text-mint-300"><ShieldCheck size={18} /></span><span className="text-xs font-bold text-white">{t('healthy')}</span></div></div>
  </aside>
}

function Topbar(props: CommonScreenProps & { user: User; openSidebar: () => void; logout: () => void }) {
  const initials = props.user.email.slice(0, 2).toUpperCase()
  return <header className="sticky top-0 z-30 flex min-h-[4.75rem] items-center gap-3 border-b border-stone-200/80 bg-sand-50/85 px-4 py-2 backdrop-blur-xl dark:border-white/[0.07] dark:bg-ink-950/80 sm:px-6 lg:px-8">
    <button type="button" aria-label={props.t('openNavigation')} className="rounded-xl border border-stone-200 bg-white p-2.5 lg:hidden dark:border-white/10 dark:bg-white/5" onClick={props.openSidebar}><Menu size={20} /></button>
    <div className="ms-auto flex min-w-0 items-center gap-1.5 sm:gap-2"><PreferenceButtons {...props} /><div className="ms-1 flex min-w-0 items-center gap-2 rounded-xl px-1.5 py-1"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ink-800 text-xs font-black text-mint-300 dark:bg-mint-400 dark:text-ink-950">{initials}</span><span className="hidden min-w-0 text-start md:block"><strong className="block max-w-48 truncate text-xs text-ink-800 dark:text-white">{props.user.email}</strong><span className="block text-[0.64rem] font-semibold text-stone-400">{props.t(props.user.role)}</span></span></div><IconButton label={props.t('logout')} onClick={props.logout}><LogOut size={18} /></IconButton></div>
  </header>
}

function Dashboard({ t, navigate }: { t: Translate; navigate: (page: Page) => void }) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    void Promise.all([api.agents(), api.connectors()])
      .then(([agentResult, connectorResult]) => {
        setAgents(agentResult.agents)
        setConnectors(connectorResult.connectors)
      })
      .catch(() => undefined)
      .finally(() => setLoading(false))
  }, [])
  const onlineAgents = agents.filter((agent) => agent.lastHeartbeatAt && Date.now() - new Date(agent.lastHeartbeatAt).getTime() < 90_000).length
  const enabledConnectors = connectors.filter((connector) => connector.enabled).length
  const readiness = agents.length === 0 ? 0 : Math.round((onlineAgents / agents.length) * 100)
  const stats = [
    { label: 'agents' as const, value: loading ? '—' : String(agents.length), note: `${onlineAgents} ${t('connectedAgents')}`, icon: Server },
    { label: 'onlineAgents' as const, value: loading ? '—' : `${onlineAgents}/${agents.length}`, note: t('lastHeartbeat'), icon: Activity },
    { label: 'activeConnectors' as const, value: loading ? '—' : String(enabledConnectors), note: `${connectors.length} ${t('connectorsRunning')}`, icon: CloudCog },
    { label: 'fleetReadiness' as const, value: loading ? '—' : `${readiness}%`, note: t('healthy'), icon: ShieldCheck },
  ]
  const cards = [{ icon: Server, title: 'agents' as const, action: 'manageAgents' as const, page: 'agents' as const }, { icon: CloudCog, title: 'connectors' as const, action: 'addConnector' as const, page: 'connectors' as const }, { icon: BellRing, title: 'notifications' as const, action: 'notifications' as const, page: 'notifications' as const }]

  return <div className="mx-auto flex w-full max-w-[112rem] flex-col gap-6">
    <section className="surface-glow relative overflow-hidden rounded-[1.75rem] bg-ink-900 p-6 text-white shadow-xl sm:p-9 lg:p-12">
      <div className="relative"><p className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.14em] text-mint-300"><Activity size={14} />{t('overviewEyebrow')}</p><h1 className="max-w-4xl pt-3 text-3xl font-black leading-tight tracking-[-0.045em] sm:text-4xl lg:text-5xl">{t('overviewTitle')}</h1><p className="max-w-2xl pt-4 text-sm font-medium leading-7 text-stone-400 sm:text-base">{t('overviewDescription')}</p><div className="flex flex-wrap gap-3 pt-7"><span className="flex items-center gap-2 rounded-full bg-mint-400/10 px-3 py-2 text-xs font-bold text-mint-300"><Check size={14} />{t('secureSession')}</span><span className="flex items-center gap-2 rounded-full bg-white/[0.05] px-3 py-2 text-xs font-bold text-stone-300"><ShieldCheck size={14} />{t('noSecretsStored')}</span></div></div>
    </section>
    <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-4">{stats.map(({ label, value, note, icon: Icon }) => <article key={label} className={`${panelClass} group relative overflow-hidden p-5 transition hover:-translate-y-0.5 hover:border-mint-400/40`}><div className="flex items-start justify-between gap-4"><div><p className="text-xs font-bold text-stone-500 dark:text-stone-400">{t(label)}</p><p className="pt-2 text-3xl font-black tracking-[-0.04em] text-ink-900 dark:text-white">{value}</p></div><span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-mint-400/10 text-mint-500 dark:text-mint-300"><Icon size={21} /></span></div><p className="pt-4 text-[0.68rem] font-bold text-stone-400">{note}</p><span className="absolute inset-x-0 bottom-0 h-0.5 origin-start scale-x-0 bg-mint-400 transition group-hover:scale-x-100" /></article>)}</section>
    <section className="grid grid-cols-1 gap-5 xl:grid-cols-5">
      <article className={`${panelClass} p-5 sm:p-6 xl:col-span-3`}><div><h2 className="flex items-center gap-2 text-base font-black text-ink-900 dark:text-white"><Network className="text-mint-500 dark:text-mint-300" size={18} />{t('liveTopology')}</h2><p className="pt-1 text-xs font-medium text-stone-400">{t('topologyDescription')}</p></div><div className="grid grid-cols-1 gap-3 pt-6 sm:grid-cols-2 xl:grid-cols-4">{[
        { icon: Network, title: t('controller'), note: t('databaseReady'), active: true },
        { icon: LockKeyhole, title: t('encryptedSecrets'), note: t('secureSession'), active: true },
        { icon: CloudCog, title: t('connectors'), note: `${enabledConnectors} ${t('connectorsRunning')}`, active: enabledConnectors > 0 },
        { icon: Server, title: t('agents'), note: `${onlineAgents} ${t('connectedAgents')}`, active: onlineAgents > 0 },
      ].map(({ icon: Icon, title, note, active }, index) => <div key={title} className="relative rounded-2xl border border-stone-200/80 bg-white/60 p-4 dark:border-white/[0.06] dark:bg-white/[0.025]"><span className={`flex h-10 w-10 items-center justify-center rounded-xl ${active ? 'bg-mint-400/10 text-mint-500 dark:text-mint-300' : 'bg-stone-200/60 text-stone-400 dark:bg-white/5'}`}><Icon size={18} /></span><h3 className="pt-4 text-xs font-extrabold text-ink-900 dark:text-white">{title}</h3><p className="pt-1 text-[0.65rem] font-semibold text-stone-400">{note}</p>{index < 3 && <span className="absolute -end-2.5 top-8 z-10 hidden h-px w-5 bg-stone-300 xl:block dark:bg-white/10" />}</div>)}</div>{!loading && agents.length === 0 && <p className="pt-5 text-xs font-semibold text-stone-400">{t('noOperationalData')}</p>}</article>
      <article className={`${panelClass} p-5 sm:p-6 xl:col-span-2`}><h2 className="text-base font-black text-ink-900 dark:text-white">{t('overviewEyebrow')}</h2><div className="grid grid-cols-1 gap-3 pt-5 sm:grid-cols-3 xl:grid-cols-1">{cards.map(({ icon: Icon, title, action, page }) => <button key={page} type="button" onClick={() => navigate(page)} className="group flex min-h-20 items-center gap-4 rounded-2xl border border-stone-200/80 bg-white/60 p-4 text-start transition hover:border-mint-400/40 dark:border-white/[0.06] dark:bg-white/[0.025]"><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-mint-400/10 text-mint-500 dark:text-mint-300"><Icon size={20} /></span><span className="min-w-0 flex-1"><strong className="block truncate text-xs text-ink-900 dark:text-white">{t(title)}</strong><span className="block pt-1 text-[0.65rem] font-bold text-mint-500 dark:text-mint-300">{t(action)}</span></span><ChevronRight className="shrink-0 text-stone-300 transition group-hover:translate-x-1 rtl:rotate-180 rtl:group-hover:-translate-x-1" size={16} /></button>)}</div></article>
    </section>
  </div>
}

function PageHeading({ icon: Icon, title, description, action }: { icon: LucideIcon; title: string; description: string; action?: React.ReactNode }) {
  return <section className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end"><div className="max-w-3xl"><span className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.14em] text-mint-500 dark:text-mint-300"><Icon size={15} />GatewayControl</span><h1 className="pt-2 text-3xl font-black tracking-[-0.045em] text-ink-900 dark:text-white sm:text-4xl">{title}</h1><p className="max-w-2xl pt-2 text-sm font-medium leading-6 text-stone-500 dark:text-stone-400 sm:text-base">{description}</p></div>{action}</section>
}

function defaultAgentBaseUrl(): string {
  const url = new URL(window.location.origin)
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) url.hostname = 'host.docker.internal'
  return url.origin
}

function AgentsPage({ t, locale, role }: { t: Translate; locale: Locale; role: Role }) {
  const [agents, setAgents] = useState<Agent[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [name, setName] = useState(''); const [baseUrl, setBaseUrl] = useState(defaultAgentBaseUrl); const [image, setImage] = useState('gateway-control-agent:local'); const [busy, setBusy] = useState(false); const [enrollment, setEnrollment] = useState<{ command: string; expiresAt: string } | null>(null); const [copied, setCopied] = useState(false); const [confirmingRemoval, setConfirmingRemoval] = useState<Agent | null>(null); const [cleanup, setCleanup] = useState<{ mode: 'deleted' | 'archived'; command: string } | null>(null); const [cleanupCopied, setCleanupCopied] = useState(false)
  async function load() { setLoading(true); setError(''); try { const [agentResult, configuration] = await Promise.all([api.agents(), api.configuration()]); setAgents(agentResult.agents); setImage((current) => current === 'gateway-control-agent:local' ? configuration.agentImage : current) } catch (caught) { setError(friendlyError(caught, t)) } finally { setLoading(false) } }
  useEffect(() => { void load() }, [])
  async function create(event: React.FormEvent) { event.preventDefault(); setBusy(true); setError(''); try { const result = await api.createAgent(name, baseUrl, image); setAgents((current) => [result.agent, ...current]); setEnrollment(result.enrollmentCommand ? { command: result.enrollmentCommand, expiresAt: result.enrollmentExpiresAt } : null); setName('') } catch (caught) { setError(friendlyError(caught, t)) } finally { setBusy(false) } }
  async function copy() { if (!enrollment) return; try { await copyText(enrollment.command); setCopied(true); window.setTimeout(() => setCopied(false), 2000) } catch { setError(t('requestFailed')) } }
  async function remove() { if (!confirmingRemoval) return; setBusy(true); setError(''); setCleanup(null); try { const result = await api.removeAgent(confirmingRemoval.id); setAgents((current) => current.filter((agent) => agent.id !== confirmingRemoval.id)); setCleanup({ mode: result.mode, command: result.cleanupCommand }); setConfirmingRemoval(null) } catch (caught) { setError(caught instanceof ApiError && caught.status === 409 ? t('agentRemovalBlocked') : friendlyError(caught, t)) } finally { setBusy(false) } }
  async function copyCleanup() { if (!cleanup) return; try { await copyText(cleanup.command); setCleanupCopied(true); window.setTimeout(() => setCleanupCopied(false), 2000) } catch { setError(t('requestFailed')) } }
  return <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-6"><PageHeading icon={Server} title={t('agentsTitle')} description={t('agentsDescription')} action={<button type="button" className="flex min-h-11 items-center gap-2 rounded-xl border border-stone-200 bg-white px-4 text-xs font-extrabold dark:border-white/10 dark:bg-white/5" onClick={() => void load()}><RefreshCw size={15} />{t('refresh')}</button>} />
    {role === 'viewer' && <Notice>{t('readOnly')}</Notice>}{error && <Alert>{error}</Alert>}
    {confirmingRemoval && <section role="alertdialog" aria-modal="false" aria-labelledby="agent-removal-title" className="rounded-[1.4rem] border border-rose-400/40 bg-rose-500/10 p-5 sm:p-6"><div className="flex items-start gap-3"><TriangleAlert className="mt-0.5 shrink-0 text-rose-600 dark:text-rose-300" size={21} /><div className="min-w-0 flex-1"><h2 id="agent-removal-title" className="font-black text-ink-900 dark:text-white">{t('confirmAgentRemovalTitle')}</h2><p className="pt-2 text-sm font-semibold leading-6 text-stone-600 dark:text-stone-300">{t('agentRemovalDescription')} <strong>{confirmingRemoval.name}</strong></p><p className="pt-2 text-xs font-bold leading-5 text-rose-700 dark:text-rose-300">{t('agentRemovalWarning')}</p><div className="flex flex-col-reverse gap-2 pt-5 sm:flex-row sm:justify-end"><button type="button" disabled={busy} className="flex min-h-11 items-center justify-center rounded-xl border border-stone-200 bg-white px-4 text-xs font-extrabold dark:border-white/10 dark:bg-white/5" onClick={() => setConfirmingRemoval(null)}>{t('cancel')}</button><button type="button" disabled={busy} className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-rose-600 px-4 text-xs font-extrabold text-white disabled:opacity-50" onClick={() => void remove()}><Trash2 size={15} />{t('confirmRemoveAgent')}</button></div></div></div></section>}
    {cleanup && <section className="overflow-hidden rounded-[1.4rem] border border-amber-400/40 bg-amber-500/10"><div className="flex flex-col justify-between gap-4 p-5 sm:flex-row sm:items-start sm:p-6"><div className="min-w-0"><h2 className="flex items-center gap-2 font-black text-ink-900 dark:text-white"><ShieldCheck className="text-amber-600 dark:text-amber-300" size={18} />{t('cleanupAgentTitle')}</h2><p className="pt-2 text-sm font-semibold text-stone-600 dark:text-stone-300">{t(cleanup.mode === 'deleted' ? 'agentDeleted' : 'agentArchived')}</p><p className="pt-2 text-xs font-semibold leading-5 text-stone-500 dark:text-stone-400">{t('cleanupAgentDescription')}</p></div><button type="button" onClick={() => void copyCleanup()} className="flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-ink-900 px-4 text-xs font-extrabold text-white dark:bg-mint-400 dark:text-ink-950"><Clipboard size={15} />{t(cleanupCopied ? 'copied' : 'copyCleanupCommand')}</button></div><pre dir="ltr" className="m-4 mt-0 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-ink-950 p-4 text-left font-mono text-xs leading-6 text-mint-100 sm:m-6 sm:mt-0">{cleanup.command}</pre></section>}
    {role !== 'viewer' && <form onSubmit={create} className={`${panelClass} grid grid-cols-1 gap-5 p-5 sm:p-6 xl:grid-cols-12 xl:items-end`}><div className="xl:col-span-3"><Field label={t('agentName')}><input required maxLength={120} value={name} placeholder={t('agentNamePlaceholder')} onChange={(event) => setName(event.target.value)} className={inputClass} /></Field></div><div className="xl:col-span-4"><Field label={t('controlBaseUrl')} hint={t('controlBaseUrlHint')}><input required type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} className={inputClass} /></Field></div><div className="xl:col-span-3"><Field label={t('containerImage')}><input required value={image} onChange={(event) => setImage(event.target.value)} className={inputClass} dir="ltr" /></Field></div><button disabled={busy} className={`${primaryButton} xl:col-span-2`}><Plus size={17} />{t('createAgent')}</button></form>}
    {enrollment && <section className="overflow-hidden rounded-[1.4rem] border border-mint-400/30 bg-ink-900 text-white shadow-xl"><div className="flex flex-col justify-between gap-4 border-b border-white/10 p-5 sm:flex-row sm:items-center sm:p-6"><div><h2 className="flex items-center gap-2 text-base font-black"><LockKeyhole className="text-mint-300" size={18} />{t('enrollmentCommand')}</h2><p className="pt-2 text-xs leading-5 text-stone-400">{t('enrollmentWarning')}</p></div><button type="button" onClick={() => void copy()} className="flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-mint-400 px-4 text-xs font-extrabold text-ink-950"><Clipboard size={15} />{t(copied ? 'copied' : 'copyCommand')}</button></div><div className="p-4 sm:p-6">{baseUrl.startsWith('http://') && <div className="mb-4"><Notice>{t('insecureHttpWarning')}</Notice></div>}<pre dir="ltr" className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-black/30 p-4 text-left font-mono text-xs leading-6 text-mint-100">{enrollment.command}</pre><p className="pt-3 text-[0.68rem] font-semibold text-stone-400">{t('expires')}: {formatDate(enrollment.expiresAt, locale)}</p></div></section>}
    <section className={`${panelClass} overflow-hidden`}><div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[44rem]"><thead><tr className="border-b border-stone-200/80 bg-stone-100/50 text-[0.65rem] font-extrabold uppercase text-stone-400 dark:border-white/[0.06] dark:bg-white/[0.025]"><th className="px-6 py-4 text-start">{t('agent')}</th><th className="px-4 py-4 text-start">{t('enrollment')}</th><th className="px-4 py-4 text-start">{t('lastHeartbeat')}</th>{role === 'owner' && <th className="px-4 py-4 text-end">{t('removeAgent')}</th>}</tr></thead><tbody>{agents.map((agent) => <AgentRow key={agent.id} agent={agent} t={t} locale={locale} canRemove={role === 'owner'} remove={() => setConfirmingRemoval(agent)} />)}</tbody></table></div><div className="flex flex-col gap-3 p-4 md:hidden">{agents.map((agent) => <AgentCard key={agent.id} agent={agent} t={t} locale={locale} canRemove={role === 'owner'} remove={() => setConfirmingRemoval(agent)} />)}</div>{!loading && agents.length === 0 && <Empty icon={Server} text={t('noAgents')} />}{loading && <Loading t={t} />}</section>
  </div>
}

function AgentRow({ agent, t, locale, canRemove, remove }: { agent: Agent; t: Translate; locale: Locale; canRemove: boolean; remove: () => void }) { return <tr className="border-b border-stone-200/70 text-sm last:border-0 dark:border-white/[0.05]"><td className="px-6 py-5 font-extrabold text-ink-900 dark:text-white">{agent.name}</td><td className="px-4 py-5"><Status active={Boolean(agent.enrolledAt)} label={t(agent.enrolledAt ? 'enrolled' : 'awaitingEnrollment')} /></td><td className="px-4 py-5 text-xs font-semibold text-stone-500 dark:text-stone-400">{agent.lastHeartbeatAt ? formatDate(agent.lastHeartbeatAt, locale) : t('never')}</td>{canRemove && <td className="px-4 py-5 text-end"><button type="button" onClick={remove} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-rose-300/70 px-3 text-xs font-extrabold text-rose-700 transition hover:bg-rose-500/10 dark:border-rose-400/30 dark:text-rose-300"><Trash2 size={14} />{t('removeAgent')}</button></td>}</tr> }
function AgentCard({ agent, t, locale, canRemove, remove }: { agent: Agent; t: Translate; locale: Locale; canRemove: boolean; remove: () => void }) { return <article className="rounded-2xl border border-stone-200/80 bg-white/60 p-4 dark:border-white/[0.06] dark:bg-white/[0.025]"><div className="flex items-center justify-between gap-3"><strong className="truncate text-sm text-ink-900 dark:text-white">{agent.name}</strong><Status active={Boolean(agent.enrolledAt)} label={t(agent.enrolledAt ? 'enrolled' : 'awaitingEnrollment')} /></div><p className="pt-4 text-[0.68rem] font-bold text-stone-400">{t('heartbeat')}: <span className="text-stone-600 dark:text-stone-300">{agent.lastHeartbeatAt ? formatDate(agent.lastHeartbeatAt, locale) : t('never')}</span></p>{canRemove && <button type="button" onClick={remove} className="mt-4 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-rose-300/70 text-xs font-extrabold text-rose-700 dark:border-rose-400/30 dark:text-rose-300"><Trash2 size={15} />{t('removeAgent')}</button>}</article> }

function ConnectorsPage({ t, role }: { t: Translate; role: Role }) {
  const [connectors, setConnectors] = useState<Connector[]>([]); const [agents, setAgents] = useState<Agent[]>([]); const [accounts, setAccounts] = useState<Awaited<ReturnType<typeof api.cloudflareAccounts>>['accounts']>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [name, setName] = useState(''); const [token, setToken] = useState(''); const [agentId, setAgentId] = useState(''); const [cloudflareAccountId, setCloudflareAccountId] = useState(''); const [tunnelId, setTunnelId] = useState(''); const [enabled, setEnabled] = useState(true); const [busy, setBusy] = useState(false)
  async function load() { setLoading(true); setError(''); try { const [connectorResult, agentResult, accountResult] = await Promise.all([api.connectors(), api.agents(), api.cloudflareAccounts()]); setConnectors(connectorResult.connectors); setAgents(agentResult.agents); setAccounts(accountResult.accounts); setAgentId((current) => current || agentResult.agents[0]?.id || '') } catch (caught) { setError(friendlyError(caught, t)) } finally { setLoading(false) } }
  useEffect(() => { void load() }, [])
  async function create(event: React.FormEvent) {
    event.preventDefault(); setError('')
    if (tunnelId && !cloudflareAccountId) { setError(t('connectorAccountRequired')); return }
    setBusy(true)
    try {
      const result = await api.createConnector({ name, token, enabled, agentId, ...(cloudflareAccountId ? { cloudflareAccountId } : {}), ...(tunnelId ? { tunnelId } : {}) })
      setConnectors((current) => [result.connector, ...current]); setName(''); setToken(''); setTunnelId('')
    } catch (caught) { setError(friendlyError(caught, t)) } finally { setBusy(false) }
  }
  async function toggle(connector: Connector) { setError(''); setConnectors((current) => current.map((item) => item.id === connector.id ? { ...item, enabled: !item.enabled } : item)); try { const result = await api.updateConnector(connector.id, { enabled: !connector.enabled }); setConnectors((current) => current.map((item) => item.id === connector.id ? result.connector : item)) } catch (caught) { setConnectors((current) => current.map((item) => item.id === connector.id ? connector : item)); setError(friendlyError(caught, t)) } }
  return <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-6"><PageHeading icon={CloudCog} title={t('connectorsTitle')} description={t('connectorsDescription')} action={<button type="button" className="flex min-h-11 items-center gap-2 rounded-xl border border-stone-200 bg-white px-4 text-xs font-extrabold dark:border-white/10 dark:bg-white/5" onClick={() => void load()}><RefreshCw size={15} />{t('refresh')}</button>} />{role === 'viewer' && <Notice>{t('readOnly')}</Notice>}{error && <Alert>{error}</Alert>}
    {role !== 'viewer' && agents.length === 0 && !loading && <Notice>{t('noConnectorAgents')}</Notice>}
    {role !== 'viewer' && agents.length > 0 && <form onSubmit={create} className={`${panelClass} grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:p-6 xl:grid-cols-12 xl:items-end`}><div className="xl:col-span-3"><Field label={t('connectorName')}><input required maxLength={120} value={name} placeholder={t('connectorNamePlaceholder')} onChange={(event) => setName(event.target.value)} className={inputClass} /></Field></div><div className="xl:col-span-3"><Field label={t('connectorToken')} hint={t('connectorTokenHint')}><input required minLength={20} type="password" autoComplete="new-password" value={token} placeholder="••••••••••••••••••••" onChange={(event) => setToken(event.target.value)} className={inputClass} /></Field></div><div className="xl:col-span-3"><Field label={t('assignedAgent')} hint={t('chooseAgent')}><select required value={agentId} onChange={(event) => setAgentId(event.target.value)} className={inputClass}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></Field></div><div className="xl:col-span-3"><Field label={t('optionalCloudflareAccount')}><select value={cloudflareAccountId} onChange={(event) => { setCloudflareAccountId(event.target.value); if (!event.target.value) setTunnelId('') }} className={inputClass}><option value="">{t('noCloudflareAccount')}</option>{accounts.filter((account) => account.enabled).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></Field></div><div className="sm:col-span-2 xl:col-span-6"><Field label={t('tunnelUuid')} hint={t('tunnelUuidHint')}><input dir="ltr" type="text" inputMode="text" disabled={!cloudflareAccountId} pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" value={tunnelId} onChange={(event) => setTunnelId(event.target.value.trim())} className={`${inputClass} text-left font-mono`} /></Field></div><div className="flex min-h-12 items-center gap-3 xl:col-span-2"><Toggle enabled={enabled} setEnabled={setEnabled} label={t('enabled')} /><span className="text-xs font-extrabold">{t('enabled')}</span></div><button disabled={busy} className={`${primaryButton} sm:col-span-2 xl:col-span-4`}><Plus size={18} />{t('createConnector')}</button></form>}
    <section className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">{connectors.map((connector) => <article key={connector.id} className={`${panelClass} min-w-0 p-5 sm:p-6`}><div className="flex items-start justify-between gap-4"><span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-500/10 text-violet-600 dark:text-violet-300"><CloudCog size={21} /></span>{role === 'viewer' ? <Status active={connector.enabled} label={t(connector.enabled ? 'enabled' : 'disabled')} /> : <Toggle enabled={connector.enabled} setEnabled={() => void toggle(connector)} label={t(connector.enabled ? 'enabled' : 'disabled')} />}</div><h2 className="truncate pt-5 text-base font-black text-ink-900 dark:text-white">{connector.name}</h2><p className="flex items-center gap-2 pt-3 text-[0.68rem] font-bold text-stone-400"><Server size={14} className="text-violet-500" />{agents.find((agent) => agent.id === connector.agentId)?.name || t('unknown')}</p><p className="flex items-center gap-2 pt-2 text-[0.68rem] font-bold text-stone-400"><LockKeyhole size={14} className="text-mint-500" />{t('tokenNeverShown')}</p><div className="grid grid-cols-1 gap-2 pt-4 sm:grid-cols-2"><div className="min-w-0 rounded-xl bg-stone-100/70 p-3 dark:bg-white/[0.035]"><p className="text-[0.6rem] font-bold text-stone-400">{t('connectorAccount')}</p><p className="truncate pt-1 text-xs font-extrabold text-ink-800 dark:text-stone-200">{accounts.find((account) => account.id === connector.cloudflareAccountId)?.name || t('none')}</p></div><div className="min-w-0 rounded-xl bg-stone-100/70 p-3 dark:bg-white/[0.035]"><p className="text-[0.6rem] font-bold text-stone-400">{t('connectorTunnel')}</p><bdi dir="ltr" className="block break-all pt-1 text-left font-mono text-[0.68rem] font-bold text-ink-800 dark:text-stone-200">{connector.tunnelId || t('none')}</bdi></div></div></article>)}{!loading && connectors.length === 0 && <div className="md:col-span-2 2xl:col-span-3"><Empty icon={CloudCog} text={t('noConnectors')} /></div>}</section>{loading && <Loading t={t} />}
  </div>
}

const notificationEvents = [
  ['agent.offline', 'agentOffline'], ['service.unhealthy', 'serviceUnhealthy'], ['deployment.failed', 'deploymentFailed'],
  ['certificate.expiring', 'certificateExpiring'], ['backup.failed', 'backupFailed'], ['backup.succeeded', 'backupSucceeded'],
] as const

function TelegramPage({ t, role }: { t: Translate; role: Role }) {
  const [configured, setConfigured] = useState(false); const [events, setEvents] = useState<string[]>([]); const [initialEvents, setInitialEvents] = useState<string[]>([]); const [botToken, setBotToken] = useState(''); const [groupId, setGroupId] = useState(''); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [success, setSuccess] = useState('')
  async function load() { setLoading(true); setError(''); try { const result = await api.telegram(); setConfigured(result.configured); setEvents(result.selectedEvents); setInitialEvents(result.selectedEvents) } catch (caught) { setError(friendlyError(caught, t)) } finally { setLoading(false) } }
  useEffect(() => { void load() }, [])
  function toggleEvent(value: string) { setEvents((current) => current.includes(value) ? current.filter((event) => event !== value) : [...current, value]); setSuccess('') }
  async function save(event: React.FormEvent) { event.preventDefault(); if ((botToken && !groupId) || (!botToken && groupId) || (!configured && (!botToken || !groupId))) { setError(t('enterReplacement')); return } setBusy(true); setError(''); setSuccess(''); try { const result = await api.saveTelegram(botToken || undefined, groupId || undefined, events); setConfigured(result.configured); setEvents(result.selectedEvents); setInitialEvents(result.selectedEvents); setBotToken(''); setGroupId(''); setSuccess(t('settingsSaved')) } catch (caught) { setError(friendlyError(caught, t)) } finally { setBusy(false) } }
  async function test() { setBusy(true); setError(''); setSuccess(''); try { await api.testTelegram(); setSuccess(t('testSent')) } catch (caught) { setError(friendlyError(caught, t)) } finally { setBusy(false) } }
  const changed = events.slice().sort().join('|') !== initialEvents.slice().sort().join('|')
  return <div className="mx-auto flex w-full max-w-[96rem] flex-col gap-6"><PageHeading icon={Send} title={t('notificationsTitle')} description={t('notificationsDescription')} action={<Status active={configured} label={t(configured ? 'configured' : 'notConfigured')} />} />{role === 'viewer' && <Notice>{t('readOnly')}</Notice>}{error && <Alert>{error}</Alert>}{success && <Success>{success}</Success>}{loading ? <Loading t={t} /> : <form onSubmit={save} className="grid grid-cols-1 gap-5 xl:grid-cols-5"><section className={`${panelClass} p-5 sm:p-6 xl:col-span-3`}><div className="flex items-center gap-3"><span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#229ED9]/10 text-[#229ED9]"><Bot size={23} /></span><div><h2 className="font-black text-ink-900 dark:text-white">Telegram</h2><p className="pt-1 text-xs font-semibold text-stone-400">{t(configured ? 'existingSecretNotice' : 'notConfigured')}</p></div></div>
       {role !== 'viewer' && <div className="grid grid-cols-1 gap-5 pt-6 sm:grid-cols-2"><Field label={t('botToken')}><input type="password" autoComplete="new-password" value={botToken} placeholder={t('botTokenPlaceholder')} onChange={(event) => setBotToken(event.target.value)} className={inputClass} /></Field><Field label={t('groupId')}><input value={groupId} placeholder={t('groupIdPlaceholder')} onChange={(event) => setGroupId(event.target.value)} className={inputClass} /></Field></div>}
    </section><section className={`${panelClass} p-5 sm:p-6 xl:col-span-2`}><h2 className="text-base font-black text-ink-900 dark:text-white">{t('selectEvents')}</h2><div className="flex flex-col gap-2 pt-5">{notificationEvents.map(([value, label]) => <label key={value} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-stone-200/80 px-3.5 py-2 text-xs font-bold transition hover:border-mint-400/40 dark:border-white/[0.07]"><input type="checkbox" disabled={role === 'viewer'} checked={events.includes(value)} onChange={() => toggleEvent(value)} className="h-4 w-4 accent-emerald-500" /><span>{t(label)}</span></label>)}</div></section>{role !== 'viewer' && <div className="flex flex-col gap-3 sm:flex-row sm:justify-end xl:col-span-5"><button type="button" disabled={busy || !configured} onClick={() => void test()} className="flex min-h-12 items-center justify-center gap-2 rounded-xl border border-stone-200 bg-white px-5 text-sm font-extrabold disabled:opacity-50 dark:border-white/10 dark:bg-white/5"><Send size={16} />{t('testConnection')}</button><button disabled={busy || (!configured && (!botToken || !groupId)) || (Boolean(botToken) !== Boolean(groupId)) || (configured && !changed && !botToken)} className={primaryButton}><Save size={16} />{t('saveSettings')}</button></div>}</form>}
  </div>
}

function LogoMark({ large = false }: { large?: boolean }) { return <span className={`relative flex items-center justify-center overflow-hidden rounded-[0.95rem] bg-mint-400 text-ink-950 shadow-glow ${large ? 'h-14 w-14' : 'h-10 w-10'}`}><Network size={large ? 27 : 21} strokeWidth={2.5} /></span> }
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) { return <label className="flex min-w-0 flex-col gap-2"><span className="text-xs font-extrabold text-ink-800 dark:text-stone-100">{label}</span>{children}{hint && <span className="text-[0.66rem] font-medium leading-5 text-stone-400">{hint}</span>}</label> }
function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) { return <button type="button" title={label} aria-label={label} onClick={onClick} className="flex h-10 min-w-10 items-center justify-center gap-1 rounded-xl border border-stone-200 bg-white/80 px-2 text-stone-500 transition hover:border-mint-400 hover:text-ink-800 dark:border-white/10 dark:bg-white/5 dark:text-stone-300">{children}</button> }
function Toggle({ enabled, setEnabled, label }: { enabled: boolean; setEnabled: (enabled: boolean) => void; label: string }) { return <button type="button" role="switch" aria-checked={enabled} aria-label={label} onClick={() => setEnabled(!enabled)} className={`relative h-7 w-12 shrink-0 rounded-full transition ${enabled ? 'bg-mint-400' : 'bg-stone-300 dark:bg-stone-700'}`}><span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${enabled ? 'end-1' : 'start-1'}`} /></button> }
function Status({ active, label }: { active: boolean; label: string }) { return <span className={`inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.65rem] font-extrabold ${active ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'}`}><span className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-emerald-500' : 'bg-amber-500'}`} />{label}</span> }
function Alert({ children }: { children: React.ReactNode }) { return <div role="alert" className="flex items-start gap-2 rounded-xl bg-rose-500/10 px-3.5 py-3 text-xs font-bold leading-5 text-rose-700 dark:text-rose-300"><TriangleAlert className="mt-0.5 shrink-0" size={15} />{children}</div> }
function Notice({ children }: { children: React.ReactNode }) { return <div className="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3.5 py-3 text-xs font-bold leading-5 text-amber-700 dark:text-amber-300"><TriangleAlert className="mt-0.5 shrink-0" size={15} />{children}</div> }
function Success({ children }: { children: React.ReactNode }) { return <div role="status" className="flex items-start gap-2 rounded-xl bg-emerald-500/10 px-3.5 py-3 text-xs font-bold text-emerald-700 dark:text-emerald-300"><CheckCircle2 size={15} />{children}</div> }
function Loading({ t }: { t: Translate }) { return <div role="status" className={`${panelClass} flex items-center justify-center gap-3 p-8 text-sm font-bold text-stone-400`}><RefreshCw className="animate-spin" size={18} />{t('loadingData')}</div> }
function Empty({ icon: Icon, text }: { icon: LucideIcon; text: string }) { return <div className="flex flex-col items-center justify-center p-10 text-center"><Icon className="text-stone-300 dark:text-stone-600" size={31} /><p className="pt-3 text-sm font-bold text-stone-400">{text}</p></div> }
function formatDate(value: string, locale: Locale) { const date = new Date(value); return Number.isNaN(date.getTime()) ? messages[locale].unknown : new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(date) }
function friendlyError(error: unknown, t: Translate) { if (error instanceof ApiError) { if (error.status === 403) return t('forbidden'); if (error.status === 409) return t('conflict'); if (error.status === 400) return t('validationError') } return t('requestFailed') }

export default App
