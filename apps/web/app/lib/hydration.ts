// Server-rendered content must be visible without JavaScript. Entrance animations therefore only
// play for components mounted after hydration (client-side navigation, loaded-more content).
import { useEffect, useState } from "react";

let hydrated = false;

export function useHydratedFlag() {
  useEffect(() => {
    hydrated = true;
  }, []);
}
