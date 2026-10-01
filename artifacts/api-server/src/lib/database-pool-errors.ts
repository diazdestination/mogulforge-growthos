type PoolErrorSource = {
  on(event: "error", listener: () => void): unknown;
};

type PoolErrorLogger = {
  error(
    context: { event: "database_pool_idle_error" },
    message: string,
  ): unknown;
};

/**
 * pg has already removed a failed idle connection before emitting this event.
 * Observe it at API startup so an expected connection outage does not become an
 * unhandled EventEmitter error. Active query rejections are not intercepted.
 */
export function observeDatabasePoolErrors(
  pool: PoolErrorSource,
  logger: PoolErrorLogger,
): void {
  pool.on("error", () => {
    // Never include the driver error/client: both can contain connection secrets.
    logger.error(
      { event: "database_pool_idle_error" },
      "An idle database connection was lost; database readiness may be unavailable",
    );
  });
}
