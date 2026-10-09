import { useEffect, useRef, useState, useCallback } from 'react';
import { splitRequestId } from '../../utils/errors';
import { RequestId } from './RequestId';
import styles from './Toast.module.css';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastData {
  id: string;
  message: string;
  type: ToastType;
  duration: number;
}

interface ToastProps {
  toast: ToastData;
  onDismiss: (id: string) => void;
}

function ToastIcon({ type }: { type: ToastType }) {
  switch (type) {
    case 'success':
      return (
        <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="10" cy="10" r="9" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 10.5l2.5 2.5L14 7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'error':
      return (
        <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="10" cy="10" r="9" stroke="currentColor" strokeWidth="1.5" />
          <path d="M7 7l6 6M13 7l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case 'warning':
      return (
        <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M10 2l8.66 15H1.34L10 2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M10 8v3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="10" cy="14" r="0.75" fill="currentColor" />
        </svg>
      );
    case 'info':
      return (
        <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="10" cy="10" r="9" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10 9v4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="10" cy="6.5" r="0.75" fill="currentColor" />
        </svg>
      );
  }
}

export function Toast({ toast, onDismiss }: ToastProps) {
  const [exiting, setExiting] = useState(false);
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(toast.duration);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef(Date.now());
  const progressRef = useRef<HTMLDivElement>(null);

  const dismiss = useCallback(() => {
    setExiting(true);
    setTimeout(() => onDismiss(toast.id), 200);
  }, [onDismiss, toast.id]);

  // Manage the auto-dismiss timer, supporting pause on hover
  useEffect(() => {
    if (paused) {
      // Clear existing timer, snapshot remaining time
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const elapsed = Date.now() - startRef.current;
      remainingRef.current = Math.max(remainingRef.current - elapsed, 0);
      return;
    }

    // Start / resume timer
    startRef.current = Date.now();
    timerRef.current = setTimeout(dismiss, remainingRef.current);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [paused, dismiss]);

  // Manage the progress bar animation, supporting pause on hover
  useEffect(() => {
    const bar = progressRef.current;
    if (!bar) return;

    if (paused) {
      // Freeze the progress bar at its current width
      const computed = window.getComputedStyle(bar);
      const currentWidth = computed.width;
      const parentWidth = bar.parentElement?.offsetWidth ?? 1;
      const fraction = parseFloat(currentWidth) / parentWidth;
      bar.style.transition = 'none';
      bar.style.width = `${fraction * 100}%`;
      return;
    }

    // Animate from current width to 0 over remaining time
    const remaining = remainingRef.current;
    // Force a reflow so the browser picks up the current width before transitioning
    void bar.offsetWidth;
    bar.style.transition = `width ${remaining}ms linear`;
    bar.style.width = '0%';
  }, [paused]);

  // Set initial progress bar width on mount
  useEffect(() => {
    const bar = progressRef.current;
    if (!bar) return;
    bar.style.width = '100%';
    // Force reflow, then kick off the initial animation
    void bar.offsetWidth;
    bar.style.transition = `width ${toast.duration}ms linear`;
    bar.style.width = '0%';
  }, [toast.duration]);

  const className = [
    styles.toast,
    styles[toast.type],
    exiting ? styles.exiting : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Masked errors carry an embedded request id; surface it as a copyable chip
  // instead of inline text so users can quote it to support.
  const { message: text, requestId } = splitRequestId(toast.message);

  return (
    <div
      className={className}
      role="alert"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <span className={styles.icon}>
        <ToastIcon type={toast.type} />
      </span>
      <div className={styles.content}>
        <span className={styles.message}>{text}</span>
        {requestId && <RequestId requestId={requestId} tone="error" />}
      </div>
      <button
        type="button"
        className={styles.closeButton}
        onClick={dismiss}
        aria-label="Dismiss notification"
      >
        <svg viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <div className={styles.progressTrack}>
        <div ref={progressRef} className={styles.progressBar} />
      </div>
    </div>
  );
}
