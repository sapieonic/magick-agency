import { PageHeader } from '@magick-agency/web-ui/components/PageHeader';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';
import { UserAvatar } from '../../components/common/UserAvatar';
import styles from './ProfileSettingsPage.module.css';

const THEMES = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
] as const;

/**
 * Settings → Profile and appearance: who you are signed in as, and the console's theme. Nothing
 * here edits the profile: the name and email come from the sign-in and the server has no route
 * to change them, so they are shown, not offered as fields. The theme is this browser's.
 */
export default function ProfileSettingsPage() {
  const { user } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const name = user?.display_name || null;

  return (
    <div className={styles.page}>
      <PageHeader title="Profile and appearance" />

      <section className={styles.card} aria-labelledby="profile-heading">
        <h2 id="profile-heading" className={styles.cardTitle}>Profile</h2>
        <div className={styles.identity}>
          <UserAvatar user={user} size="lg" />
          <dl className={styles.fields}>
            <div className={styles.field}>
              <dt>Name</dt>
              <dd data-testid="profile-name">{name ?? 'Not set'}</dd>
            </div>
            <div className={styles.field}>
              <dt>Email</dt>
              <dd data-testid="profile-email">{user?.email ?? ''}</dd>
            </div>
          </dl>
        </div>
        <p className={styles.note}>Your name and email come from the account you sign in with.</p>
      </section>

      <section className={styles.card} aria-labelledby="appearance-heading">
        <h2 id="appearance-heading" className={styles.cardTitle}>Appearance</h2>
        <fieldset className={styles.themes}>
          <legend className={styles.legend}>Theme</legend>
          {THEMES.map((option) => (
            <label key={option.id} className={styles.themeOption}>
              <input
                type="radio"
                name="theme"
                value={option.id}
                checked={theme === option.id}
                onChange={() => {
                  if (theme !== option.id) toggleTheme();
                }}
                data-testid={`profile-theme-${option.id}`}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
        <p className={styles.note}>This browser remembers your choice.</p>
      </section>
    </div>
  );
}
