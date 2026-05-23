import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

interface Toast {
  id: number;
  message: string;
}

interface ToastApi {
  show: (message: string) => void;
}

const TOAST_DURATION_MS = 2000;

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = useCallback((message: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message }]);
  }, []);

  // Each toast auto-dismisses after TOAST_DURATION_MS. We mount a small
  // helper for each toast so multiple in-flight toasts each get their own
  // timer.
  return (
    <ToastContext.Provider value={useMemo(() => ({ show }), [show])}>
      {children}
      <div className="toast-host" aria-live="polite">
        {toasts.map((t) => (
          <ToastItem
            key={t.id}
            id={t.id}
            message={t.message}
            onExpire={(id) => setToasts((prev) => prev.filter((x) => x.id !== id))}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({
  id,
  message,
  onExpire,
}: {
  id: number;
  message: string;
  onExpire: (id: number) => void;
}) {
  useEffect(() => {
    const timer = setTimeout(() => onExpire(id), TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [id, onExpire]);
  return (
    // biome-ignore lint/a11y/useSemanticElements: role=status keeps the toast queryable via testing-library's getByRole('status')
    <div className="toast" role="status">
      {message}
    </div>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Fail soft: in tests that forget to wrap, return a no-op so rendering
    // doesn't crash.
    return { show: () => undefined };
  }
  return ctx;
}
