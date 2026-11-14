import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { useRef, useState, type ReactElement, type ReactNode } from "react";
import { BottleModal } from "./BottleModal.tsx";
import { DestructiveActionDialog } from "./DestructiveActionDialog.tsx";
import type {
  BottleActionKind,
  BottleModalSubmit,
  BottleModalSubmitResult,
} from "./bottle-payload.ts";
import type { InventoryItem, LocationItem, SiteItem } from "./inventory-model.ts";
import type { AuthHeadersProvider } from "./useReadPage.ts";

type DetailAction = BottleActionKind | "consume" | "restore" | "delete";
type BottleDetailsProps = {
  readonly item: InventoryItem;
  readonly canEdit: boolean;
  readonly isSaving: boolean;
  readonly getAuthHeaders: AuthHeadersProvider;
  readonly locations: readonly LocationItem[];
  readonly sites: readonly SiteItem[];
  readonly onClose: () => void;
  readonly onDelete: () => Promise<boolean>;
  readonly onStatusChange: (status: "in_stock" | "consumed") => Promise<boolean>;
  readonly onSubmit: (submission: BottleModalSubmit) => Promise<BottleModalSubmitResult>;
};

export function BottleDetails({
  item,
  canEdit,
  isSaving,
  getAuthHeaders,
  locations,
  sites,
  onClose,
  onDelete,
  onStatusChange,
  onSubmit,
}: BottleDetailsProps): ReactElement {
  const [action, setAction] = useState<DetailAction | null>(null);
  const returnAction = useRef<DetailAction | null>(null);
  function returnToDetails(): void {
    setAction(null);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(`[data-bottle-action='${returnAction.current ?? ""}']`)
          ?.focus();
      });
    });
  }
  function chooseAction(next: DetailAction): void {
    returnAction.current = next;
    setAction(next);
  }

  if (action === "delete")
    return (
      <DestructiveActionDialog
        actionLabel="Delete bottle"
        description="This permanently removes this physical bottle and its inventory record. The shared wine facts, reviews and awards remain stored. This bottle’s extraction record is removed with the bottle. This action cannot be undone."
        failureMessage="Bottle was not deleted. Try again."
        isOpen
        title="Delete this bottle?"
        onAction={onDelete}
        onOpenChange={(open) => {
          if (!open) returnToDetails();
        }}
        onSuccess={onClose}
      />
    );
  if (action === "consume" || action === "restore")
    return (
      <BottleStatusAction
        key={action}
        consume={action === "consume"}
        onClose={returnToDetails}
        onAction={async () => onStatusChange(action === "consume" ? "consumed" : "in_stock")}
      />
    );
  if (action !== null)
    return (
      <BottleModal
        key={action}
        action={{ kind: action, item }}
        getAuthHeaders={getAuthHeaders}
        isSaving={isSaving}
        locations={locations}
        sites={sites}
        onClose={returnToDetails}
        onSubmit={onSubmit}
      />
    );
  return (
    <Dialog
      aria-label="Bottle details"
      isOpen
      maxHeight="calc(100dvh - 32px)"
      width="min(920px, calc(100vw - 32px))"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogHeader
        title="Bottle details"
        subtitle={`${item.vintageLabel} ${item.displayName}`}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      />
      <div className="form-stack bottle-details">
        {canEdit ? (
          <div className="dialog-actions" aria-label="Bottle actions">
            {item.status === "in_stock" ? (
              <Button
                data-bottle-action="move"
                label="Move"
                onClick={() => {
                  chooseAction("move");
                }}
              />
            ) : null}
            {item.status === "consumed" ? (
              <Button
                data-bottle-action="restore"
                label="Restore to inventory"
                onClick={() => {
                  chooseAction("restore");
                }}
              />
            ) : item.status === "in_stock" ? (
              <Button
                data-bottle-action="consume"
                label="Mark consumed"
                onClick={() => {
                  chooseAction("consume");
                }}
              />
            ) : null}
            <Button
              data-bottle-action="edit-bottle"
              label="Edit bottle facts"
              onClick={() => {
                chooseAction("edit-bottle");
              }}
            />
            <Button
              data-bottle-action="correct-wine"
              label="Correct shared wine"
              onClick={() => {
                chooseAction("correct-wine");
              }}
            />
            <Button
              data-bottle-action="reassign"
              label="Reassign this bottle"
              onClick={() => {
                chooseAction("reassign");
              }}
            />
            <Button
              data-bottle-action="delete"
              label="Delete bottle"
              variant="destructive"
              onClick={() => {
                chooseAction("delete");
              }}
            />
          </div>
        ) : null}
        <FactSection
          title="Physical bottle"
          facts={[
            ["Bottle ID", item.id],
            ["Bottle number", item.bottleNumber],
            [
              "Status",
              item.status === "in_stock"
                ? "In stock"
                : item.status === "consumed"
                  ? "Consumed"
                  : item.status,
            ],
            ["Bottle size (ml)", item.volumeMl],
            ["Barcode", item.barcode],
            ["Lot code", item.lotCode],
            ["Bottle notes", item.bottleNotes],
            ["Site", item.siteName],
            ["Location", item.storageLocationName],
            ["Position note", item.positionHint],
            ["Added", item.createdAt],
          ]}
        />
        <FactSection
          title="Wine facts"
          facts={[
            ["Linked bottles", item.wineBottleCount],
            ["Winery", item.wineryName],
            ["Label / brand", item.brandName],
            ["Designation", item.designation],
            ["Vintage", item.vintageLabel],
            ["Grape varieties", item.grapeVarieties.join(", ")],
            ["Country", item.country],
            ["Region", item.region],
            ["Appellation", item.appellation],
            ["Classification", item.classification],
            ["Style", item.wineType],
            ["Colour", item.wineColor],
            ["Producer address", item.addressQualification],
            ["Alcohol (%)", item.alcoholPercent],
            ["Drink from", item.drinkFromYear],
            ["Drink to", item.drinkToYear],
          ]}
        />
        <FactSection
          title="Wine reference and source evidence"
          facts={[
            ["Description", item.description],
            ["Drinking advice", item.drinkingAdvice],
            ["Label text", item.labelText],
            ["Wine notes", item.wineNotes],
            ["Source URL", <SourceValue key="wine-source" value={item.sourceUrl} />],
          ]}
        />
        <details className="form-section">
          <summary>Record details</summary>
          <FactSection
            title="Catalogue record"
            facts={[
              ["Site ID", item.siteId],
              ["Location ID", item.storageLocationId],
              ["Wine record ID", item.wineVintageId],
              ["Winery ID", item.wineryId],
              ["Display name", item.displayName],
              ["Base name", item.baseName],
              ["Vintage status", item.vintageStatus],
              ["Vintage year", item.vintageYear],
            ]}
          />
          {item.criticReviews.map((review) => (
            <FactSection
              key={review.id}
              title={`${review.reviewSourceName} record`}
              facts={[
                ["Review ID", review.id],
                ["Source ID", review.reviewSourceId],
                ["Site ID", review.siteId],
                ["Wine record ID", review.wineVintageId],
              ]}
            />
          ))}
          {item.awards.map((award) => (
            <FactSection
              key={award.id}
              title={`${award.awardName} record`}
              facts={[
                ["Award ID", award.id],
                ["Site ID", award.siteId],
                ["Wine record ID", award.wineVintageId],
              ]}
            />
          ))}
        </details>
        <section className="form-section">
          <h3>Critic reviews</h3>
          {item.criticReviews.length === 0 ? (
            <p>No critic reviews recorded.</p>
          ) : (
            item.criticReviews.map((review) => (
              <FactSection
                key={review.id}
                title={`${review.reviewSourceName}: ${review.ratingText}`}
                facts={[
                  ["Source", review.reviewSourceName],
                  ["Rating", review.ratingText],
                  ["Rating value", review.ratingValue],
                  ["Rating scale", review.ratingScale],
                  ["Source URL", <SourceValue key={review.id} value={review.sourceUrl} />],
                  ["Reviewed", review.reviewedAt],
                  ["Provenance", review.provenance],
                  ["Notes", review.notes],
                  ["Created", review.createdAt],
                  ["Updated", review.updatedAt],
                ]}
              />
            ))
          )}
        </section>
        <section className="form-section">
          <h3>Awards</h3>
          {item.awards.length === 0 ? (
            <p>No awards recorded.</p>
          ) : (
            item.awards.map((award) => (
              <FactSection
                key={award.id}
                title={`${award.awardName}: ${award.awardLevel}`}
                facts={[
                  ["Competition or source", award.awardName],
                  ["Award", award.awardLevel],
                  ["Year", award.awardYear],
                  ["Award body", award.awardBody],
                  ["Category", award.category],
                  ["Points", award.points],
                  ["Source URL", <SourceValue key={award.id} value={award.sourceUrl} />],
                  ["Provenance", award.provenance],
                  ["Notes", award.notes],
                  ["Created", award.createdAt],
                  ["Updated", award.updatedAt],
                ]}
              />
            ))
          )}
        </section>
      </div>
    </Dialog>
  );
}

function FactSection({
  title,
  facts,
}: {
  readonly title: string;
  readonly facts: readonly (readonly [string, ReactNode])[];
}): ReactElement {
  return (
    <section className="form-section">
      <h3>{title}</h3>
      <dl className="bottle-details-facts">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              {value === null || value === undefined || value === "" ? "Not recorded" : value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function SourceValue({ value }: { readonly value: string | null }): ReactElement {
  if (value === null || value === "") return <>Not recorded</>;
  return /^https?:\/\//iu.test(value) ? (
    <a href={value} target="_blank" rel="noopener noreferrer">
      {value}
    </a>
  ) : (
    <>{value}</>
  );
}

function BottleStatusAction({
  consume,
  onAction,
  onClose,
}: {
  readonly consume: boolean;
  readonly onAction: () => Promise<boolean>;
  readonly onClose: () => void;
}): ReactElement {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const label = consume ? "Mark consumed" : "Restore to inventory";
  async function submit(): Promise<void> {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      if (await onAction()) onClose();
      else setError("Bottle status was not updated. Try again.");
    } catch {
      setError("Bottle status was not updated. Check your connection and try again.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  return (
    <Dialog
      aria-label={label}
      isOpen
      width="min(520px, calc(100vw - 32px))"
      onOpenChange={(open) => {
        if (!open && !pendingRef.current) onClose();
      }}
    >
      <DialogHeader
        title={label}
        onOpenChange={(open) => {
          if (!open && !pendingRef.current) onClose();
        }}
      />
      <p>
        {consume
          ? "This physical bottle will leave in-stock inventory and remain available in consumed history. Its wine facts and source evidence stay stored."
          : "This physical bottle will return to in-stock inventory with its existing wine facts, location and notes."}
      </p>
      {error === null ? null : <Banner role="alert" status="error" title={error} />}
      <div className="dialog-actions">
        <Button label="Cancel" isDisabled={pending} onClick={onClose} />
        <Button
          label={label}
          isDisabled={pending}
          isLoading={pending}
          variant="primary"
          onClick={() => {
            void submit();
          }}
        />
      </div>
    </Dialog>
  );
}
