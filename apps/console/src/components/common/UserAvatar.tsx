import { useState } from 'react';
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
 *
 * The picture is a sign-in provider's URL, which can expire or refuse us, so a picture that does
 * not load shows the initials instead of a broken image. The failure is kept against that URL, so
 * a new one is tried again. No referrer goes with it: the provider has no need of the console's URL
 * (and Google's photo host refuses some requests that carry one).
 */
export function UserAvatar({ user, size }: { user: AvatarUser | null | undefined; size: 'sm' | 'md' | 'lg' }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = user?.avatar_url ?? null;
  const showPicture = url !== null && url !== '' && url !== failedUrl;
  return (
    <span className={`${styles.avatar} ${styles[size]}`} aria-hidden="true">
      {showPicture
        ? <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailedUrl(url)} />
        : initialsFor(user?.display_name, user?.email)}
    </span>
  );
}
