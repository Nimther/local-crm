import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import { parse } from "csv-parse";
import { csvDryRunRequestSchema, type CsvDryRunSummary, type DuplicatePolicy } from "@mega-crm/shared-schemas";
import { applyCsvRowMapping, findContactIdByIdentity } from "@mega-crm/contacts-core";
import { auth } from "../auth/auth.js";
import { toFetchHeaders } from "../../middleware/role-guard.js";
import { withTenant, withTenantTransaction, getWorkspaceId } from "../../middleware/tenant-context.js";
import { findActiveWorkspaceBySlug, type ActiveWorkspace } from "../tenancy/workspace-lookup.js";
import { getCallerRoles } from "../tenancy/member-roles.js";
import { importsCsvQueue } from "./imports-csv-queue.js";
import {
  createCsvImport,
  getCsvImport,
  listCsvImports,
  insertStagingRowsChunk,
  updateCsvImportTotalRows,
  getStagedRowsPage,
  setStagedRowClassification,
  saveDryRunResult,
  markCsvImportApplying,
  markCsvImportFailed,
  getErrorRows,
  type CsvImportRow,
} from "./csv-import.repository.js";

const UPLOAD_MAX_BYTES = 50 * 1024 * 1024; // T-02-07-01: bound upload size (streamed, never fully buffered)
const STAGING_CHUNK_SIZE = 500;
const DRY_RUN_PAGE_SIZE = 500;

/**
 * Resolves `:slug` to a workspace AND confirms the caller is a member --
 * same 404-non-enumeration shape as contacts.routes.ts's own
 * resolveWorkspaceMember (any throw from getCallerRoles maps to the same
 * 404 a nonexistent workspace returns).
 */
async function resolveWorkspaceMember(
  request: FastifyRequest,
  reply: FastifyReply,
  slug: string
): Promise<ActiveWorkspace | null> {
  const workspace = await findActiveWorkspaceBySlug(slug);
  if (!workspace) {
    await reply.code(404).send({ error: "Workspace not found" });
    return null;
  }
  try {
    await getCallerRoles(toFetchHeaders(request), slug);
  } catch {
    await reply.code(404).send({ error: "Workspace not found" });
    return null;
  }
  return workspace;
}

function toStatusResponse(row: CsvImportRow) {
  return {
    id: row.id,
    status: row.status,
    fileName: row.fileName,
    // D-20: exposed so the import-history list can resolve the uploading
    // member's display name against GET /members client-side.
    createdByUserId: row.createdByUserId,
    duplicatePolicy: row.duplicatePolicy,
    totalRows: row.totalRows,
    processedRows: row.processedRows,
    summary: row.summary,
    createdAt: row.createdAt.toISOString(),
  };
}

function csvEscape(value: string): string {
  if (/["\n,]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * D-17: re-classifies EVERY staged row against the given mapping+policy,
 * persisting error rows immediately (D-18's error report is visible right
 * after dry-run, before apply ever runs) and returning the whole-file
 * willCreate/willUpdate/errorCount summary WITHOUT writing a single contact.
 * Uses the SAME `applyCsvRowMapping`/`findContactIdByIdentity` the apply
 * worker uses, so the preview can never silently drift from what apply
 * actually does.
 */
async function computeDryRunSummary(
  csvImportId: string,
  mapping: Record<string, string>,
  duplicatePolicy: DuplicatePolicy,
  defaultTimezone: string | null | undefined
): Promise<CsvDryRunSummary> {
  let willCreate = 0;
  let willUpdate = 0;
  let errorCount = 0;
  let cursor = 0;

  while (true) {
    const page = await getStagedRowsPage(csvImportId, cursor, DRY_RUN_PAGE_SIZE);
    if (page.length === 0) break;

    for (const row of page) {
      cursor = row.rowNumber;
      const { input, error } = applyCsvRowMapping(row.raw, mapping, { defaultTimezone });

      if (error) {
        errorCount += 1;
        await setStagedRowClassification(csvImportId, row.rowNumber, "error", error);
        continue;
      }
      await setStagedRowClassification(csvImportId, row.rowNumber, "pending", null);

      const existingId = await withTenantTransaction((client) => {
        const workspaceId = getWorkspaceId();
        return findContactIdByIdentity(client, workspaceId, input);
      });
      if (existingId) {
        if (duplicatePolicy === "update") willUpdate += 1;
        // skip policy: an existing match is neither created nor updated.
      } else {
        willCreate += 1;
      }
    }
  }

  return { willCreate, willUpdate, errorCount };
}

/**
 * CSV contact import (CONT-02, D-15..D-20): session-authed, ordinary
 * workspace membership (same access level as contacts.routes.ts -- not an
 * elevated Owner/Admin action).
 */
export async function registerCsvImportRoutes(fastify: FastifyInstance): Promise<void> {
  // Upload route: @fastify/multipart registered INSIDE this encapsulated
  // plugin scope only (RESEARCH.md Pitfall 3) -- never globally, so the
  // JSON body parser used by every other route in this app is completely
  // unaffected.
  await fastify.register(async (scope) => {
    await scope.register(multipart, {
      limits: { fileSize: UPLOAD_MAX_BYTES },
    });

    scope.post("/api/workspaces/:slug/imports", async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const workspace = await resolveWorkspaceMember(request, reply, slug);
      if (!workspace) return;

      const session = await auth.api.getSession({ headers: toFetchHeaders(request) });
      if (!session) {
        return reply.code(401).send({ error: "Not authenticated" });
      }

      const data = await request.file();
      if (!data) {
        return reply.code(400).send({ error: "No file uploaded" });
      }

      const created = await withTenant(workspace.id, () =>
        createCsvImport({ fileName: data.filename, createdByUserId: session.user.id })
      );

      // csv-parse streams row-by-row (never fully buffers the file, D-16 /
      // T-02-07-01) -- `columns: true` maps each row to a header->value
      // object, which IS the "mapped rows" preview shape (D-17).
      const parser = data.file.pipe(parse({ columns: true, skip_empty_lines: true, trim: true }));

      let headerColumns: string[] = [];
      const previewRows: Record<string, string>[] = [];
      let rowNumber = 0;
      let chunk: Array<{ rowNumber: number; raw: Record<string, string> }> = [];

      // WR-04: the streaming parse loop has no other failure path -- an
      // uncaught parser/stream error (e.g. an unclosed CSV quote) would
      // otherwise reach Fastify's default handler as a bare 500 and leave
      // the import row (already created above) stuck at its default
      // 'uploaded' status forever, looking like a pending/successful
      // upload instead of a failure.
      try {
        await withTenant(workspace.id, async () => {
          for await (const record of parser as AsyncIterable<Record<string, string>>) {
            if (headerColumns.length === 0) headerColumns = Object.keys(record);
            rowNumber += 1;
            if (previewRows.length < 20) previewRows.push(record);
            chunk.push({ rowNumber, raw: record });
            if (chunk.length >= STAGING_CHUNK_SIZE) {
              const toInsert = chunk;
              chunk = [];
              await withTenantTransaction((client) => insertStagingRowsChunk(client, workspace.id, created.id, toInsert));
            }
          }
          if (chunk.length > 0) {
            await withTenantTransaction((client) => insertStagingRowsChunk(client, workspace.id, created.id, chunk));
          }
          await updateCsvImportTotalRows(created.id, rowNumber);
        });
      } catch (err) {
        await withTenant(workspace.id, () => markCsvImportFailed(created.id));
        const message = err instanceof Error ? err.message : "Failed to parse CSV file";
        return reply.code(422).send({ error: message });
      }

      // WR-04: @fastify/multipart silently truncates a file exceeding
      // UPLOAD_MAX_BYTES rather than throwing through this single-file
      // request.file() + stream-pipe pattern -- `truncated` is the ONLY
      // signal, and it's only reliably set once the stream has fully ended
      // (i.e. after the for-await loop above completes without error).
      if (data.file.truncated) {
        await withTenant(workspace.id, () => markCsvImportFailed(created.id));
        return reply.code(413).send({ error: "Uploaded file exceeds the maximum allowed size" });
      }

      return reply.send({
        importId: created.id,
        headers: headerColumns,
        previewRows,
        totalRows: rowNumber,
      });
    });
  });

  /** D-20: import history, newest first. */
  fastify.get("/api/workspaces/:slug/imports", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    const rows = await withTenant(workspace.id, () => listCsvImports());
    return reply.send(rows.map(toStatusResponse));
  });

  /** D-16: progress polling (processed/total, summary, current status). */
  fastify.get("/api/workspaces/:slug/imports/:id", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    const row = await withTenant(workspace.id, () => getCsvImport(id));
    if (!row) return reply.code(404).send({ error: "Import not found" });
    return reply.send(toStatusResponse(row));
  });

  /** D-17: whole-file dry-run validation -- writes NO contact, persists mapping+policy+summary for apply. */
  fastify.post("/api/workspaces/:slug/imports/:id/dry-run", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const parsed = csvDryRunRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    const summary = await withTenant(workspace.id, async () => {
      const existing = await getCsvImport(id);
      if (!existing) return null;
      return computeDryRunSummary(id, parsed.data.mapping, parsed.data.duplicatePolicy, parsed.data.defaultTimezone);
    });
    if (!summary) return reply.code(404).send({ error: "Import not found" });

    await withTenant(workspace.id, () =>
      saveDryRunResult(id, {
        mapping: parsed.data.mapping,
        duplicatePolicy: parsed.data.duplicatePolicy,
        defaultTimezone: parsed.data.defaultTimezone,
        summary,
      })
    );

    return reply.send(summary);
  });

  /** Enqueues the background apply job (CONT-02) -- must follow a dry-run (D-17 ordering: mapping must already be persisted). */
  fastify.post("/api/workspaces/:slug/imports/:id/apply", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    const existing = await withTenant(workspace.id, () => getCsvImport(id));
    if (!existing) return reply.code(404).send({ error: "Import not found" });
    if (!existing.mapping) {
      return reply.code(422).send({ error: "Run the dry-run validation before applying (D-17)" });
    }

    await withTenant(workspace.id, () => markCsvImportApplying(id));
    await importsCsvQueue.add("apply-import", { workspaceId: workspace.id, csvImportId: id });

    return reply.code(202).send({ queued: true });
  });

  /** D-18: downloadable CSV of only the errored rows, with a reason column. */
  fastify.get("/api/workspaces/:slug/imports/:id/errors", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    const errorRows = await withTenant(workspace.id, () => getErrorRows(id));

    const headerSet = new Set<string>();
    for (const row of errorRows) {
      for (const key of Object.keys(row.raw)) headerSet.add(key);
    }
    const headerColumns = [...headerSet];

    const lines = [
      [...headerColumns, "reason"].map(csvEscape).join(","),
      ...errorRows.map((row) => [...headerColumns.map((h) => row.raw[h] ?? ""), row.reason ?? ""].map(csvEscape).join(",")),
    ];

    reply.header("Content-Type", "text/csv");
    reply.header("Content-Disposition", `attachment; filename="import-${id}-errors.csv"`);
    return reply.send(lines.join("\n"));
  });
}
