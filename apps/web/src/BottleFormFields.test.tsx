import { Button } from "@astryxdesign/core/Button";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";

import { initialFormState, type FormState } from "./inventory-model.ts";
import { BottleQuantityInput, BottleTextInput } from "./BottleFormFields.tsx";

function Harness({
  defaults = initialFormState,
  onSubmit = vi.fn(),
}: {
  readonly defaults?: FormState;
  readonly onSubmit?: (values: FormState) => void;
}): ReactElement {
  const { control, handleSubmit } = useForm<FormState>({ defaultValues: defaults });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit((values) => {
          onSubmit(values);
        })(event);
      }}
    >
      <BottleTextInput required control={control} label="Winery" name="wineryName" />
      <BottleQuantityInput control={control} />
      <Button label="Save" type="submit" />
    </form>
  );
}

describe("ASTRYX react-hook-form fields", () => {
  it("forwards the HTML name and value to submission", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <Harness
        onSubmit={(values) => {
          onSubmit(values);
        }}
      />,
    );

    const winery = screen.getByRole("textbox", { name: /winery/iu });
    expect(winery).toHaveAttribute("name", "wineryName");
    await user.type(winery, "Rowlee Wines");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: "1", wineryName: "Rowlee Wines" }),
    );
  });

  it("shows required status and focuses the first invalid field", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await within(container).findByText("Winery is required.")).toBeVisible();
    expect(screen.getByRole("textbox", { name: /winery/iu })).toHaveAccessibleDescription(
      "Winery is required.",
    );
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: /winery/iu })).toHaveFocus();
    });
  });

  it("captures an invalid typed quantity on blur instead of submitting the old value", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <Harness
        defaults={{ ...initialFormState, wineryName: "Rowlee Wines" }}
        onSubmit={(values) => {
          onSubmit(values);
        }}
      />,
    );

    const quantity = screen.getByRole("textbox", { name: /quantity/iu });
    fireEvent.change(quantity, { target: { value: "25" } });
    fireEvent.blur(quantity);
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(quantity).not.toHaveValue("1");
    expect(await screen.findByText("Quantity must be a whole number from 1 to 24.")).toBeVisible();
  });
});

describe("quantity drafts", () => {
  it("preserves pasted full-width digits through form submission", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <Harness
        defaults={{ ...initialFormState, wineryName: "Rowlee Wines" }}
        onSubmit={(values) => {
          onSubmit(values);
        }}
      />,
    );
    const quantity = screen.getByRole("textbox", { name: /quantity/iu });
    await user.click(quantity);
    await user.clear(quantity);
    await user.paste("１２");
    await user.tab();
    expect(quantity).toHaveValue("１２");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ quantity: "１２" }));
  });
  it("rejects a fractional draft instead of submitting the old value", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <Harness
        defaults={{ ...initialFormState, wineryName: "Rowlee Wines" }}
        onSubmit={(values) => {
          onSubmit(values);
        }}
      />,
    );
    const quantity = screen.getByRole("textbox", { name: /quantity/iu });
    await user.clear(quantity);
    await user.type(quantity, "1.5");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(quantity).not.toHaveValue("1");
    expect(await screen.findByText("Quantity must be a whole number from 1 to 24.")).toBeVisible();
  });
});
