import { useId, useRef, useState, type AnchorHTMLAttributes, type MouseEvent } from 'react';

export function ConfirmAction({
  label,
  question,
  description,
  confirmLabel = label,
  busy,
  onConfirm,
}: {
  label: string;
  question: string;
  description?: string;
  confirmLabel?: string;
  busy: boolean;
  onConfirm: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const locked = useRef(false);
  const questionId = useId();
  function close() {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  }
  async function confirm() {
    if (busy || locked.current) return;
    locked.current = true;
    try {
      await onConfirm();
      close();
    } finally {
      locked.current = false;
    }
  }
  return open ? (
    <div
      className="inline-confirmation"
      role="group"
      aria-labelledby={questionId}
      aria-busy={busy}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy && !locked.current) {
          event.preventDefault();
          close();
        }
      }}
    >
      <p id={questionId}>{question}</p>
      {description && <p className="hint">{description}</p>}
      <div className="action-buttons">
        <button type="button" className="quiet-button" autoFocus disabled={busy} onClick={close}>
          戻る
        </button>
        <button
          type="button"
          className="quiet-button"
          disabled={busy}
          onClick={() => void confirm()}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  ) : (
    <button
      ref={trigger}
      type="button"
      className="text-button"
      disabled={busy}
      onClick={() => setOpen(true)}
    >
      {label}
    </button>
  );
}

export function Arrow({ down = false }: { down?: boolean }) {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={down ? 'arrow-down' : ''}
    >
      <path d="M4 12h15m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** Moves to another page of the application without reloading. */
export function navigate(path: string) {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function Link({
  href,
  onClick,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={handle} {...rest} />;
}
