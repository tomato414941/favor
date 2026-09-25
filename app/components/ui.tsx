import { useEffect, useId, useRef, useState } from 'react';
import { useRevalidator } from 'react-router';

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
  onConfirm: () => Promise<void> | void;
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

export function DemoBanner() {
  return (
    <div className="demo-banner">
      <span className="demo-mark">試用版</span>実際の支払いは発生しません
    </div>
  );
}
export function Footer() {
  return (
    <footer className="footer shell">
      <span className="footer-brand">Favor</span>
    </footer>
  );
}

/** Re-reads the page's data on a timer while the tab is visible, so states settled elsewhere appear. */
export function useAutoRevalidate(intervalMs: number, enabled = true) {
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => {
      if (!document.hidden && revalidator.state === 'idle') void revalidator.revalidate();
    };
    const timer = window.setInterval(refresh, intervalMs);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [intervalMs, enabled, revalidator]);
}

/** A key that stays the same while the same change is retried, so a lost answer is not repeated. */
export function useOperationKey() {
  const current = useRef<{ payload: string; key: string } | null>(null);
  return {
    keyFor(payload: unknown): string {
      const serialized = JSON.stringify(payload);
      if (!current.current || current.current.payload !== serialized)
        current.current = { payload: serialized, key: crypto.randomUUID() };
      return current.current.key;
    },
    done() {
      current.current = null;
    },
  };
}

export interface ActionFailure {
  error?: { code: string; message: string };
}
export const NETWORK_MESSAGE =
  '接続を確認できませんでした。内容はそのままで、もう一度お試しください。';
