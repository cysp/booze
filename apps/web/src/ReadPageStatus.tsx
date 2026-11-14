import { Button } from "@astryxdesign/core/Button";
import { useEffect, useRef, useState, type ReactElement } from "react";

type RevealRequest = {
  readonly firstIndex: number;
  readonly version: number;
  readonly complete: boolean;
};

export function ReadPageStatus({
  itemLabel,
  visibleCount,
  totalCount,
  hasMore,
  isLoading,
  onLoadMore,
  getRevealFocusTarget,
}: {
  readonly itemLabel: string;
  readonly visibleCount: number;
  readonly totalCount: number;
  readonly hasMore: boolean;
  readonly isLoading: boolean;
  readonly onLoadMore: () => Promise<unknown>;
  readonly getRevealFocusTarget: (firstRevealedIndex: number) => HTMLElement | null;
}): ReactElement {
  const [failed, setFailed] = useState(false);
  const [reveal, setReveal] = useState<RevealRequest | null>(null);
  const requestVersion = useRef(0);

  useEffect(
    () => () => {
      requestVersion.current += 1;
    },
    [],
  );
  useEffect(() => {
    if (reveal === null) return;
    if (visibleCount < reveal.firstIndex) {
      requestVersion.current += 1;
      setReveal(null);
    } else if (reveal.complete) {
      if (visibleCount > reveal.firstIndex) {
        const target = getRevealFocusTarget(reveal.firstIndex);
        if (target !== null) {
          target.focus();
          setReveal(null);
        }
      } else if (!hasMore && !isLoading) {
        setReveal(null);
      }
    }
  }, [getRevealFocusTarget, hasMore, isLoading, reveal, visibleCount]);
  return (
    <div className="inventory-pagination">
      <p
        aria-live="polite"
        role="status"
      >{`Showing ${visibleCount} of ${totalCount} matching ${itemLabel}`}</p>
      {failed ? <p role="alert">More {itemLabel} could not be loaded. Try again.</p> : null}
      {hasMore ? (
        <Button
          label="Load more"
          isLoading={isLoading}
          onClick={() => {
            setFailed(false);
            requestVersion.current += 1;
            const request = {
              firstIndex: visibleCount,
              version: requestVersion.current,
              complete: false,
            };
            setReveal(request);
            void (async () => {
              try {
                const result = await onLoadMore();
                if (request.version !== requestVersion.current) return;
                setReveal(result === "superseded" ? null : { ...request, complete: true });
              } catch {
                if (request.version !== requestVersion.current) return;
                setReveal(null);
                setFailed(true);
              }
            })();
          }}
        />
      ) : null}
    </div>
  );
}
