/**
 * The nav keeps the owner's message file apart from Decisions.
 */
import { describe, expect, it } from "vitest";
import { OWNER_MESSAGES_SUBTITLE, VIEWS } from "./nav";

describe("nav", () => {
  it("names the owner's message file 'Owner messages' (route kept), apart from Decisions", () => {
    const label = (id: string) => VIEWS.find((v) => v.id === id)?.label;
    expect(label("inbox")).toBe("Owner messages");
    expect(label("decisions")).toBe("Decisions");
    expect(VIEWS.map((v) => v.label)).not.toContain("Inbox");
    expect(OWNER_MESSAGES_SUBTITLE).toContain("Decisions Lair needs from you are in Decisions");
  });
});
