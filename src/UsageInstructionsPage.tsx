import { BellRing, Cloud, Copy, DatabaseBackup, FileText, GitBranch, Globe2, Network, Server, ShieldCheck } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { Locale, Page } from './App'
import { copyText } from './clipboard'

const content = {
  en: {
    title: 'Usage instructions', intro: 'Follow the live GatewayControl workflow from Agent enrollment to a monitored public domain.',
    warning: 'Inside containers, localhost means that container. Publishing host port 5800 normalizes to http://host.docker.internal:5800.',
    agent: ['1. Enroll an Agent', 'Enroll the destination host first. Generated enrollment already maps host.docker.internal to the Docker host gateway.', 'Open Agents'],
    deployment: ['2. Deploy a reviewed revision', 'Choose a public GitHub repository, exact 40-character commit, and relative Compose path. Review services, images, warnings, and target, create the immutable revision, then approve deployment separately.', 'Open Deployments'],
    cloudflare: ['3. Connect Cloudflare', 'Use a scoped API token: Account / Cloudflare Tunnel / Edit, Zone / Zone / Read, and Zone / DNS / Edit. Keep Create managed tunnel enabled and select an enrolled Agent.', 'Open Cloudflare'],
    local: ['4. Publish host port 5800', 'In Guided Publish Domain, choose Host port and enter 5800 or localhost:5800. GatewayControl sends only the normalized URL to the Agent.', '5800'],
    tunnel: ['5. Tunnel path', 'Browser HTTPS -> Cloudflare edge certificate -> Tunnel -> same-Agent connector -> Traefik HTTP -> backend. No manual tunnel token is needed.', 'Open Domain Access'],
    public: ['6. Public IP path', 'Use DNS-only A/AAAA records. Forward TCP 443 through firewall/NAT to Traefik; port 80 is used for HTTP redirect. Cloudflare proxy mode is rejected for this certificate mode.', 'Open Domain Access'],
    certificates: ['7. Certificates', 'Tunnel certificates are managed at the Cloudflare browser edge. Public IP uses Traefik Let’s Encrypt TLS-ALPN on 443 and the persistent ACME volume; observed expiry appears on Domain Access cards.', 'Open Domain Access'],
    logs: ['8. Logs', 'Use bounded service-log requests for discovered runtime services. Never paste secrets into route names or targets.', 'Open Logs'],
    notifications: ['9. Notifications', 'Enable deployment.failed, deployment.succeeded, and certificate.expiring notifications, then scope them per Agent and service.', 'Open Notifications'],
    backups: ['10. Backups', 'Create encrypted system backups and keep the passphrase separately. Verify NAS readiness and recovery before relying on it.', 'Open Backups'],
  },
  ar: {
    title: 'دليل الاستخدام', intro: 'اتبع مسار GatewayControl الفعلي من تسجيل العميل حتى نشر نطاق عام ومراقبته.',
    warning: 'داخل الحاويات يشير localhost إلى الحاوية نفسها. تُحوّل البوابة 5800 إلى http://host.docker.internal:5800 عند النشر.',
    agent: ['1. تسجيل العميل', 'سجّل الجهاز الوجهة أولاً. يضيف أمر التسجيل المولّد ربط host.docker.internal ببوابة مضيف Docker تلقائياً.', 'فتح العملاء'],
    deployment: ['2. نشر مراجعة مدققة', 'اختر مستودع GitHub عاماً وCommit ثابتاً من 40 محرفاً ومسار Compose نسبياً. راجع الخدمات والصور والتحذيرات والوجهة، ثم أنشئ المراجعة غير القابلة للتعديل ووافق على نشرها بشكل منفصل.', 'فتح عمليات النشر'],
    cloudflare: ['3. ربط كلاودفلير', 'استخدم توكن محدوداً بصلاحيات تعديل Cloudflare Tunnel وقراءة Zone وتعديل DNS. أبقِ إنشاء النفق المُدار مفعلاً واختر عميلاً مسجلاً.', 'فتح كلاودفلير'],
    local: ['4. نشر منفذ المضيف 5800', 'في معالج نشر النطاق اختر منفذ المضيف وأدخل 5800 أو localhost:5800. يرسل GatewayControl الرابط الموحّد فقط إلى العميل.', '5800'],
    tunnel: ['5. مسار النفق', 'HTTPS من المتصفح ثم شهادة حافة كلاودفلير ثم النفق والموصل على العميل نفسه ثم Traefik عبر HTTP ثم الخدمة. لا يلزم توكن نفق يدوي.', 'فتح إتاحة النطاق'],
    public: ['6. مسار العنوان العام', 'استخدم سجلات A/AAAA بوضع DNS فقط. وجّه TCP 443 عبر الجدار وNAT إلى Traefik؛ ويستخدم 80 لإعادة التوجيه. يُرفض بروكسي كلاودفلير لهذا النمط.', 'فتح إتاحة النطاق'],
    certificates: ['7. الشهادات', 'تدير كلاودفلير شهادة حافة المتصفح للنفق. يستخدم العنوان العام Traefik وLet’s Encrypt TLS-ALPN على 443 مع ACME دائم، وتظهر صلاحية الشهادة في بطاقات الإتاحة.', 'فتح إتاحة النطاق'],
    logs: ['8. السجلات', 'استخدم طلبات السجل المحدودة للخدمات المكتشفة، ولا تضع الأسرار في أسماء المسارات أو الوجهات.', 'فتح السجلات'],
    notifications: ['9. الإشعارات', 'فعّل إشعارات نجاح النشر وفشله واقتراب انتهاء الشهادة، ثم اضبط النطاق لكل عميل وخدمة.', 'فتح الإشعارات'],
    backups: ['10. النسخ الاحتياطي', 'أنشئ نسخ نظام مشفرة واحفظ عبارة المرور منفصلة. تحقق من جاهزية NAS والاستعادة قبل الاعتماد عليها.', 'فتح النسخ'],
  },
} as const

export function UsageInstructionsPage({ locale, navigate }: { locale: Locale; navigate: (page: Page) => void }) {
  const t = content[locale]
  const [copied, setCopied] = useState('')
  const cards: Array<[keyof typeof t, ReactNode, Page | null]> = [
    ['agent', <Server size={21} />, 'agents'], ['deployment', <GitBranch size={21} />, 'deployments'], ['cloudflare', <Cloud size={21} />, 'cloudflareManagement'],
    ['local', <Network size={21} />, null], ['tunnel', <Globe2 size={21} />, 'cloudflareManagement'],
    ['public', <Network size={21} />, 'cloudflareManagement'], ['certificates', <ShieldCheck size={21} />, 'cloudflareManagement'],
    ['logs', <FileText size={21} />, 'logs'], ['notifications', <BellRing size={21} />, 'notifications'], ['backups', <DatabaseBackup size={21} />, 'backups'],
  ]
  return <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-6">
    <header className="surface-glow rounded-[1.75rem] bg-ink-900 p-6 text-white shadow-xl sm:p-9">
      <p className="text-xs font-black uppercase tracking-[0.14em] text-mint-300">GatewayControl</p>
      <h1 className="pt-3 text-3xl font-black tracking-[-0.04em] sm:text-4xl">{t.title}</h1>
      <p className="max-w-3xl pt-3 text-sm font-medium leading-7 text-stone-300 sm:text-base">{t.intro}</p>
    </header>
    <div className="rounded-2xl border border-orange-300/60 bg-orange-50 p-4 text-sm font-bold leading-6 text-orange-950 dark:border-orange-400/20 dark:bg-orange-400/10 dark:text-orange-100">{t.warning}</div>
    <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {cards.map(([key, icon, page]) => { const item = t[key] as readonly [string, string, string]; const example = key === 'local' ? 'http://host.docker.internal:5800' : key === 'cloudflare' ? 'Account / Cloudflare Tunnel / Edit' : null; return <article key={key} className="flex min-w-0 flex-col rounded-[1.4rem] border border-stone-200/80 bg-sand-50 p-5 shadow-panel dark:border-white/[0.07] dark:bg-ink-900/80 sm:p-6">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-mint-400/10 text-mint-600 dark:text-mint-300">{icon}</div>
        <h2 className="pt-5 text-base font-black text-ink-900 dark:text-white">{item[0]}</h2>
        <p className="flex-1 pt-3 text-sm font-medium leading-7 text-stone-600 dark:text-stone-300">{item[1]}</p>
        {example && <button type="button" onClick={() => void copyText(example).then(() => setCopied(key))} className="mt-4 flex min-h-11 min-w-0 items-center gap-2 rounded-xl bg-ink-900 px-3 text-start font-mono text-xs text-white dark:bg-white/5"><Copy size={14} className="shrink-0" /><bdi dir="ltr" className="truncate">{copied === key ? (locale === 'ar' ? 'تم النسخ' : 'Copied') : example}</bdi></button>}
        {page && <button type="button" onClick={() => navigate(page)} className="mt-4 min-h-11 rounded-xl border border-stone-200 px-4 text-sm font-extrabold text-mint-700 dark:border-white/10 dark:text-mint-300">{item[2]}</button>}
      </article> })}
    </section>
  </div>
}
