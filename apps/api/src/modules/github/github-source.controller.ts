/** Owner-only HTTP surface for organization-scoped, self-hosted GitHub Apps. */

import type { Context } from "hono";

import { audit, auditContextFrom } from "../../lib/audit";
import { param } from "../../lib/controller-helpers";
import { getRequestContext } from "../../lib/request-context";
import type {
  TGitHubSourceManifestBody,
  TGitHubSourceManifestConvertBody,
  TGitHubSourceManualBody,
  TGitHubSourceUpdateBody,
} from "./github.schema";
import * as service from "./github-source.service";

function sourceAuditShape(source: service.PublicGitHubSource) {
  return {
    name: source.name,
    appId: source.appId,
    slug: source.slug,
    apiBaseUrl: source.apiBaseUrl,
    webBaseUrl: source.webBaseUrl,
    isDefault: source.isDefault,
    status: source.status,
  };
}

export async function listSources(c: Context) {
  const ctx = getRequestContext(c);
  const [sources, configuration] = await Promise.all([
    service.listGitHubSources(ctx.organizationId),
    service.getGitHubSourceConfiguration(),
  ]);
  return c.json({ data: sources, configuration });
}

export async function beginManifest(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<TGitHubSourceManifestBody>();
  return c.json(await service.beginGitHubManifestFlow(ctx, body), 201);
}

export async function convertManifest(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<TGitHubSourceManifestConvertBody>();
  const result = await service.convertGitHubManifest(ctx, body);
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "github.source.created",
    resourceType: "github",
    resourceId: result.source.id,
    after: { ...sourceAuditShape(result.source), registration: "manifest" },
  });
  return c.json({ data: result.source, installUrl: result.installUrl }, 201);
}

export async function createManual(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<TGitHubSourceManualBody>();
  const source = await service.createManualGitHubSource(ctx.organizationId, body);
  const install = await service.createSourceInstallUrl(ctx, source.id);
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "github.source.created",
    resourceType: "github",
    resourceId: source.id,
    after: { ...sourceAuditShape(source), registration: "manual" },
  });
  return c.json({ data: source, installUrl: install.url }, 201);
}

export async function updateSource(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  const before = (await service.listGitHubSources(ctx.organizationId)).find((row) => row.id === id);
  const body = await c.req.json<TGitHubSourceUpdateBody>();
  const source = await service.updateGitHubSource(ctx.organizationId, id, body);
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "github.source.updated",
    resourceType: "github",
    resourceId: id,
    before: before ? sourceAuditShape(before) : null,
    after: sourceAuditShape(source),
  });
  return c.json({ data: source });
}

export async function verifySource(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  const source = await service.verifyGitHubSource(ctx.organizationId, id);
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "github.source.verified",
    resourceType: "github",
    resourceId: id,
    after: sourceAuditShape(source),
  });
  return c.json({ data: source });
}

export async function setDefaultSource(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  const source = await service.setDefaultGitHubSource(ctx.organizationId, id);
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "github.source.defaulted",
    resourceType: "github",
    resourceId: id,
    after: sourceAuditShape(source),
  });
  return c.json({ data: source });
}

export async function createInstallUrl(c: Context) {
  const ctx = getRequestContext(c);
  return c.json(await service.createSourceInstallUrl(ctx, param(c, "id")), 201);
}

export async function deleteSource(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  const before = (await service.listGitHubSources(ctx.organizationId)).find((row) => row.id === id);
  await service.deleteGitHubSource(ctx.organizationId, id);
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "github.source.deleted",
    resourceType: "github",
    resourceId: id,
    before: before ? sourceAuditShape(before) : null,
  });
  return c.json({ success: true });
}
