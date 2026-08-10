import { CircleHelp, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

export function HelpPopover({ label, title, closeLabel, children }: { label: string; title: string; closeLabel: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const contentId = useId()

  useEffect(() => {
    if (!open) return

    function closeOnOutsideClick(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return <div ref={containerRef} className="relative shrink-0">
    <button
      type="button"
      aria-label={label}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-controls={open ? contentId : undefined}
      onClick={() => setOpen((current) => !current)}
      className="flex h-11 w-11 items-center justify-center rounded-xl border border-stone-200 bg-white text-stone-500 transition hover:border-mint-400 hover:text-ink-900 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-mint-400/20 dark:border-white/10 dark:bg-white/5 dark:text-stone-300 dark:hover:text-white"
    >
      <CircleHelp size={19} />
    </button>
    {open && <div id={contentId}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      className="absolute end-0 top-[calc(100%+0.5rem)] z-20 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-stone-200 bg-white p-4 text-start shadow-2xl dark:border-white/10 dark:bg-ink-800"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 id={titleId} className="pt-1 text-sm font-black text-ink-900 dark:text-white">{title}</h3>
        <button type="button" aria-label={closeLabel} onClick={() => setOpen(false)} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-stone-500 hover:bg-stone-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-mint-400/20 dark:hover:bg-white/5">
          <X size={16} />
        </button>
      </div>
      <div className="flex flex-col gap-3 pt-3 text-xs font-medium leading-5 text-stone-600 dark:text-stone-300">{children}</div>
    </div>}
  </div>
}
