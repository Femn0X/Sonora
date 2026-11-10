/**
 * The built-in development user. Until real authentication exists, every request that doesn't send an
 * `x-user-id` header acts as this user.
 *
 * It is identified by USERNAME, never by a fixed id: databases created by different people/scripts give the
 * same account different ids, and an account with this username must be reused rather than duplicated
 * (usernames and emails are unique).
 */
export const DEMO_USER = {
  username: "demo",
  email: "demo@sonora.local",
  displayName: "Demo User",
} as const;
