import { act, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DestructiveActionDialog } from "./DestructiveActionDialog.tsx";

describe("DestructiveActionDialog", () => {
  it("does not expose a closed destructive dialog to the accessibility tree", () => {
    render(
      <DestructiveActionDialog
        actionLabel="Delete location"
        description="This cannot be undone."
        failureMessage="Location was not deleted."
        isOpen={false}
        title="Delete this location?"
        onAction={async () => true}
        onOpenChange={(isOpen) => {
          void isOpen;
        }}
      />,
    );

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete location" })).not.toBeInTheDocument();
  });

  it.each(["unsuccessful", "rejected"])(
    "keeps %s action feedback inside the active alert dialog",
    async (outcome) => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();

      render(
        <DestructiveActionDialog
          actionLabel="Delete bottle"
          description="This cannot be undone."
          failureMessage="Bottle was not deleted. Try again."
          isOpen
          title="Delete this bottle?"
          onAction={async () => {
            if (outcome === "rejected") throw new Error("delete failed");
            return false;
          }}
          onOpenChange={(isOpen) => {
            onOpenChange(isOpen);
          }}
        />,
      );

      const dialog = screen.getByRole("alertdialog", { name: "Delete this bottle?" });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Delete bottle" }));

      expect(await screen.findByText("Bottle was not deleted. Try again.")).toBeVisible();
      expect(dialog).toContainElement(screen.getByRole("alert"));
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(screen.getByRole("alert").querySelector('[role="alert"], [aria-live]')).toBeNull();
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
    },
  );

  it("blocks repeat activation and closes only after success", async () => {
    const user = userEvent.setup();
    let resolveAction: ((result: boolean) => void) | undefined;
    const onAction = vi.fn(
      async () =>
        new Promise<boolean>((resolve) => {
          resolveAction = resolve;
        }),
    );
    const onOpenChange = vi.fn();

    render(
      <DestructiveActionDialog
        actionLabel="Delete site"
        description="This cannot be undone."
        failureMessage="Site was not deleted. Try again."
        isOpen
        title="Delete this site?"
        onAction={onAction}
        onOpenChange={(isOpen) => {
          onOpenChange(isOpen);
        }}
      />,
    );

    const action = screen.getByRole("button", { name: "Delete site" });
    await user.dblClick(action);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(action).toHaveAttribute("aria-busy", "true");
    expect(action).toHaveAttribute("aria-disabled", "true");
    expect(action).toHaveFocus();
    await user.keyboard("{Enter} ");
    await user.click(action);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    resolveAction?.(true);
    await waitFor(() => {
      expect(action).not.toHaveAttribute("aria-busy", "true");
      expect(action).not.toHaveAttribute("aria-disabled", "true");
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps keyboard focus cycling inside the active dialog", async () => {
    const user = userEvent.setup();
    render(
      <DestructiveActionDialog
        actionLabel="Delete capture"
        description="This cannot be undone."
        failureMessage="Capture was not deleted."
        isOpen
        title="Delete this capture?"
        onAction={async () => false}
        onOpenChange={(isOpen) => {
          void isOpen;
        }}
      />,
    );

    const cancel = screen.getByRole("button", { name: "Cancel" });
    const action = screen.getByRole("button", { name: "Delete capture" });
    await waitFor(() => {
      expect(cancel).toHaveFocus();
    });
    await user.tab({ shift: true });
    expect(action).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
  });

  it("restores safe focus when an animation frame runs before the failure commit", async () => {
    const user = userEvent.setup();
    let resolveAction: ((result: boolean) => void) | undefined;
    render(
      <DestructiveActionDialog
        actionLabel="Delete capture"
        description="This cannot be undone."
        failureMessage="Capture was not deleted."
        isOpen
        title="Delete this capture?"
        onAction={async () =>
          new Promise<boolean>((resolve) => {
            resolveAction = resolve;
          })
        }
        onOpenChange={vi.fn<(isOpen: boolean) => void>()}
      />,
    );
    const cancel = screen.getByRole("button", { name: "Cancel" });
    await user.click(screen.getByRole("button", { name: "Delete capture" }));
    expect(cancel).toBeDisabled();

    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((frame) => {
      frames.push(frame);
      return frames.length;
    });
    try {
      await act(async () => {
        resolveAction?.(false);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        // React has queued its state updates, but the disabled DOM has not committed yet.
        expect(cancel).toBeDisabled();
        for (const frame of frames.splice(0)) frame(0);
      });
      expect(screen.getByRole("alert")).toHaveTextContent("Capture was not deleted.");
      expect(cancel).toBeEnabled();
      expect(cancel).toHaveFocus();
    } finally {
      requestFrame.mockRestore();
    }
  });
});
