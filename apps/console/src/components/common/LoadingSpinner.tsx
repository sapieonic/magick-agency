import styles from './LoadingSpinner.module.css';

interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  /** Hide the spinner itself when surrounding copy already exposes the status. */
  decorative?: boolean;
}

export function LoadingSpinner({ size = 'md', decorative = false }: LoadingSpinnerProps) {
  return (
    <div
      className={`${styles.spinner} ${styles[size]}`}
      role={decorative ? undefined : 'status'}
      aria-label={decorative ? undefined : 'Loading'}
      aria-hidden={decorative || undefined}
    />
  );
}
