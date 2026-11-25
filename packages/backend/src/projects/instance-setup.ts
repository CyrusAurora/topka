// What a new project depends on that the instance's admin switches: collection (COLLECT_ENABLED) and
// article analysis (a real model with MODEL_CALLS_ENABLED; the demo model does not analyse). The
// wizard and the project page say when either is off, so a project never waits silently.
import { realModelConfigured } from "../providers/demo-model.ts";

export interface InstanceSetup {
  collectionOn: boolean;
  analysisOn: boolean;
}

export function instanceSetup(): InstanceSetup {
  return { collectionOn: process.env.COLLECT_ENABLED !== "false", analysisOn: realModelConfigured() };
}
