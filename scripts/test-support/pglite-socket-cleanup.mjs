// Test-only lifecycle adapter for @electric-sql/pglite-socket 0.2.11.
// stop() does not await detach(), and native close schedules another detach via
// setImmediate. Never close PGlite until stop() below has fulfilled.
const registrations = new WeakSet();
const nextTurn = () => new Promise((done) => setImmediate(done));

export function trackPgliteSocketCleanup(server, Handler, { timeoutMs = 5000 } = {}) {
  const prototype = Handler.prototype;
  if (registrations.has(prototype)) throw new Error("pglite_socket_cleanup_already_registered");
  registrations.add(prototype);
  const original = prototype.detach;
  const calls = [];
  let pending = 0, stopPromise;
  prototype.detach = function (...args) {
    const promise = original.apply(this, args);
    const call = { handler: this, failed: false, error: undefined };
    calls.push(call); pending++;
    // Observe immediately because the library deliberately ignores this promise.
    // Return the ORIGINAL promise unchanged; report every rejection from stop().
    call.settled = Promise.resolve(promise).then(
      () => { pending--; },
      (error) => { call.failed = true; call.error = error; pending--; },
    );
    return promise;
  };

  const drain = async () => {
    const expires = Date.now() + timeoutMs;
    for (;;) {
      const generation = calls.length;
      const before = server.getStats();
      // A condition-based event-loop turn, not a time-based sleep: the library
      // schedules handleClose/handleError with setImmediate. Continue until no
      // handler, query or recorded detach remains, and no later detach appeared.
      await nextTurn();
      const after = server.getStats();
      if (before.activeConnections === 0 && before.queuedQueries === 0 &&
          after.activeConnections === 0 && after.queuedQueries === 0 &&
          generation === calls.length && pending === 0) {
        await Promise.all(calls.map((call) => call.settled));
        return;
      }
      if (Date.now() >= expires) throw new Error("pglite_socket_cleanup_drain_timeout");
    }
  };

  return {
    stop() {
      return stopPromise ??= (async () => {
        try {
          // Pools/clients must already have ended. Let their natural close
          // callbacks complete BEFORE stop() clears the library's handler set.
          await drain();
          await server.stop();
          // Includes detach work queued during the listener's final close turn.
          await drain();
          const errors = calls.filter((call) => call.failed).map((call) => call.error);
          if (errors.length) throw new AggregateError(errors, "pglite_socket_cleanup_detach_failed");
          if (calls.some((call) => call.handler.isAttached)) throw new Error("pglite_socket_cleanup_handler_still_attached");
        } finally {
          prototype.detach = original;
          registrations.delete(prototype);
        }
      })();
    },
  };
}
