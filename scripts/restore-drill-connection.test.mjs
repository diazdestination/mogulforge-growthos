import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  startRestoreProxy,
  restoreClient,
} from "./restore-drill-connection.mjs";

describe("owned Fly restore transport", () => {
  function processDouble() {
    return Object.assign(new EventEmitter(), {
      stdout: { resume: vi.fn() },
      stderr: { resume: vi.fn() },
      kill: vi.fn(),
    });
  }
  it("launches exactly the validated cluster with a private loopback listener and closes it", async () => {
    const child = processDouble();
    const spawnProcess = vi.fn(() => child);
    const proxy = await startRestoreProxy("zp2wjrejd2zodn4q", {
      spawnProcess,
      selectPort: async () => 16999,
      probe: async () => true,
      sleep: async () => {},
    });
    expect(spawnProcess.mock.calls[0][0]).toBe("fly");
    expect(spawnProcess.mock.calls[0][1]).toEqual([
      "mpg",
      "proxy",
      "zp2wjrejd2zodn4q",
      "--bind-addr",
      "127.0.0.1",
      "--local-port",
      "16999",
    ]);
    expect(proxy.host).toBe("127.0.0.1");
    await proxy.close();
    expect(child.kill).toHaveBeenCalledOnce();
  });
  it("rejects production and shell fragments before launch, and observes proxy start failures", async () => {
    const spawnProcess = vi.fn();
    await expect(
      startRestoreProxy("kzpwm0j18eg04nv3", { spawnProcess }),
    ).rejects.toThrow("restore_proxy_cluster_forbidden");
    await expect(
      startRestoreProxy("staging; run-other", { spawnProcess }),
    ).rejects.toThrow("restore_proxy_cluster_forbidden");
    expect(spawnProcess).not.toHaveBeenCalled();
    const child = processDouble();
    await expect(
      startRestoreProxy("zp2wjrejd2zodn4q", {
        spawnProcess: () => child,
        selectPort: async () => 16999,
        probe: async () => true,
        sleep: async () => {
          child.emit("error", new Error("private error"));
        },
      }),
    ).rejects.toThrow("restore_proxy_start_failed");
    expect(child.kill).toHaveBeenCalledOnce();
  });
  it("does not accept a local connection URL setting and requires a literal proxy flag", async () => {
    await expect(
      restoreClient({ RESTORE_DRILL_USE_FLY_PROXY: "yes" }, {}),
    ).rejects.toThrow("restore_proxy_setting_invalid");
  });
});
