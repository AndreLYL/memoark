import { describe, expect, it, vi } from "vitest";

vi.mock("../../web/src/pages/graph", () => ({
  GraphPage: () => null,
}));

import { SIDEBAR_FOOTER_ITEMS } from "../../web/src/components/layout/sidebar";
import { appRoutes } from "../../web/src/routes";

describe("web routes", () => {
  it("keeps /config under the Shell layout", () => {
    const shellRoute = appRoutes.find((route) => Array.isArray(route.children));
    expect(shellRoute?.children?.some((child) => child.path === "config")).toBe(true);
    expect(appRoutes.some((route) => route.path === "config")).toBe(false);
  });

  it("exposes a Settings sidebar item that navigates to /config", () => {
    expect(SIDEBAR_FOOTER_ITEMS).toContainEqual(
      expect.objectContaining({ to: "/config", label: "Settings" }),
    );
  });
});
