import { act, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReadPageStatus } from "./ReadPageStatus.tsx";

function page({
  visibleCount = 1,
  hasMore = true,
  onLoadMore,
  getTarget,
}: {
  readonly visibleCount?: number;
  readonly hasMore?: boolean;
  readonly onLoadMore: () => Promise<unknown>;
  readonly getTarget: (index: number) => HTMLElement | null;
}) {
  return (
    <>
      {visibleCount > 1 ? (
        <article id="revealed-row" tabIndex={-1}>
          New row
        </article>
      ) : null}
      <ReadPageStatus
        getRevealFocusTarget={getTarget}
        itemLabel="bottles"
        totalCount={3}
        visibleCount={visibleCount}
        hasMore={hasMore}
        isLoading={false}
        onLoadMore={onLoadMore}
      />
    </>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ReadPageStatus reveal focus", () => {
  it("waits for the new row to render after the load promise resolves", async () => {
    const user = userEvent.setup();
    const load = Promise.withResolvers<unknown>();
    const onLoadMore = async () => load.promise;
    const getTarget = vi.fn((index: number) =>
      index === 1 ? document.querySelector<HTMLElement>("#revealed-row") : null,
    );
    // The previous frame-based implementation tries to focus before React renders the row.
    /* oxlint-disable promise/prefer-await-to-callbacks -- The frame callback deliberately runs before the delayed React commit. */
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    /* oxlint-enable promise/prefer-await-to-callbacks */
    const { rerender } = render(page({ onLoadMore, getTarget }));
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await act(async () => {
      load.resolve("refreshed");
      await load.promise;
    });
    expect(screen.queryByText("New row")).not.toBeInTheDocument();

    rerender(page({ visibleCount: 2, onLoadMore, getTarget }));
    await waitFor(() => {
      expect(screen.getByText("New row")).toHaveFocus();
    });
    expect(getTarget).toHaveBeenLastCalledWith(1);
  });

  it("ignores a superseded load even if another page reveals the same index", async () => {
    const user = userEvent.setup();
    const load = Promise.withResolvers<unknown>();
    const onLoadMore = async () => load.promise;
    const getTarget = vi.fn(() => document.querySelector<HTMLElement>("#revealed-row"));
    const { rerender } = render(page({ onLoadMore, getTarget }));
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await act(async () => {
      load.resolve("superseded");
      await load.promise;
    });
    rerender(page({ visibleCount: 2, onLoadMore, getTarget }));
    expect(getTarget).not.toHaveBeenCalled();
    expect(screen.getByText("New row")).not.toHaveFocus();
  });

  it("cancels the reveal when a query resets its rows before the load settles", async () => {
    const user = userEvent.setup();
    const load = Promise.withResolvers<unknown>();
    const onLoadMore = async () => load.promise;
    const getTarget = vi.fn(() => document.querySelector<HTMLElement>("#revealed-row"));
    const { rerender } = render(page({ onLoadMore, getTarget }));
    await user.click(screen.getByRole("button", { name: "Load more" }));
    rerender(page({ visibleCount: 0, onLoadMore, getTarget }));
    await act(async () => {
      load.resolve("refreshed");
      await load.promise;
    });
    rerender(page({ visibleCount: 2, onLoadMore, getTarget }));
    expect(getTarget).not.toHaveBeenCalled();
  });

  it("clears an empty final-page reveal before a later refresh adds rows", async () => {
    const user = userEvent.setup();
    const load = Promise.withResolvers<unknown>();
    const onLoadMore = async () => load.promise;
    const getTarget = vi.fn(() => document.querySelector<HTMLElement>("#revealed-row"));
    const { rerender } = render(page({ onLoadMore, getTarget }));
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await act(async () => {
      load.resolve("refreshed");
      await load.promise;
    });
    rerender(page({ hasMore: false, onLoadMore, getTarget }));
    rerender(page({ visibleCount: 2, hasMore: false, onLoadMore, getTarget }));
    expect(getTarget).not.toHaveBeenCalled();
  });

  it("reports a failed load and leaves later rows unfocused", async () => {
    const user = userEvent.setup();
    const load = Promise.withResolvers<unknown>();
    const onLoadMore = async () => load.promise;
    const getTarget = vi.fn(() => document.querySelector<HTMLElement>("#revealed-row"));
    const { rerender } = render(page({ onLoadMore, getTarget }));
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await act(async () => {
      load.reject(new Error("Read failed"));
      await load.promise.catch(() => null);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("More bottles could not be loaded");
    rerender(page({ visibleCount: 2, onLoadMore, getTarget }));
    expect(getTarget).not.toHaveBeenCalled();
  });

  it("does not focus after unmounting with an outstanding load", async () => {
    const user = userEvent.setup();
    const load = Promise.withResolvers<unknown>();
    const getTarget = vi.fn(() => document.body);
    const { unmount } = render(page({ onLoadMore: async () => load.promise, getTarget }));
    await user.click(screen.getByRole("button", { name: "Load more" }));
    unmount();
    await act(async () => {
      load.resolve("refreshed");
      await load.promise;
    });
    expect(getTarget).not.toHaveBeenCalled();
  });
});
