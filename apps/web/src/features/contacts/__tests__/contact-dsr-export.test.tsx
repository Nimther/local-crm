import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

import type { ContactResponse } from "@mega-crm/shared-schemas";
import { ApiError } from "@/lib/api";
import { ExportContactButton } from "../ContactDetailPage";

/**
 * Phase 21 plan 01 (DSR-01/DSR-04, D-12): node-lane markup assertions only
 * (no jsdom/@testing-library in this repo -- same constraint documented in
 * campaign-dirty-blocking.test.tsx). The blob save itself
 * (`URL.createObjectURL`, synthetic anchor click) is unreachable in this
 * lane and is covered by the end-of-phase human check (21-01-PLAN.md
 * Task 3's `<human-check>`).
 *
 * `useMutation` is mocked so the Pending/Error cases can render a specific
 * mutation state synchronously -- `renderToStaticMarkup` has no commit
 * phase, so there is no way to drive a real mutation from idle to pending
 * to error inside a single render pass. The Owner/Admin/Member cases
 * delegate to the REAL implementation (`realUseMutation`, captured from the
 * unmocked module below): rendering alone never calls `.mutate()`, so no
 * network request is ever attempted even with the real hook wired up.
 */
const { realUseMutationRef } = vi.hoisted(() => ({
  realUseMutationRef: { current: null as typeof import("@tanstack/react-query").useMutation | null },
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  realUseMutationRef.current = actual.useMutation;
  return {
    ...actual,
    useMutation: vi.fn((options: Parameters<typeof actual.useMutation>[0]) => realUseMutationRef.current!(options)),
  };
});

const mockedUseMutation = useMutation as unknown as ReturnType<typeof vi.fn>;

const SLUG = "acme";

function baseContact(overrides: Partial<ContactResponse> = {}): ContactResponse {
  return {
    id: "contact-1",
    workspaceId: "workspace-1",
    externalId: null,
    email: "contact@example.com",
    firstName: null,
    lastName: null,
    phone: null,
    city: null,
    country: null,
    timezone: null,
    tags: [],
    properties: {},
    subscriptionStatus: "subscribed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function render(viewerRole: string, contact: ContactResponse = baseContact()): string {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ExportContactButton slug={SLUG} contact={contact} viewerRole={viewerRole} />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe("ExportContactButton (DSR-01/DSR-04, plan 21-01)", () => {
  beforeEach(() => {
    mockedUseMutation.mockReset();
    // Default: delegate to the real hook -- restores actual behaviour for
    // every test that does not override it below (Owner/Admin/Member).
    mockedUseMutation.mockImplementation((options: Parameters<typeof useMutation>[0]) => realUseMutationRef.current!(options));
  });

  it("Owner: renders the export button with its idle label", () => {
    const html = render("owner");
    expect(html).toContain("Скачать данные контакта");
  });

  it("Admin: renders the export button with its idle label", () => {
    const html = render("admin");
    expect(html).toContain("Скачать данные контакта");
  });

  it("Member: renders nothing -- the action is absent from the DOM, not disabled", () => {
    const html = render("member");
    expect(html).not.toContain("Скачать данные контакта");
    expect(html).toBe("");
  });

  it("Pending: renders the in-flight label with the button disabled", () => {
    mockedUseMutation.mockReturnValue({
      isPending: true,
      error: null,
      mutate: vi.fn(),
    });

    const html = render("owner");
    expect(html).toContain("Скачиваем…");
    const tagStart = html.lastIndexOf("<button");
    const tagEnd = html.indexOf(">", tagStart);
    const openTag = html.slice(tagStart, tagEnd + 1);
    expect(openTag).toContain('disabled=""');
  });

  it("Error slot: a generic mutation failure renders the page's GENERIC_ERROR copy in a destructive paragraph", () => {
    mockedUseMutation.mockReturnValue({
      isPending: false,
      error: new Error("boom"),
      mutate: vi.fn(),
    });

    const html = render("owner");
    expect(html).toContain("Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.");
    expect(html).toContain("text-destructive");
  });

  it("Error slot: a 410 contact_erased failure renders the erased-contact copy, not the generic error", () => {
    mockedUseMutation.mockReturnValue({
      isPending: false,
      error: new ApiError(410, "erased", { code: "contact_erased" }),
      mutate: vi.fn(),
    });

    const html = render("owner");
    expect(html).toContain("Контакт обезличен — персональные данные удалены");
    expect(html).not.toContain("Что-то пошло не так");
  });
});
