export function dockerEnvironmentArgs(defaultPassword) {
  // This acceptance test verifies the mounted SQLite volume without external bootstrap databases.
  return [
    '-e', 'AUTH_MODE=session',
    '-e', 'PLATFORM_DB_BACKEND=sqlite',
    '-e', 'PLATFORM_DB_PATH=/app/data/platform.db',
    '-e', 'PLATFORM_BOOTSTRAP_RESOURCES=false',
    '-e', 'DORIS_BOOTSTRAP_ENABLED=false',
    '-e', 'DEMO_DATA_ENABLED=false',
    '-e', 'API_KEY=docker-acceptance-unused',
    '-e', 'API_BASE_URL=http://127.0.0.1:9/v1',
    '-e', `DEFAULT_USER_PASSWORD=${defaultPassword}`,
    '-e', 'USER_MEMORY_MAINTENANCE_INTERVAL_MS=0',
  ];
}
