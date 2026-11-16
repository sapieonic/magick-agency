import styles from './NavSectionLabel.module.css';

export interface NavSectionLabelProps {
  /** Referenced by the group's `aria-labelledby`, so the group is named by what it shows. */
  id: string;
  /**
   * The element: a heading where the page outline should list the group (the Settings hub),
   * a span inside a bar (the campaign tabs), a div where the container's role forbids headings
   * (the search's listbox). Never anything interactive.
   */
  as?: 'h2' | 'h3' | 'span' | 'div';
  /** The host's own padding and margins only; the look is this component's. */
  className?: string;
  /** `presentation` inside a listbox, whose children may only be options and groups. */
  role?: 'presentation';
  'data-testid'?: string;
  children: string;
}

/**
 * The label of a group of navigation items (decision NV1): the Settings hub's groups, the
 * campaign bar's Monitor, Data and Set up, and the search's result groups all render their
 * group label with this, so a label never looks, or behaves, like the items under it. It is
 * not focusable and takes no pointer; see `NavSectionLabel.module.css` for the look.
 */
export function NavSectionLabel({ id, as: Tag = 'span', className, role, children, ...rest }: NavSectionLabelProps) {
  return (
    <Tag
      id={id}
      className={className ? `${styles.label} ${className}` : styles.label}
      role={role}
      data-nav-section-label=""
      data-testid={rest['data-testid']}
    >
      <span className={styles.text}>{children}</span>
    </Tag>
  );
}
