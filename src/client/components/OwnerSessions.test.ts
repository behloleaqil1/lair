import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OwnerSessionList, OwnerSessions } from "./OwnerSessions";

describe("OwnerSessions", () => {
  it("lists signed-in browsers, marks this one, and offers to sign each out", () => {
    const html = renderToStaticMarkup(
      createElement(OwnerSessionList, {
        sessions: [
          {
            id: "0b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b",
            createdAt: "2026-03-02T11:00:00.000Z",
            lastUsedAt: "2026-03-02T12:00:00.000Z",
            userAgent: "ThisBrowser/1.0",
            current: true,
          },
          {
            id: "1b5c2c3e-7a43-4f7e-9d2a-0d4b1f2e3a4b",
            createdAt: "2026-03-01T11:00:00.000Z",
            lastUsedAt: "2026-03-01T12:00:00.000Z",
            userAgent: "",
          },
        ],
        busy: false,
        onRevoke: () => undefined,
      }),
    );
    expect(html).toContain("ThisBrowser/1.0");
    expect(html).toContain("this browser");
    expect(html).toContain("unknown browser");
    expect(html.match(/>Sign out</g)).toHaveLength(2);
  });

  it("starts collapsed, with a way to show the list", () => {
    const html = renderToStaticMarkup(createElement(OwnerSessions, { onSignedOut: () => undefined }));
    expect(html).toContain("Signed-in browsers");
    expect(html).toContain(">Show<");
    expect(html).not.toContain('data-owner-sessions="list"');
  });
});
