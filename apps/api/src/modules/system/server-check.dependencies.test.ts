import type { Context } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  assert: vi.fn(async () => undefined),
  checkComponents: vi.fn(),
  deliverManagedImage: vi.fn(async () => ({ delivered: false })),
  dockerInstaller: vi.fn(),
  edgeInstaller: vi.fn(),
  ensureEdge: vi.fn(),
  recoverInterruptedTakeover: vi.fn(async () => undefined),
  refreshServerContainer: vi.fn(async () => undefined),
  streamSSE: vi.fn(),
  withExecutor: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    server: {
      get: vi.fn(async () => undefined),
      getInOrganization: vi.fn(async () => null),
      list: vi.fn(async () => []),
    },
    member: { find: vi.fn(async () => null) },
    serverContainer: { list: vi.fn(async () => []) },
  },
}));

vi.mock("@repo/adapters", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkComponents: h.checkComponents,
    COMPONENT_INSTALLERS: {
      ...(actual.COMPONENT_INSTALLERS as Record<string, unknown>),
      docker: h.dockerInstaller,
      edge: h.edgeInstaller,
    },
    ensureEdge: h.ensureEdge,
    recoverInterruptedTakeover: h.recoverInterruptedTakeover,
  };
});

vi.mock("../../config", async (importOriginal) => {
  const actual = await importOriginal<{ env: Record<string, unknown> }>();
  return {
    ...actual,
    env: { ...actual.env, CLOUD_MODE: false, DEPLOY_MODE: "bare" },
  };
});

vi.mock("../../lib/permission", () => ({ permission: { assert: h.assert } }));
vi.mock("../../lib/request-context", () => ({
  getRequestContext: () => ({ userId: "u1", organizationId: "org1", role: "owner" }),
}));
vi.mock("../../lib/ssh-manager", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sshManager: { withExecutor: h.withExecutor },
}));
vi.mock("../../lib/sse", () => ({ streamSSE: h.streamSSE }));
vi.mock("../../lib/deliver-managed-image", () => ({
  deliverManagedImage: h.deliverManagedImage,
}));
vi.mock("./server-containers.service", () => ({
  refreshServerContainer: h.refreshServerContainer,
}));

import { checkServer, installComponent, installStream } from "./server-check.controller";

const executor = {} as never;

function component(name: string, healthy: boolean) {
  return {
    name,
    label: name,
    description: `${name} component`,
    installable: true,
    installed: healthy,
    running: healthy,
    healthy,
    message: healthy ? `${name} ready` : `${name} missing`,
  };
}

function context(body: unknown) {
  const sent: { body: unknown; status: number } = { body: undefined, status: 0 };
  const c = {
    req: { json: vi.fn(async () => body) },
    json: vi.fn((payload: unknown, status = 200) => {
      sent.body = payload;
      sent.status = status;
      return { payload, status };
    }),
  };
  return { c: c as unknown as Context, sent };
}

async function finishStream(body: unknown) {
  const response = { stream: true };
  h.streamSSE.mockReturnValueOnce(response);
  const { c } = context(body);

  await expect(installStream(c)).resolves.toBe(response);
  const callback = h.streamSSE.mock.calls.at(-1)?.[1];
  expect(callback).toBeTypeOf("function");

  const running = callback({
    writeSSE: vi.fn(async () => undefined),
    onAbort: vi.fn(),
  });
  await vi.runAllTimersAsync();
  await running;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.withExecutor.mockImplementation(async (_serverId: string, run: (value: unknown) => unknown) =>
    run(executor),
  );
  h.checkComponents.mockImplementation(async (_executor: unknown, names: string[]) =>
    names.map((name) => component(name, true)),
  );
  h.dockerInstaller.mockResolvedValue({ component: "docker", success: true });
  h.edgeInstaller.mockResolvedValue({ component: "edge", success: true });
  h.ensureEdge.mockImplementation(
    async (_executor: unknown, install: (prompt?: unknown) => unknown) => ({
      migrated: false,
      value: await install(undefined),
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("remote server prerequisite checks", () => {
  it("reports Docker missing even when this control plane runs in bare mode", async () => {
    h.checkComponents.mockImplementation(async (_executor: unknown, names: string[]) =>
      names.map((name) =>
        component(name, name !== "docker" && name !== "edge" && name !== "rsync"),
      ),
    );
    const { c, sent } = context({ serverId: "server-1" });

    await checkServer(c);

    expect(h.checkComponents).toHaveBeenCalledWith(executor, ["docker", "git", "edge", "rsync"]);
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ ready: false, missing: ["docker"] });
  });
});

describe("server component installation dependencies", () => {
  it("orders a reversed Edge + Docker stream as Docker then Edge", async () => {
    await finishStream({ serverId: "server-1", components: ["edge", "docker"] });

    expect(h.dockerInstaller).toHaveBeenCalledTimes(1);
    expect(h.edgeInstaller).toHaveBeenCalledTimes(1);
    expect(h.dockerInstaller.mock.invocationCallOrder[0]).toBeLessThan(
      h.deliverManagedImage.mock.invocationCallOrder[0]!,
    );
    expect(h.deliverManagedImage.mock.invocationCallOrder[0]).toBeLessThan(
      h.edgeInstaller.mock.invocationCallOrder[0]!,
    );
  });

  it("does not reinstall a healthy Docker dependency added for Edge", async () => {
    await finishStream({
      serverId: "server-1",
      components: ["edge"],
      config: { reinstall: true },
    });

    expect(h.checkComponents).toHaveBeenCalledWith(executor, ["docker"]);
    expect(h.dockerInstaller).not.toHaveBeenCalled();
    expect(h.edgeInstaller).toHaveBeenCalledTimes(1);
  });

  it("does not deliver or install Edge when Docker installation fails", async () => {
    h.checkComponents.mockImplementation(async (_executor: unknown, names: string[]) =>
      names.map((name) => component(name, name !== "docker")),
    );
    h.dockerInstaller.mockResolvedValueOnce({
      component: "docker",
      success: false,
      error: "Docker installation failed",
    });

    await finishStream({ serverId: "server-1", components: ["edge"] });

    expect(h.dockerInstaller).toHaveBeenCalledTimes(1);
    expect(h.deliverManagedImage).not.toHaveBeenCalled();
    expect(h.edgeInstaller).not.toHaveBeenCalled();
  });

  it("blocks the single Edge endpoint before image delivery when Docker is unhealthy", async () => {
    h.checkComponents.mockResolvedValueOnce([component("docker", false)]);
    const { c, sent } = context({ serverId: "server-1", component: "edge" });

    await installComponent(c);

    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({
      error: "missing_dependency",
      component: "edge",
      missing: ["docker"],
    });
    expect(h.deliverManagedImage).not.toHaveBeenCalled();
    expect(h.edgeInstaller).not.toHaveBeenCalled();
  });
});
