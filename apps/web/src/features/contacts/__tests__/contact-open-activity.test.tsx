import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { useQuery } from "@tanstack/react-query";

import { ContactEventFeed } from "../ContactEventFeed";

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQuery: vi.fn() };
});

const mockedUseQuery = useQuery as unknown as ReturnType<typeof vi.fn>;

describe("ContactEventFeed open activity", () => {
  function setOpenActivity(openCount: number) {
    mockedUseQuery.mockReturnValue({
      data: [
        {
          kind: "send",
          occurredAt: "2026-02-01T11:00:00.000Z",
          label: "Письмо открыто",
          detail: {
            sendId: "send-1",
            activityType: "open",
            openCount,
          },
        },
      ],
      isLoading: false,
      isError: false,
      isFetching: false,
    });
  }

  it("renders the first opening explicitly and shows repeat opens without a false sent badge", () => {
    setOpenActivity(3);

    const html = renderToStaticMarkup(<ContactEventFeed slug="acme" contactId="contact-1" />);

    expect(html).toContain("Письмо открыто");
    expect(html).toContain("открыто ×3");
    expect(html).not.toContain("Отправлено");
  });

  it("keeps a single open visible without pretending that it repeated", () => {
    setOpenActivity(1);

    const html = renderToStaticMarkup(<ContactEventFeed slug="acme" contactId="contact-1" />);

    expect(html).toContain("Письмо открыто");
    expect(html).not.toContain("открыто ×1");
    expect(html).not.toContain("Отправлено");
  });
});
