import { TextInput } from "@astryxdesign/core/TextInput";
import type { ReactElement, Ref } from "react";

import { MIN_BOTTLE_QUANTITY, MAX_BOTTLE_QUANTITY } from "../shared/quantity.ts";

export function QuantityInput({
  ref,
  value,
  onChange,
  onBlur,
  status,
}: {
  readonly ref?: Ref<HTMLInputElement>;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onBlur: () => void;
  readonly status?: { readonly message?: string | undefined; readonly type: "error" } | undefined;
}): ReactElement {
  return (
    <TextInput
      {...(ref === undefined ? {} : { ref })}
      hasClear
      isRequired
      htmlName="quantity"
      inputMode="numeric"
      autoComplete="off"
      label="Quantity"
      description={`Between ${MIN_BOTTLE_QUANTITY} and ${MAX_BOTTLE_QUANTITY} bottles.`}
      value={value}
      {...(status === undefined
        ? {}
        : {
            status: {
              type: status.type,
              ...(status.message === undefined ? {} : { message: status.message }),
            },
          })}
      onChange={onChange}
      onBlur={onBlur}
    />
  );
}
