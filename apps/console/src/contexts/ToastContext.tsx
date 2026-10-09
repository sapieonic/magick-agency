import { createContext, useContext, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { Toast } from '../components/common/Toast';
import type { ToastType, ToastData } from '../components/common/Toast';
import { getErrorMessage } from '../utils/errors';

const MAX_TOASTS = 5;
const DEFAULT_DURATION = 4000;
// Errors get a longer dwell so users can read and copy the request id.
const ERROR_DURATION = 8000;

interface ToastContextValue {
  showToast: (message: string, type?: ToastType, duration?: number) => void;
  /**
   * Show an error toast from a thrown value. Extracts a user-facing message
   * (and, for masked errors, the embedded request id, which `Toast` renders as
   * a copyable chip). Prefer this over `showToast(err.message, 'error')`.
   */
  showErrorToast: (err: unknown, fallback?: string) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const counterRef = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, type: ToastType = 'info', duration: number = DEFAULT_DURATION) => {
      counterRef.current += 1;
      const id = `toast-${counterRef.current}-${Date.now()}`;
      const newToast: ToastData = { id, message, type, duration };

      setToasts(prev => {
        const next = [...prev, newToast];
        // Enforce max visible toasts by removing oldest
        if (next.length > MAX_TOASTS) {
          return next.slice(next.length - MAX_TOASTS);
        }
        return next;
      });
    },
    [],
  );

  const showErrorToast = useCallback(
    (err: unknown, fallback?: string) => {
      showToast(getErrorMessage(err, fallback), 'error', ERROR_DURATION);
    },
    [showToast],
  );

  return (
    <ToastContext.Provider value={{ showToast, showErrorToast }}>
      {children}
      {createPortal(
        <div className="toast-container">
          {toasts.map(toast => (
            <Toast key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
