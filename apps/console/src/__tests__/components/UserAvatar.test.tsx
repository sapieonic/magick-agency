import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { UserAvatar, type AvatarUser } from '../../components/common/UserAvatar';

/**
 * The avatar shows the picture when it loads and the initials otherwise: a provider URL that
 * has expired or refuses us must not leave a broken image in the top bar.
 */

const user = (avatar_url: string | null): AvatarUser => ({ display_name: 'Asha Rao', email: 'asha@example.com', avatar_url });

afterEach(() => cleanup());

describe('UserAvatar', () => {
  it('shows the picture, sent with no referrer', () => {
    const { container } = render(<UserAvatar user={user('https://example.com/a.png')} size="sm" />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('https://example.com/a.png');
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('shows the initials when there is no picture', () => {
    const { container } = render(<UserAvatar user={user(null)} size="sm" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('AR');
  });

  it('falls back to the initials when the picture fails to load, and tries a new picture again', () => {
    const { container, rerender } = render(<UserAvatar user={user('https://example.com/old.png')} size="md" />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('AR');

    rerender(<UserAvatar user={user('https://example.com/new.png')} size="md" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/new.png');
  });
});
