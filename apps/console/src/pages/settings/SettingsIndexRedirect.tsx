import { Navigate } from 'react-router-dom';
import { useSettingsNav } from './useSettingsNav';

/**
 * `/settings` opens the first entry the reader may open. That is Profile and appearance, which
 * has no gate, so there is nothing to wait for (and with no tenant the flags never resolve).
 */
export default function SettingsIndexRedirect() {
  const { groups } = useSettingsNav();
  return <Navigate to={groups[0]?.entries[0]?.path ?? '/settings/profile'} replace />;
}
