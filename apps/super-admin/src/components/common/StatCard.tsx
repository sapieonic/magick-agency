import type { CSSProperties, ReactNode } from 'react';
import { useCountUp } from '../../hooks/useCountUp';
import { LiveDot } from './LiveDot';
import styles from './StatCard.module.css';

interface StatCardProps {
  title: string;
  value: string | number;
  icon?: ReactNode;
  color?: string;
  subtitle?: string;
  /** Optional 7-point sparkline data for trend display */
  trend?: number[];
  /** When true, shows a live pulse indicator next to the value */
  live?: boolean;
}

function Sparkline({ data }: { data: number[] }) {
  if (data.length < 2) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const w = 64;
  const h = 20;
  const pad = 1;

  const points = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x},${y}`;
  });

  const trending = data[data.length - 1]! >= data[0]!;

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className={styles.sparkline}
      aria-hidden="true"
    >
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke={trending ? 'var(--success)' : 'var(--danger)'}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.8"
      />
      <circle
        cx={points[points.length - 1]?.split(',')[0]}
        cy={points[points.length - 1]?.split(',')[1]}
        r="2"
        fill={trending ? 'var(--success)' : 'var(--danger)'}
      />
    </svg>
  );
}

export function StatCard({ title, value, icon, color, subtitle, trend, live }: StatCardProps) {
  const resolvedColor = color ?? 'var(--accent)';
  const animatedValue = useCountUp(value);

  const iconStyle: CSSProperties = {
    background: resolvedColor.startsWith('var(')
      ? 'var(--accent-subtle)'
      : `color-mix(in srgb, ${resolvedColor} 14%, transparent)`,
    color: resolvedColor,
  };

  return (
    <div className={styles.card} aria-label={`${title}: ${String(value)}`}>
      <div className={styles.topRow}>
        {icon && (
          <div className={styles.iconCircle} style={iconStyle} aria-hidden="true">
            {icon}
          </div>
        )}
        {trend && <Sparkline data={trend} />}
      </div>
      <div className={styles.valueRow} aria-live={live ? 'polite' : undefined}>
        <div className={styles.value}>{animatedValue}</div>
        {/* The card's own title says what is live ("Happening now"); the row is
            already an `aria-live` region, so the dot is decoration on top. */}
        {live && <LiveDot live />}
      </div>
      <div className={styles.title}>{title}</div>
      {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
    </div>
  );
}
