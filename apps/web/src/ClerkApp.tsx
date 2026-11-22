import { ClerkProvider, RedirectToSignIn, Show, UserButton, useAuth } from "@clerk/react";
import { lazy, useCallback, type ReactElement } from "react";

import { CatalogueLoadBoundary } from "./LazyLoadErrorBoundary.tsx";

const Catalogue = lazy(async () => {
  const module = await import("./App.tsx");
  return { default: module.Catalogue };
});

export function ClerkApp({ publishableKey }: { readonly publishableKey: string }): ReactElement {
  return (
    <ClerkProvider publishableKey={publishableKey}>
      <Show when="signed-out">
        <RedirectToSignIn />
      </Show>
      <Show when="signed-in">
        <ClerkCatalogue />
      </Show>
    </ClerkProvider>
  );
}

function ClerkCatalogue(): ReactElement {
  const { getToken, userId } = useAuth();
  const getAuthHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const token = await getToken();
    if (token === null) {
      throw new Error("No Clerk session token available");
    }
    return { authorization: `Bearer ${token}` };
  }, [getToken]);

  if (userId === null || userId === undefined) return <></>;
  return (
    <CatalogueLoadBoundary>
      <Catalogue
        additionScope={userId}
        authControl={<UserButton />}
        authMode="clerk"
        getAuthHeaders={getAuthHeaders}
      />
    </CatalogueLoadBoundary>
  );
}
