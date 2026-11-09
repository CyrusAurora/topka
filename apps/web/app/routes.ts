import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";
import { LEGACY_PATHS } from "./lib/legacy-paths";

export default [
  // 今日 (the reader's own Top 3) is the home page; /today stays as an alias.
  index("routes/magazine-today.tsx"),
  route("today", "routes/magazine-today.tsx", { id: "today-alias" }),
  // An old public item link (RSS readers, API links) goes to the original article.
  route("items/:id", "routes/item-redirect.tsx", { id: "item-redirect" }),
  route("items/:id/original", "routes/item-redirect.tsx", { id: "item-original-redirect" }),
  // The retired Topka timeline pages answer a permanent redirect to 今日 or 往期 (routes/legacy.tsx).
  ...LEGACY_PATHS.map((path, i) => route(path, "routes/legacy.tsx", { id: `legacy-${i}` })),
  route("about", "routes/about.tsx"),
  route("terms", "routes/terms.tsx"),
  route("privacy", "routes/privacy.tsx"),
  route("feedback", "routes/feedback.tsx"),
  route("login", "routes/login.tsx"),
  route("register", "routes/register.tsx"),
  route("projects", "routes/projects.tsx"),
  route("projects/new", "routes/projects-new.tsx"),
  route("archive", "routes/archive.tsx"),
  route("issue/:date", "routes/issue.tsx"),
  route("chat", "routes/chat.tsx"),
  route("settings", "routes/settings.tsx"),
  route("today/:projectId", "routes/today.tsx"),
  route("admin/login", "routes/admin-login.tsx"),
  layout("routes/admin/layout.tsx", { id: "admin-layout" }, [
    route("admin", "routes/admin/index.tsx"),
    route("admin/content", "routes/admin/content.tsx"),
    route("admin/content/:id", "routes/admin/content-item.tsx"),
    route("admin/sources", "routes/admin/sources.tsx"),
    route("admin/sources/new", "routes/admin/source-new.tsx"),
    route("admin/sources/:id", "routes/admin/source.tsx"),
    route("admin/monitor", "routes/admin/monitor.tsx"),
    route("admin/feedback", "routes/admin/feedback.tsx"),
    route("admin/runs", "routes/admin/runs.tsx"),
    route("admin/models", "routes/admin/models.tsx"),
    route("admin/selectbench", "routes/admin/selectbench.tsx"),
    route("admin/selectbench/:runId", "routes/admin/selectbench-run.tsx"),
    route("admin/settings", "routes/admin/settings.tsx"),
    route("admin/audit", "routes/admin/audit.tsx"),
  ]),
] satisfies RouteConfig;
