import { describe, expect, it } from "vitest";
import type { Database } from "../client";
import {
  createServiceRepo,
  removedComposeEnvironmentKeys,
  toComposeSpec,
  type ParsedComposeService,
} from "./service.repo";

const fullEnvironment = {
  NODE_ENV: "production",
  PORT: "4000",
  BETTER_AUTH_SECRET: "legacy-auth-secret",
  GITHUB_CLIENT_SECRET: "legacy-oauth-secret",
  SMTP_HOST: "smtp.example.com",
};

function existingService(overrides: Record<string, unknown> = {}) {
  const compose = {
    image: "example/api:1",
    ports: ["4000"],
    environment: fullEnvironment,
    volumes: ["api_data:/data"],
  };
  return {
    id: "svc_api",
    projectId: "proj_1",
    name: "api",
    kind: "compose",
    enabled: true,
    exposed: false,
    exposedPort: null,
    domain: null,
    customDomain: null,
    domainType: "free",
    publicEndpoints: [],
    driftSpec: null,
    ...compose,
    importedSpec: toComposeSpec(compose),
    ...overrides,
  };
}

/**
 * Stateful repository seam: reconciliation uses the real createServiceRepo
 * implementation, while this tiny DB adapter records exactly what it commits.
 * It is intentionally stateful because reconcileFromCompose re-reads services
 * at the end; a write that only looked safe in its payload must also leave the
 * final stored row safe.
 */
function harness(initial = existingService()) {
  let stored = structuredClone(initial);
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    query: { service: { findMany: async () => [stored] } },
    update: () => ({
      set: (data: Record<string, unknown>) => ({
        where: async () => {
          writes.push(data);
          stored = { ...stored, ...data };
        },
      }),
    }),
  } as unknown as Database;
  return {
    repo: createServiceRepo(db),
    writes,
    stored: () => stored,
  };
}

describe("Compose environment deletion safety", () => {
  it("detects only removed keys, not additions or value rotations", () => {
    expect(
      removedComposeEnvironmentKeys(
        toComposeSpec({ environment: fullEnvironment }),
        toComposeSpec({
          environment: {
            ...fullEnvironment,
            BETTER_AUTH_SECRET: "rotated",
            NEW_KEY: "added",
          },
        }),
      ),
    ).toEqual([]);

    const { SMTP_HOST: _removed, ...withoutSmtp } = fullEnvironment;
    expect(
      removedComposeEnvironmentKeys(
        toComposeSpec({ environment: fullEnvironment }),
        toComposeSpec({ environment: withoutSmtp }),
      ),
    ).toEqual(["SMTP_HOST"]);
  });

  it("preserves every stored value when an untouched service loses some repo keys", async () => {
    const h = harness();
    const proposed = {
      name: "api",
      image: "example/api:1",
      ports: ["4000"],
      environment: { NODE_ENV: "production", PORT: "4000" },
      volumes: ["api_data:/data"],
    };

    const result = await h.repo.reconcileFromCompose("proj_1", [proposed]);

    expect(result.driftedNames).toEqual(["api"]);
    expect(h.stored().environment).toEqual(fullEnvironment);
    expect(h.stored().importedSpec).toEqual(existingService().importedSpec);
    expect(h.stored().driftSpec).toEqual(toComposeSpec(proposed));
  });

  it("preserves every stored value when the repo removes the entire environment block", async () => {
    const h = harness();
    const proposed = {
      name: "api",
      image: "example/api:1",
      ports: ["4000"],
      volumes: ["api_data:/data"],
    };

    await h.repo.reconcileFromCompose("proj_1", [proposed]);

    expect(h.stored().environment).toEqual(fullEnvironment);
    expect(h.stored().driftSpec).toEqual(toComposeSpec(proposed));
  });

  it("does not smuggle unrelated image, port, or volume changes through with a deletion", async () => {
    const h = harness();
    const proposed = {
      name: "api",
      image: "example/api:2",
      ports: ["5000"],
      environment: { NODE_ENV: "production" },
      volumes: ["new_data:/data"],
    };

    await h.repo.reconcileFromCompose("proj_1", [proposed]);

    expect(h.stored()).toMatchObject({
      image: "example/api:1",
      ports: ["4000"],
      volumes: ["api_data:/data"],
      environment: fullEnvironment,
      driftSpec: toComposeSpec(proposed),
    });
  });

  it("protects deleted keys when the operator also edited another value", async () => {
    const editedEnvironment = { ...fullEnvironment, PORT: "4400" };
    const h = harness(existingService({ environment: editedEnvironment }));
    const { SMTP_HOST: _removed, ...withoutSmtp } = fullEnvironment;
    const proposed = {
      name: "api",
      image: "example/api:2",
      ports: ["4000"],
      environment: withoutSmtp,
      volumes: ["api_data:/data"],
    };

    await h.repo.reconcileFromCompose("proj_1", [proposed]);

    expect(h.stored().environment).toEqual(editedEnvironment);
    expect(h.stored().driftSpec).toEqual(toComposeSpec(proposed));
  });

  it("does not churn the row when the same destructive drift is already pending", async () => {
    const proposed: ParsedComposeService = {
      name: "api",
      image: "example/api:1",
      ports: ["4000"],
      environment: { NODE_ENV: "production" },
      volumes: ["api_data:/data"],
    };
    const h = harness(existingService({ driftSpec: toComposeSpec(proposed) }));

    const result = await h.repo.reconcileFromCompose("proj_1", [proposed]);

    expect(result.driftedNames).toEqual(["api"]);
    expect(h.writes).toHaveLength(0);
    expect(h.stored().environment).toEqual(fullEnvironment);
  });

  it("continues auto-applying additions and rotations when no key is removed", async () => {
    const h = harness();
    const proposed = {
      name: "api",
      image: "example/api:2",
      ports: ["4000"],
      environment: {
        ...fullEnvironment,
        BETTER_AUTH_SECRET: "rotated",
        NEW_KEY: "added",
      },
      volumes: ["api_data:/data"],
    };

    const result = await h.repo.reconcileFromCompose("proj_1", [proposed]);

    expect(result.driftedNames).toEqual([]);
    expect(h.stored()).toMatchObject({
      image: "example/api:2",
      environment: proposed.environment,
      importedSpec: toComposeSpec(proposed),
      driftSpec: null,
    });
  });

  it("keeps legacy values while bootstrapping a missing baseline", async () => {
    const h = harness(existingService({ importedSpec: null }));
    const proposed = {
      name: "api",
      image: "example/api:2",
      environment: { NODE_ENV: "production" },
    };

    await h.repo.reconcileFromCompose("proj_1", [proposed]);

    expect(h.stored().environment).toEqual(fullEnvironment);
    expect(h.stored().importedSpec).toEqual(toComposeSpec(proposed));
    expect(h.stored().driftSpec).toBeNull();
  });
});
