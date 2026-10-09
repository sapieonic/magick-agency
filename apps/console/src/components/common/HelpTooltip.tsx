import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import styles from './HelpTooltip.module.css';

interface HelpTooltipProps {
  text: string;
  size?: number;
  className?: string;
}

export function HelpTooltip({ text, size = 14, className }: HelpTooltipProps) {
  const [visible, setVisible] = useState(false);
  const [tipStyle, setTipStyle] = useState<CSSProperties>({});
  const [placement, setPlacement] = useState<'above' | 'below'>('above');
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);

  const reposition = useCallback(() => {
    const wrapper = wrapperRef.current;
    const tip = tooltipRef.current;
    if (!wrapper || !tip) return;

    const wRect = wrapper.getBoundingClientRect();
    const tRect = tip.getBoundingClientRect();
    const pad = 8;

    // Vertical: prefer above, fall back to below
    const above = wRect.top - tRect.height - 8 >= pad;
    setPlacement(above ? 'above' : 'below');

    const topPos = above
      ? wRect.top - tRect.height - 8
      : wRect.bottom + 8;

    // Horizontal: center on wrapper, but clamp to viewport
    const wrapperCenter = wRect.left + wRect.width / 2;
    let left = wrapperCenter - tRect.width / 2;

    if (left < pad) left = pad;
    if (left + tRect.width > window.innerWidth - pad) {
      left = window.innerWidth - pad - tRect.width;
    }

    // Arrow position: always point at the center of the wrapper
    const arrowLeft = wrapperCenter - left;

    setTipStyle({
      position: 'fixed',
      top: `${topPos}px`,
      left: `${left}px`,
      transform: 'none',
      ['--arrow-left' as string]: `${arrowLeft}px`,
    });
  }, []);

  const show = useCallback(() => {
    setVisible(true);
    // Reposition after render so the tooltip has layout dimensions
    requestAnimationFrame(reposition);
  }, [reposition]);

  const hide = useCallback(() => {
    setVisible(false);
  }, []);

  const toggle = useCallback(() => {
    if (visible) hide(); else show();
  }, [visible, show, hide]);

  // Dismiss on click outside
  useEffect(() => {
    if (!visible) return;
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setVisible(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [visible]);

  const tooltipClasses = [
    styles.tooltip,
    visible ? styles.tooltipVisible : '',
    placement === 'above' ? styles.tooltipAbove : styles.tooltipBelow,
  ].filter(Boolean).join(' ');

  const arrowClasses = [
    styles.arrow,
    placement === 'above' ? styles.arrowAbove : styles.arrowBelow,
  ].join(' ');

  return (
    <span
      ref={wrapperRef}
      className={`${styles.wrapper}${className ? ` ${className}` : ''}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onClick={toggle}
    >
      <svg
        className={styles.icon}
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
        <text
          x="8"
          y="12"
          textAnchor="middle"
          fill="currentColor"
          fontSize="10"
          fontWeight="600"
          fontFamily="inherit"
        >
          i
        </text>
      </svg>
      <span ref={tooltipRef} className={tooltipClasses} style={tipStyle} role="tooltip">
        <span className={arrowClasses} />
        {text}
      </span>
    </span>
  );
}
