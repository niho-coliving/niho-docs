import { describe, expect, it } from "vitest";

import { DEFAULT_EXECUTION_PREFERENCES, parseExecutionPreferences } from "../src/execution-preferences.js";

describe("execution preferences", () => {
  it("reads a cloud route without retaining a Mac target", () => {
    expect(parseExecutionPreferences({ version: 1, route: "cloud", preferredMacRunnerId: "runner_1" })).toEqual(DEFAULT_EXECUTION_PREFERENCES);
  });

  it("reads an own-Mac route and its explicit target", () => {
    expect(parseExecutionPreferences({ version: 1, route: "own_mac", preferredMacRunnerId: "runner_1" })).toEqual({
      version: 1,
      route: "own_mac",
      preferredMacRunnerId: "runner_1",
    });
  });

  it("keeps own-Mac unavailable when the target is absent or invalid", () => {
    expect(parseExecutionPreferences({ version: 1, route: "own_mac" })).toMatchObject({ route: "own_mac", preferredMacRunnerId: null });
    expect(parseExecutionPreferences({ version: 1, route: "own_mac", preferredMacRunnerId: "../other" })).toMatchObject({ route: "own_mac", preferredMacRunnerId: null });
  });

  it("uses cloud for missing, corrupt, or unknown data without legacy migration", () => {
    for (const value of [null, "own_mac", { route: "own_mac" }, { version: 2, route: "own_mac", preferredMacRunnerId: "runner_1" }]) {
      expect(parseExecutionPreferences(value)).toEqual(DEFAULT_EXECUTION_PREFERENCES);
    }
  });
});
