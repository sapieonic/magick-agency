import { initialsFor } from '../../utils/initials';
import styles from './UserAvatar.module.css';

export interface AvatarUser {
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
}

/**
 * The signed-in person's avatar: their picture, else their initials (`initialsFor`). One look in
 * three sizes: the top bar's profile menu (`sm`), the station header (`md`), Settings → Profile
 * (`lg`). Decoration only (`aria-hidden`): the name is always beside it.
 */
export function UserAvatar({ user, size }: { user: AvatarUser | null | undefined; size: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`${styles.avatar} ${styles[size]}`} aria-hidden="true">
      {user?.avatar_url ? <img src={user.avatar_url} alt="" /> : initialsFor(user?.display_name, user?.email)}
    </span>
  );
}
