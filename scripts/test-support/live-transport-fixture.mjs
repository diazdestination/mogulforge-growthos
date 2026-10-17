import { vi } from "vitest";
import { EventEmitter } from "node:events";
import { createLiveTransport } from "../production75-live-transport.mjs";
const credential = "fm1r_" + "A".repeat(40),
  config = `access_token: ${credential},${"B".repeat(40)}\n`;
export function createLiveTransportFixture({ fetchFn, queryFn } = {}) {
  let alive = false,
    closed = false;
  const child = new EventEmitter();
  child.pid = 123;
  child.stdout = new EventEmitter();
  child.stdout.resume = () => {};
  child.stderr = { resume() {} };
  child.kill = () => {
    alive = false;
    closed = true;
    queueMicrotask(() => child.emit("close", 0));
    return true;
  };
  const runFile = vi.fn(async (args) =>
    args[0] === "auth" ? "diazdestination@gmail.com\n" : "",
  );
  const inspect = vi.fn(async (kind, id) =>
    kind === "listener"
      ? alive
        ? [{ pid: 123, address: "127.0.0.1" }]
        : []
      : kind === "children"
        ? []
        : closed
          ? null
          : { pid: id, created: "fixed", executable: "fly" },
  );
  class Client extends EventEmitter {
    constructor(c) {
      super();
      this.config = c;
      this.connection = {
        stream: {
          destroyed: false,
          destroy() {
            this.destroyed = true;
          },
        },
      };
    }
    async connect() {}
    async query(...args) {
      if (queryFn) return queryFn(...args);
      return { rows: [] };
    }
    async end() {
      this.connection.stream.destroy();
    }
  }
  const transport = createLiveTransport({
    fetchFn,
    runFile,
    spawnChild: () => {
      alive = true;
      return child;
    },
    readCredentialConfig: async () => config,
    inspect,
    Client,
    choosePort: () => 16487,
    pause: async () => {},
  });
  return { transport, runFile, inspect, Client, child };
}
