import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { useEffect, useId, useRef, useState, type ReactElement, type RefObject } from "react";

export type DestructiveActionDialogProps = {
  readonly actionLabel: string;
  readonly description: string;
  readonly fallbackFocus?: () => HTMLElement | null;
  readonly failureMessage: string;
  readonly isOpen: boolean;
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
  readonly title: string;
  readonly onAction: () => Promise<boolean>;
  readonly onOpenChange: (isOpen: boolean) => void;
  readonly onSuccess?: () => void;
};

export function DestructiveActionDialog({
  actionLabel,
  description,
  fallbackFocus,
  failureMessage,
  isOpen,
  returnFocusRef,
  title,
  onAction,
  onOpenChange,
  onSuccess,
}: DestructiveActionDialogProps): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const isPendingRef = useRef(false);
  const actionRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const fallbackReturnFocusRef = useRef<HTMLElement | null>(null);
  const afterCloseRef = useRef<(() => void) | null>(null);
  const descriptionId = useId();

  useEffect(() => {
    if (isOpen) {
      const activeElement = document.activeElement;
      if (
        returnFocusRef === undefined &&
        fallbackReturnFocusRef.current === null &&
        activeElement instanceof HTMLElement &&
        activeElement !== actionRef.current &&
        activeElement !== cancelRef.current
      ) {
        fallbackReturnFocusRef.current = activeElement;
      }
      setError(null);
      requestAnimationFrame(() => {
        cancelRef.current?.focus();
      });
    }
  }, [isOpen]);

  useEffect(() => {
    // Focus only after React has committed the enabled recovery control.
    if (error !== null && !isPending) {
      cancelRef.current?.focus();
    }
  }, [error, isPending]);

  useEffect(() => {
    const trapFocus = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Tab") {
        return;
      }
      if (event.shiftKey && document.activeElement === cancelRef.current) {
        event.preventDefault();
        actionRef.current?.focus();
      } else if (!event.shiftKey && document.activeElement === actionRef.current) {
        event.preventDefault();
        cancelRef.current?.focus();
      }
    };
    const containFocus = (event: FocusEvent): void => {
      if (event.target !== cancelRef.current && event.target !== actionRef.current) {
        cancelRef.current?.focus();
      }
    };
    if (isOpen) {
      document.addEventListener("keydown", trapFocus);
      document.addEventListener("focusin", containFocus);
    }
    return () => {
      document.removeEventListener("keydown", trapFocus);
      document.removeEventListener("focusin", containFocus);
      // The owner has committed the close and the modal no longer traps focus.
      const afterClose = afterCloseRef.current;
      afterCloseRef.current = null;
      afterClose?.();
    };
  }, [isOpen]);

  async function runAction(): Promise<void> {
    if (isPendingRef.current) {
      return;
    }
    isPendingRef.current = true;
    setIsPending(true);
    setError(null);
    try {
      if (await onAction()) {
        finishPending();
        closeAndRestoreFocus("confirmed");
        return;
      }
      setError(failureMessage);
    } catch {
      setError(failureMessage);
    }
    finishPending();
  }

  function changeOpen(nextIsOpen: boolean): void {
    if (!isPendingRef.current) {
      if (nextIsOpen) {
        onOpenChange(true);
      } else {
        closeAndRestoreFocus("cancelled");
      }
    }
  }

  function finishPending(): void {
    isPendingRef.current = false;
    setIsPending(false);
  }

  function closeAndRestoreFocus(outcome: "confirmed" | "cancelled"): void {
    afterCloseRef.current = () => {
      const trigger = returnFocusRef?.current ?? fallbackReturnFocusRef.current;
      fallbackReturnFocusRef.current = null;
      const connectedTrigger = trigger?.isConnected === true ? trigger : null;
      const fallback = fallbackFocus?.();
      // A committed deletion can leave its trigger mounted until the next catalogue render.
      const target =
        outcome === "confirmed" ? (fallback ?? connectedTrigger) : (connectedTrigger ?? fallback);
      target?.focus();
      if (outcome === "confirmed") onSuccess?.();
    };
    onOpenChange(false);
  }

  if (!isOpen) {
    return <></>;
  }

  return (
    <Dialog
      aria-describedby={descriptionId}
      aria-label={title}
      isOpen={isOpen}
      purpose="form"
      role="alertdialog"
      width={440}
      onOpenChange={changeOpen}
    >
      <DialogHeader title={title} />
      <div className="destructive-dialog-content">
        <p className="field-hint" id={descriptionId}>
          {description}
        </p>
        {error === null ? null : <Banner role="alert" status="error" title={error} />}
        <div className="dialog-actions">
          <Button
            ref={cancelRef}
            isDisabled={isPending}
            label="Cancel"
            variant="ghost"
            onClick={() => {
              changeOpen(false);
            }}
          />
          <Button
            ref={actionRef}
            isLoading={isPending}
            label={actionLabel}
            variant="destructive"
            onClick={() => {
              void runAction();
            }}
          />
        </div>
      </div>
    </Dialog>
  );
}
