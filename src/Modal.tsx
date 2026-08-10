import { X } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'

type ModalProps = {
  open: boolean
  title: string
  description: string
  closeLabel: string
  busy?: boolean
  maxWidthClass?: string
  onClose: () => void
  children: ReactNode
}

export function Modal({ open, title, description, closeLabel, busy = false, maxWidthClass = 'max-w-3xl', onClose, children }: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (open && !dialog.open) {
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  function requestClose() {
    if (!busy) onClose()
  }

  return <dialog
    ref={dialogRef}
    aria-labelledby={titleId}
    aria-describedby={descriptionId}
    aria-busy={busy}
    onCancel={(event) => {
      event.preventDefault()
      requestClose()
    }}
    className={`m-auto h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] ${maxWidthClass} overflow-hidden rounded-[1.4rem] border border-stone-200/80 bg-sand-50 p-0 text-ink-900 shadow-2xl backdrop:bg-ink-950/70 backdrop:backdrop-blur-sm dark:border-white/[0.09] dark:bg-ink-900 dark:text-stone-100 sm:h-auto sm:max-h-[calc(100dvh-3rem)] sm:w-[calc(100%-3rem)]`}
  >
    <div className="flex h-full min-h-0 flex-col sm:max-h-[calc(100dvh-3rem)]">
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-stone-200/80 px-5 py-4 dark:border-white/[0.07] sm:px-6">
        <div className="min-w-0">
          <h2 id={titleId} className="text-lg font-black text-ink-900 dark:text-white">{title}</h2>
          <p id={descriptionId} className="pt-1 text-xs font-medium leading-5 text-stone-500 dark:text-stone-400">{description}</p>
        </div>
        <button type="button" disabled={busy} onClick={requestClose} aria-label={closeLabel} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-stone-500 transition hover:bg-stone-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-mint-400/20 disabled:cursor-not-allowed disabled:opacity-40 dark:text-stone-300 dark:hover:bg-white/5">
          <X size={19} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
    </div>
  </dialog>
}
