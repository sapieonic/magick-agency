import { Link } from 'react-router-dom';
import { Settings } from 'lucide-react';
import { useNavGate } from '../../hooks/useNavGate';
import { passesGate, settingsEntry } from '../../utils/consoleNav';
import styles from './SettingsEntryLink.module.css';

/**
 * A work page's way to the setting that shapes it (Missed calls and Inbound summary to Inbound
 * routing, Soft-phone calls to Soft phone): "<entry> settings", offered only to a reader who
 * passes that Settings entry's gate (`SETTINGS_ENTRIES`), so nobody is shown a link that would
 * refuse them.
 */
export function SettingsEntryLink({ entry: id }: { entry: string }) {
  const gate = useNavGate();
  const entry = settingsEntry(id);
  if (!passesGate(entry.gate, gate)) return null;
  return (
    <Link to={entry.path} className={styles.link} data-testid={`settings-entry-link-${entry.id}`}>
      <Settings size={14} aria-hidden="true" />
      {`${entry.label} settings`}
    </Link>
  );
}
