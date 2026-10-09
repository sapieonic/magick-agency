export interface UserRecord {
  id: string;
  firebase_uid: string;
  email: string;
  phone_number: string;
  display_name: string | null;
  avatar_url: string | null;
  status: 'active' | 'inactive' | 'deleted';
  /**
   * An identity was bound to this row without proving its email address —
   * today only `POST /invites/:token/claim` with an unverified Firebase token.
   *
   * The row is a perfectly ordinary signed-in account; what it must NOT be is
   * REUSED BY ADDRESS, because `users.email` is the lookup key for three paths
   * that hand out authority (`POST /users/invite`, super-admin tenant-create
   * and add-user) and the address here is whatever the inviter typed. Read it
   * through `userRepository.findByProvenEmail`, never by filtering afterwards.
   */
  email_unverified: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CreateUserInput {
  firebase_uid: string;
  email: string;
  phone_number?: string;
  display_name?: string;
  avatar_url?: string;
}
