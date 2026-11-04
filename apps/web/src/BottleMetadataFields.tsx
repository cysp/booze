import { Button } from "@astryxdesign/core/Button";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { ReactElement, ReactNode } from "react";

import type { AwardDraft, AwardErrors, ReviewErrors } from "./bottle-metadata.ts";
import type { CriticReviewInput } from "./inventory-model.ts";

export function CriticReviewFields({
  errors,
  reviews,
  onChange,
}: {
  readonly errors: readonly ReviewErrors[];
  readonly reviews: readonly CriticReviewInput[];
  readonly onChange: (reviews: readonly CriticReviewInput[]) => void;
}): ReactElement {
  const update = (index: number, patch: Partial<CriticReviewInput>): void => {
    onChange(
      reviews.map((review, reviewIndex) =>
        reviewIndex === index ? { ...review, ...patch } : review,
      ),
    );
  };
  return (
    <MetadataSection title="Critic reviews">
      <div className="section-heading">
        <p className="field-hint">Record ratings and your own source notes.</p>
        <Button
          label="Add review"
          onClick={() => {
            onChange([...reviews, { ratingText: "", reviewSourceName: "" }]);
          }}
        />
      </div>
      {reviews.length === 0 ? (
        <p className="field-hint">No critic reviews recorded.</p>
      ) : (
        <div className="review-edit-list">
          {reviews.map((review, index) => {
            const error = errors[index];
            return (
              <div className="review-edit-row" key={review.id ?? `review-${index}`}>
                <div className="field-row">
                  <TextInput
                    autoComplete="off"
                    data-repeatable-error={
                      error?.reviewSourceName === undefined ? undefined : "true"
                    }
                    htmlName={`criticReviews.${index}.reviewSourceName`}
                    isRequired
                    label="Source"
                    placeholder="Halliday Wine Companion"
                    {...(error?.reviewSourceName === undefined
                      ? {}
                      : { status: { message: error.reviewSourceName, type: "error" } })}
                    value={review.reviewSourceName ?? ""}
                    onChange={(value: string) => {
                      update(index, { reviewSourceName: value, reviewSourceId: undefined });
                    }}
                  />
                  <TextInput
                    autoComplete="off"
                    data-repeatable-error={error?.ratingText === undefined ? undefined : "true"}
                    htmlName={`criticReviews.${index}.ratingText`}
                    isRequired
                    label="Rating"
                    placeholder="95 points"
                    {...(error?.ratingText === undefined
                      ? {}
                      : { status: { message: error.ratingText, type: "error" } })}
                    value={review.ratingText}
                    onChange={(value: string) => {
                      update(index, { ratingText: value });
                    }}
                  />
                  <TextInput
                    autoComplete="url"
                    htmlName={`criticReviews.${index}.sourceUrl`}
                    label="Source URL"
                    placeholder="https://example.com/review"
                    value={review.sourceUrl ?? ""}
                    onChange={(value: string) => {
                      update(index, { sourceUrl: value });
                    }}
                  />
                  <TextInput
                    autoComplete="off"
                    htmlName={`criticReviews.${index}.provenance`}
                    label="Provenance"
                    placeholder="Guide, database, or note"
                    value={review.provenance ?? ""}
                    onChange={(value: string) => {
                      update(index, { provenance: value });
                    }}
                  />
                </div>
                <TextArea
                  htmlName={`criticReviews.${index}.notes`}
                  label="Notes"
                  value={review.notes ?? ""}
                  onChange={(value: string) => {
                    update(index, { notes: value });
                  }}
                />
                <Button
                  label="Remove review"
                  variant="destructive"
                  onClick={() => {
                    onChange(reviews.filter((_, reviewIndex) => reviewIndex !== index));
                  }}
                />
              </div>
            );
          })}
        </div>
      )}
    </MetadataSection>
  );
}

export function AwardFields({
  awards,
  errors,
  onChange,
}: {
  readonly awards: readonly AwardDraft[];
  readonly errors: readonly AwardErrors[];
  readonly onChange: (awards: readonly AwardDraft[]) => void;
}): ReactElement {
  const update = (index: number, patch: Partial<AwardDraft>): void => {
    onChange(
      awards.map((award, awardIndex) => (awardIndex === index ? { ...award, ...patch } : award)),
    );
  };
  return (
    <MetadataSection title="Awards">
      <div className="section-heading">
        <p className="field-hint">Track medals, competitions, and source context.</p>
        <Button
          label="Add award"
          onClick={() => {
            onChange([...awards, { awardLevel: "", awardName: "", awardYear: "", points: "" }]);
          }}
        />
      </div>
      {awards.length === 0 ? (
        <p className="field-hint">No awards recorded.</p>
      ) : (
        <div className="review-edit-list">
          {awards.map((award, index) => {
            const error = errors[index];
            return (
              <div className="review-edit-row" key={award.id ?? `award-${index}`}>
                <div className="field-row">
                  <AwardTextInput
                    error={error?.awardLevel}
                    htmlName={`awards.${index}.awardLevel`}
                    isRequired
                    label="Award"
                    placeholder="Gold Medal"
                    value={award.awardLevel}
                    onChange={(value) => {
                      update(index, { awardLevel: value });
                    }}
                  />
                  <AwardTextInput
                    error={error?.awardYear}
                    htmlName={`awards.${index}.awardYear`}
                    label="Year"
                    placeholder="2024"
                    value={award.awardYear}
                    onChange={(value) => {
                      update(index, { awardYear: value });
                    }}
                  />
                  <AwardTextInput
                    error={error?.awardName}
                    htmlName={`awards.${index}.awardName`}
                    isRequired
                    label="Competition or source"
                    value={award.awardName}
                    onChange={(value) => {
                      update(index, { awardName: value });
                    }}
                  />
                  <AwardTextInput
                    htmlName={`awards.${index}.awardBody`}
                    label="Body"
                    value={award.awardBody ?? ""}
                    onChange={(value) => {
                      update(index, { awardBody: value });
                    }}
                  />
                  <AwardTextInput
                    htmlName={`awards.${index}.category`}
                    label="Class or category"
                    value={award.category ?? ""}
                    onChange={(value) => {
                      update(index, { category: value });
                    }}
                  />
                  <AwardTextInput
                    error={error?.points}
                    htmlName={`awards.${index}.points`}
                    label="Points"
                    value={award.points}
                    onChange={(value) => {
                      update(index, { points: value });
                    }}
                  />
                  <AwardTextInput
                    htmlName={`awards.${index}.sourceUrl`}
                    label="Source URL"
                    value={award.sourceUrl ?? ""}
                    onChange={(value) => {
                      update(index, { sourceUrl: value });
                    }}
                  />
                  <AwardTextInput
                    htmlName={`awards.${index}.provenance`}
                    label="Provenance"
                    value={award.provenance ?? ""}
                    onChange={(value) => {
                      update(index, { provenance: value });
                    }}
                  />
                </div>
                <TextArea
                  htmlName={`awards.${index}.notes`}
                  label="Notes"
                  value={award.notes ?? ""}
                  onChange={(value: string) => {
                    update(index, { notes: value });
                  }}
                />
                <Button
                  label="Remove award"
                  variant="destructive"
                  onClick={() => {
                    onChange(awards.filter((_, awardIndex) => awardIndex !== index));
                  }}
                />
              </div>
            );
          })}
        </div>
      )}
    </MetadataSection>
  );
}

function AwardTextInput({
  error,
  htmlName,
  isRequired = false,
  label,
  placeholder,
  value,
  onChange,
}: {
  readonly error?: string | undefined;
  readonly htmlName: string;
  readonly isRequired?: boolean;
  readonly label: string;
  readonly placeholder?: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}): ReactElement {
  return (
    <TextInput
      autoComplete="off"
      data-repeatable-error={error === undefined ? undefined : "true"}
      htmlName={htmlName}
      isRequired={isRequired}
      label={label}
      {...(placeholder === undefined ? {} : { placeholder })}
      {...(error === undefined ? {} : { status: { message: error, type: "error" } })}
      value={value}
      onChange={onChange}
    />
  );
}

function MetadataSection({
  children,
  title,
}: {
  readonly children: ReactNode;
  readonly title: string;
}): ReactElement {
  return (
    <section className="form-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
