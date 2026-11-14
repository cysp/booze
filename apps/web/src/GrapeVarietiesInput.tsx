import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { ReactElement } from "react";

export function GrapeVarietiesInput({
  disabled = false,
  name,
  value,
  onChange,
}: {
  readonly disabled?: boolean;
  readonly name: string;
  readonly value: readonly string[];
  readonly onChange: (value: readonly string[]) => void;
}): ReactElement {
  return (
    <fieldset className="form-stack" disabled={disabled}>
      <legend>Grape varieties</legend>
      {value.map((variety, index) => (
        // Each row is an editable draft slot; its index stays stable while typing.
        <div className="field-row" key={index}>
          <TextInput
            htmlName={`${name}.${index}`}
            isDisabled={disabled}
            label={`Grape variety ${index + 1}`}
            value={variety}
            onChange={(next: string) => {
              onChange(value.map((existing, position) => (position === index ? next : existing)));
            }}
          />
          <Button
            isDisabled={disabled}
            label={`Remove grape variety ${index + 1}`}
            variant="secondary"
            onClick={() => {
              onChange(value.filter((_, position) => position !== index));
            }}
          />
        </div>
      ))}
      <Button
        isDisabled={disabled}
        label="Add grape variety"
        variant="secondary"
        onClick={() => {
          onChange([...value, ""]);
        }}
      />
    </fieldset>
  );
}
