import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { ReactElement } from "react";
import { useController, type Control, type RegisterOptions } from "react-hook-form";

import { validateBottleQuantity } from "../shared/quantity.ts";
import { QuantityInput } from "./QuantityInput.tsx";
import {
  parseOptionalDecimal,
  parseOptionalVolumeMl,
  parseOptionalYear,
  type FormState,
} from "./inventory-model.ts";

type BottleTextField = {
  [Name in keyof FormState]: FormState[Name] extends string ? Name : never;
}[keyof FormState];

export type BottleFormFieldProps = {
  readonly control: Control<FormState>;
  readonly label: string;
  readonly name: BottleTextField;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly description?: string | undefined;
  readonly originalForm?: FormState | undefined;
};

function isUnchangedField(
  name: BottleTextField,
  value: unknown,
  values: FormState,
  original: FormState | undefined,
): boolean {
  if (original === undefined || original[name] !== value) return false;
  if (name !== "drinkFromYear" && name !== "drinkToYear") return true;
  return (
    values.drinkFromYear === original.drinkFromYear && values.drinkToYear === original.drinkToYear
  );
}

function validateYear(
  name: BottleTextField,
  label: string,
  value: string,
  values: FormState,
): string | true {
  const year = parseOptionalYear(value);
  if (year === undefined || year < 1800 || year > 2200)
    return `${label} must be a whole year from 1800 to 2200.`;
  const fromYear = name === "drinkToYear" ? parseOptionalYear(values.drinkFromYear) : undefined;
  return fromYear !== undefined && fromYear > year
    ? "Drink to must be on or after Drink from."
    : true;
}

function rulesFor({
  label,
  name,
  required,
  disabled,
  originalForm,
}: {
  readonly label: string;
  readonly name: BottleTextField;
  readonly required: boolean | undefined;
  readonly disabled: boolean | undefined;
  readonly originalForm: FormState | undefined;
}): RegisterOptions<FormState, BottleTextField> {
  return {
    validate: (value, values) => {
      if (disabled === true) return true;
      if (isUnchangedField(name, value, values, originalForm)) return true;
      if (typeof value !== "string" || value.trim() === "") {
        return required === true ? `${label} is required.` : true;
      }
      if (["vintageYear", "drinkFromYear", "drinkToYear"].includes(name))
        return validateYear(name, label, value, values);
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
  originalForm,
}: BottleFormFieldProps): ReactElement {
  const { field, status } = useBottleField({
    control,
    label,
    name,
    required,
    disabled,
    originalForm,
  });

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
  originalForm,
}: BottleFormFieldProps): ReactElement {
  const { field, status } = useBottleField({
    control,
    label,
    name,
    required,
    disabled,
    originalForm,
  });

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

function useBottleField({
  control,
  label,
  name,
  required,
  disabled,
  originalForm,
}: BottleFormFieldProps) {
  const { field, fieldState } = useController({
    control,
    name,
    rules: rulesFor({ label, name, required, disabled, originalForm }),
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
