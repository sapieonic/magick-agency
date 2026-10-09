import { splitRequestId } from '../../utils/errors';
import { RequestId } from './RequestId';
import styles from './ErrorText.module.css';

interface ErrorTextProps {
  /** Error string, possibly carrying an embedded request id (masked errors). */
  message: string;
}

/**
 * Drop-in replacement for rendering a raw error string inside an existing error
 * container (`<div className={styles.error}>{error}</div>` → `<ErrorText
 * message={error} />`). Splits out an embedded request id (masked errors) and
 * renders it as a copyable chip on its own line; plain messages render as-is.
 *
 * Returns a fragment so it inherits the surrounding container's styling. The
 * chip is a `<span>` so it stays valid inside both `<div>` and `<p>` parents.
 */
export function ErrorText({ message }: ErrorTextProps) {
  const { message: text, requestId } = splitRequestId(message);
  if (!requestId) return <>{text}</>;
  return (
    <>
      {text}
      <span className={styles.chipRow}>
        <RequestId requestId={requestId} tone="error" />
      </span>
    </>
  );
}
