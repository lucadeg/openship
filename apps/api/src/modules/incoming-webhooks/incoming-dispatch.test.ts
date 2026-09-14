import { beforeEach, describe, expect, it, vi } from "vitest";

const { findById, listByProject, markFired, record, triggerDeployment } = vi.hoisted(() => ({
  findById: vi.fn(),
  listByProject: vi.fn(),
  markFired: vi.fn(),
  record: vi.fn().mockResolvedValue(undefined),
  triggerDeployment: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    incomingWebhook: { findById, markFired },
    service: { listByProject },
    webhookDelivery: { record },
  },
}));
vi.mock("../../lib/encryption", () => ({ encrypt: vi.fn(), decrypt: vi.fn() }));
vi.mock("../webhooks/webhook.service", () => ({ verifyHmacSha256: vi.fn() }));
vi.mock("../github/webhook-shared", () => ({
  webhookActorCtx: (userId: string, organizationId: string, source: string) => ({
    userId,
    organizationId,
    source,
  }),
}));
vi.mock("../../lib/org-actor", () => ({
  resolveOrgOwner: vi.fn().mockResolvedValue({ userId: "owner-1" }),
}));
vi.mock("../deployments/build.service", () => ({ triggerDeployment }));
vi.mock("../jobs/job.service", () => ({ runJobNow: vi.fn() }));
vi.mock("../../lib/audit", () => ({ audit: { recordAsync: vi.fn() } }));
vi.mock("../../lib/public-url", () => ({ incomingWebhookUrl: vi.fn() }));
vi.mock("../../config", () => ({ env: { CLOUD_MODE: false } }));

import { triggerIncomingWebhook } from "./incoming.service";

describe("incoming webhook multi-service dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    record.mockResolvedValue(undefined);
  });

  it("creates one deployment containing every selected service", async () => {
    findById.mockResolvedValue({
      id: "hook-1",
      projectId: "project-1",
      organizationId: "org-1",
      createdBy: "creator-1",
      name: "Deploy API and worker",
      enabled: true,
      actionType: "deploy",
      actionConfig: { serviceIds: ["service-api", "service-worker"] },
      authMode: "none",
    });
    listByProject.mockResolvedValue([
      { id: "service-api", enabled: true },
      { id: "service-worker", enabled: true },
    ]);
    triggerDeployment.mockResolvedValue({ deployment: { id: "deployment-1" } });

    await expect(
      triggerIncomingWebhook({ id: "hook-1", rawBody: Buffer.alloc(0) }),
    ).resolves.toEqual({ ok: true, action: "deploy", ref: "deployment-1" });

    expect(triggerDeployment).toHaveBeenCalledTimes(1);
    expect(triggerDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "owner-1", organizationId: "org-1" }),
      {
        projectId: "project-1",
        trigger: "webhook",
        serviceIds: ["service-api", "service-worker"],
        strictServiceScope: true,
        forcePullImages: true,
      },
    );
    expect(markFired).toHaveBeenCalledWith("hook-1");
  });

  it("fails closed without creating a partial deployment when a target is stale", async () => {
    findById.mockResolvedValue({
      id: "hook-1",
      projectId: "project-1",
      organizationId: "org-1",
      name: "Deploy API and worker",
      enabled: true,
      actionType: "deploy",
      actionConfig: { serviceIds: ["service-api", "deleted-service"] },
      authMode: "none",
    });
    listByProject.mockResolvedValue([{ id: "service-api", enabled: true }]);

    await expect(
      triggerIncomingWebhook({ id: "hook-1", rawBody: Buffer.alloc(0) }),
    ).resolves.toEqual({ error: "action_failed" });

    expect(triggerDeployment).not.toHaveBeenCalled();
    expect(markFired).not.toHaveBeenCalled();
  });

  it("fails closed when any selected service is disabled", async () => {
    findById.mockResolvedValue({
      id: "hook-1",
      projectId: "project-1",
      organizationId: "org-1",
      name: "Deploy API and worker",
      enabled: true,
      actionType: "deploy",
      actionConfig: { serviceIds: ["service-api", "service-worker"] },
      authMode: "none",
    });
    listByProject.mockResolvedValue([
      { id: "service-api", enabled: true },
      { id: "service-worker", enabled: false },
    ]);

    await expect(
      triggerIncomingWebhook({ id: "hook-1", rawBody: Buffer.alloc(0) }),
    ).resolves.toEqual({ error: "action_failed" });

    expect(triggerDeployment).not.toHaveBeenCalled();
  });

  it("force-pulls a whole-project hook without adding a target subset", async () => {
    findById.mockResolvedValue({
      id: "hook-all",
      projectId: "project-1",
      organizationId: "org-1",
      name: "Deploy everything",
      enabled: true,
      actionType: "deploy",
      actionConfig: {},
      authMode: "none",
    });
    triggerDeployment.mockResolvedValue({ deployment: { id: "deployment-all" } });

    await expect(
      triggerIncomingWebhook({ id: "hook-all", rawBody: Buffer.alloc(0) }),
    ).resolves.toEqual({ ok: true, action: "deploy", ref: "deployment-all" });

    expect(triggerDeployment).toHaveBeenCalledWith(expect.any(Object), {
      projectId: "project-1",
      trigger: "webhook",
      serviceIds: undefined,
      strictServiceScope: false,
      forcePullImages: true,
    });
  });

  it("keeps legacy empty serviceId rows dispatching as whole-project hooks", async () => {
    findById.mockResolvedValue({
      id: "hook-legacy-all",
      projectId: "project-1",
      organizationId: "org-1",
      name: "Deploy everything",
      enabled: true,
      actionType: "deploy",
      actionConfig: { serviceId: "" },
      authMode: "none",
    });
    triggerDeployment.mockResolvedValue({ deployment: { id: "deployment-all" } });

    await expect(
      triggerIncomingWebhook({ id: "hook-legacy-all", rawBody: Buffer.alloc(0) }),
    ).resolves.toEqual({ ok: true, action: "deploy", ref: "deployment-all" });

    expect(triggerDeployment).toHaveBeenCalledWith(expect.any(Object), {
      projectId: "project-1",
      trigger: "webhook",
      serviceIds: undefined,
      strictServiceScope: false,
      forcePullImages: true,
    });
  });
});
