import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { ReactElement } from "react";
import { useController, type Control, type FieldPath, type RegisterOptions } from "react-hook-form";

import { validateBottleQuantity } from "../shared/quantity.ts";
import { QuantityInput } from "./QuantityInput.tsx";
import {
  parseOptionalDecimal,
  parseOptionalVolumeMl,
  parseOptionalYear,
  type FormState,
} from "./inventory-model.ts";

export type BottleFormFieldProps = {
  readonly control: Control<FormState>;
  readonly label: string;
  readonly name: FieldPath<FormState>;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly description?: string | undefined;
};

function rulesFor({
  label,
  name,
  required,
  disabled,
}: {
  readonly label: string;
  readonly name: FieldPath<FormState>;
  readonly required: boolean | undefined;
  readonly disabled: boolean | undefined;
}): RegisterOptions<FormState> {
  return {
    validate: (value, values) => {
      if (disabled === true) return true;
      if (typeof value !== "string" || value.trim() === "") {
        return required === true ? `${label} is required.` : true;
      }
      if (["vintageYear", "drinkFromYear", "drinkToYear"].includes(name)) {
        const year = parseOptionalYear(value);
        if (year === undefined || year < 1800 || year > 2200) {
          return `${label} must be a whole year from 1800 to 2200.`;
        }
        const fromYear =
          name === "drinkToYear" ? parseOptionalYear(values.drinkFromYear) : undefined;
        return fromYear !== undefined && fromYear > year
          ? "Drink to must be on or after Drink from."
          : true;
      }
      if (name === "alcoholPercent") {
        const alcohol = parseOptionalDecimal(value);
        return alcohol !== undefined && alcohol >= 0 && alcohol <= 100
          ? true
          : "Alcohol must be a percentage from 0 to 100.";
      }
      if (name === "bottleVolumeMl") {
        const volume = parseOptionalVolumeMl(value);
        return volume !== undefined && volume >= 1 && volume <= 30_000
          ? true
          : "Bottle size must be a whole number from 1 to 30000 ml.";
      }
      return true;
    },
  };
}

export function BottleTextInput({
  control,
  label,
  name,
  placeholder,
  required = false,
  disabled = false,
  description,
}: BottleFormFieldProps): ReactElement {
  const { field, status } = useBottleField({ control, label, name, required, disabled });

  return (
    <TextInput
      ref={field.ref}
      autoComplete="off"
      htmlName={field.name}
      isDisabled={disabled}
      {...(description === undefined ? {} : { description })}
      isRequired={required}
      label={label}
      {...(placeholder === undefined ? {} : { placeholder })}
      {...(status === undefined ? {} : { status })}
      value={field.value}
      onBlur={field.onBlur}
      onChange={field.onChange}
    />
  );
}

export function BottleTextArea({
  control,
  label,
  name,
  placeholder,
  required = false,
  disabled = false,
}: BottleFormFieldProps): ReactElement {
  const { field, status } = useBottleField({ control, label, name, required, disabled });

  return (
    <TextArea
      ref={field.ref}
      htmlName={field.name}
      isDisabled={disabled}
      isRequired={required}
      label={label}
      {...(placeholder === undefined ? {} : { placeholder })}
      {...(status === undefined ? {} : { status })}
      value={field.value}
      onBlur={field.onBlur}
      onChange={field.onChange}
    />
  );
}

function useBottleField({ control, label, name, required, disabled }: BottleFormFieldProps) {
  const { field, fieldState } = useController({
    control,
    name,
    rules: rulesFor({ label, name, required, disabled }),
  });
  return {
    field,
    status:
      fieldState.error === undefined
        ? undefined
        : {
            ...(fieldState.error.message === undefined
              ? {}
              : { message: fieldState.error.message }),
            type: "error" as const,
          },
  };
}

export function BottleQuantityInput({
  control,
}: {
  readonly control: Control<FormState>;
}): ReactElement {
  const { field, fieldState } = useController({
    control,
    name: "quantity",
    rules: {
      validate: (value) => {
        const result = validateBottleQuantity(value);
        return result.ok ? true : result.message;
      },
    },
  });

  return (
    <QuantityInput
      ref={field.ref}
      status={
        fieldState.error === undefined
          ? undefined
          : { message: fieldState.error.message, type: "error" }
      }
      value={field.value}
      onChange={field.onChange}
      onBlur={field.onBlur}
    />
  );
}
