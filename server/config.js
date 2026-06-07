// Central config derived from environment, with dev-friendly defaults.
export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 3000,
    roomTtlMs: (Number(env.ROOM_TTL_HOURS) || 24) * 60 * 60 * 1000,
    databaseUrl: env.DATABASE_URL || 'file:./data/scrum.db',
    databaseAuthToken: env.DATABASE_AUTH_TOKEN || undefined,
  };
}
