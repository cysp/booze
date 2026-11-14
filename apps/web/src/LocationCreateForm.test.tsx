import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { initialLocationFormState } from "./inventory-model.ts";
import { LocationCreateForm } from "./LocationCreateForm.tsx";
import { sitesFixture } from "./test/catalogue-fixtures.ts";

describe("LocationCreateForm", () => {
  it("blocks same-tick duplicate submissions", () => {
    const onSaveLocation = vi.fn(
      async () =>
        new Promise<boolean>((resolve) => {
          void resolve;
        }),
    );
    render(
      <LocationCreateForm
        form={{
          ...initialLocationFormState,
          location: "Left rack",
          site: sitesFixture[0]?.name ?? "",
          siteId: sitesFixture[0]?.id ?? "",
        }}
        locations={[]}
        sites={sitesFixture}
        updateLocationField={(field, value) => {
          void field;
          void value;
        }}
        onSaveLocation={onSaveLocation}
      />,
    );
    const form = screen.getByRole("button", { name: "Save location" }).closest("form");
    if (form === null) {
      throw new Error("Save location button was not inside a form.");
    }

    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(onSaveLocation).toHaveBeenCalledTimes(1);
  });
});
