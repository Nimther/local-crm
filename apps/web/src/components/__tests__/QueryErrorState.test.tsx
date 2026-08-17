import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { Button } from "@/components/ui/button";
import { EmptyState } from "../EmptyState";
import { QueryErrorState } from "../QueryErrorState";

/**
 * OPS-17 / D-11 (inline half): shared presentational components for a
 * failed-fetch region (QueryErrorState) and a successful-but-empty region
 * (EmptyState).
 *
 * No component-rendering harness (`@testing-library/react`, jsdom) exists in
 * this repo -- `apps/web`'s vitest lane runs with `environment: "node"`
 * (see vitest.config.ts), and this plan's threat model (T-15-SC) forbids any
 * new dependency. `QueryErrorState`/`EmptyState` are plain function
 * components with no hooks of their own, so calling them directly as
 * functions returns the exact React element tree their JSX describes --
 * `findByType` below walks `.props.children` on that tree to locate the
 * `<Button>` element exactly as authored, without ever invoking Card/
 * Button's own render (so no hook-dispatcher/renderer is required at all).
 * `renderToStaticMarkup` (the same technique already used by
 * `campaign-progress-ambiguous.test.tsx`) covers the textual/visual
 * distinctness assertions, which only need the final HTML string.
 */

function findByType(node: unknown, type: unknown, results: ReactElement[] = []): ReactElement[] {
  if (node == null || typeof node !== "object") return results;
  if (Array.isArray(node)) {
    for (const child of node) findByType(child, type, results);
    return results;
  }
  const el = node as ReactElement & { props?: { children?: unknown } };
  if (el.type === type) results.push(el);
  if (el.props && "children" in el.props) findByType(el.props.children, type, results);
  return results;
}

describe("QueryErrorState", () => {
  it("invokes the supplied onRetry callback exactly once per click", () => {
    const onRetry = vi.fn();
    const tree = QueryErrorState({ title: "Не удалось загрузить контакты", onRetry });
    const [button] = findByType(tree, Button);
    expect(button).toBeDefined();

    (button.props as { onClick: () => void }).onClick();
    expect(onRetry).toHaveBeenCalledTimes(1);

    (button.props as { onClick: () => void }).onClick();
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("disables the Retry control while a retry is pending", () => {
    const onRetry = vi.fn();

    const pendingTree = QueryErrorState({ title: "t", onRetry, isFetching: true });
    const [pendingButton] = findByType(pendingTree, Button);
    expect((pendingButton.props as { disabled?: boolean }).disabled).toBe(true);

    const idleTree = QueryErrorState({ title: "t", onRetry, isFetching: false });
    const [idleButton] = findByType(idleTree, Button);
    expect((idleButton.props as { disabled?: boolean }).disabled).toBe(false);
  });

  it("renders its own region-scoped title so two error regions are distinguishable", () => {
    const htmlA = renderToStaticMarkup(
      QueryErrorState({ title: "Не удалось загрузить контакты", onRetry: () => {} })
    );
    const htmlB = renderToStaticMarkup(
      QueryErrorState({ title: "Не удалось загрузить события", onRetry: () => {} })
    );
    expect(htmlA).toContain("Не удалось загрузить контакты");
    expect(htmlB).toContain("Не удалось загрузить события");
    expect(htmlA).not.toContain("Не удалось загрузить события");
  });
});

describe("EmptyState", () => {
  it("renders its message and optional call-to-action without a Retry control", () => {
    const html = renderToStaticMarkup(
      EmptyState({ title: "Пока нет контактов", description: "Добавьте первый контакт." })
    );
    expect(html).toContain("Пока нет контактов");
    expect(html).toContain("Добавьте первый контакт.");
    expect(html).not.toContain("Повторить");

    const tree = EmptyState({ title: "Пока нет контактов" });
    expect(findByType(tree, Button)).toHaveLength(0);
  });

  it("renders an optional call-to-action node when supplied", () => {
    const html = renderToStaticMarkup(
      EmptyState({
        title: "Пока нет сегментов",
        action: <button type="button">Создать сегмент</button>,
      })
    );
    expect(html).toContain("Создать сегмент");
  });
});

describe("QueryErrorState vs EmptyState distinctness", () => {
  it("is visually and textually distinguishable from EmptyState", () => {
    const errorHtml = renderToStaticMarkup(
      QueryErrorState({ title: "Не удалось загрузить контакты", onRetry: () => {} })
    );
    const emptyHtml = renderToStaticMarkup(EmptyState({ title: "Пока нет контактов" }));

    expect(errorHtml).toContain("Повторить");
    expect(emptyHtml).not.toContain("Повторить");
    expect(errorHtml).not.toEqual(emptyHtml);
  });
});
