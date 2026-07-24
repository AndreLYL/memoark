import { Navigate, type RouteObject } from "react-router";
import { Shell } from "./components/layout/shell";
import { LegacyPageRedirect } from "./components/page/LegacyPageRedirect";
import { Dashboard } from "./pages/dashboard";
import { EntityDetail } from "./pages/EntityDetail";
import { FetchPage } from "./pages/fetch/index";
import { GraphPage } from "./pages/graph";
import { PageList } from "./pages/page-list";
import { SearchPage } from "./pages/search";
import { ConfigPage } from "./pages/config/index";
import { SetupWizard } from "./pages/setup/index";
import { TimelinePage } from "./pages/Timeline";

export const appRoutes: RouteObject[] = [
  { path: "setup", element: <SetupWizard /> },
  {
    element: <Shell />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: "timeline", element: <TimelinePage /> },
      { path: "fetch", element: <FetchPage /> },
      { path: "graph", element: <GraphPage /> },
      { path: "entity/*", element: <EntityDetail /> },
      { path: "entities", element: <PageList /> },
      { path: "pages", element: <Navigate to="/entities" replace /> },
      { path: "pages/*", element: <LegacyPageRedirect /> },
      { path: "search", element: <SearchPage /> },
      { path: "config", element: <ConfigPage /> },
    ],
  },
];
