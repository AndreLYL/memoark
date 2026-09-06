import type { GraphStore } from "../store/graph.js";
import type { PageStore } from "../store/pages.js";
import type { TagStore } from "../store/tags.js";
import type { TimelineStore } from "../store/timeline.js";

interface ContextStores {
  pages: PageStore;
  graph: GraphStore;
  tags: TagStore;
  timeline: TimelineStore;
}

export async function getSessionContext(stores: ContextStores, days = 7): Promise<string> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const [projects, decisions, allTasks, prefs, entities] = await Promise.all([
    stores.pages.listPages({
      type: "project",
      sort: "signal_time",
      order: "desc",
      source_from: since,
      limit: 5,
    }),
    stores.pages.listPages({
      type: "decision",
      sort: "signal_time",
      order: "desc",
      source_from: since,
      limit: 5,
    }),
    stores.pages.listPages({ type: "task", sort: "updated_at", order: "desc", limit: 50 }),
    stores.pages.listPages({ type: "preference", sort: "updated_at", order: "desc", limit: 10 }),
    stores.pages.listPages({ type: "person", sort: "updated_at", order: "desc", limit: 5 }),
  ]);

  // Filter tasks to open ones
  const openTasks = allTasks.filter((t) => (t.frontmatter.status as string | undefined) === "open");

  const lines: string[] = [`## 近期工作概览（最近 ${days} 天）`, ""];

  if (projects.length > 0) {
    lines.push(`**近期有来源活动的项目**：${projects.map((p) => p.slug).join(", ")}`);
  }

  if (decisions.length > 0) {
    lines.push(`**近期提及的决策**（最近 ${Math.min(decisions.length, 3)} 条，日期为来源时间）：`);
    for (const d of decisions.slice(0, 3)) {
      const date = d.activity_time?.slice(0, 10);
      if (date) lines.push(`- ${date} ${d.title}`);
    }
  }

  if (openTasks.length > 0) {
    lines.push(`**待办**（当前状态，不限时间窗；open tasks，共 ${openTasks.length} 条）：`);
    for (const t of openTasks.slice(0, 5)) {
      lines.push(`- ${t.title} [${t.slug}]`);
    }
  }

  if (prefs.length > 0) {
    lines.push(`**已知偏好**（当前状态，不限时间窗；共 ${prefs.length} 条）：`);
    for (const p of prefs.slice(0, 3)) {
      lines.push(`- ${p.title}`);
    }
  }

  if (entities.length > 0) {
    lines.push(
      `**关键人物**（当前状态，不限时间窗）：${entities.map((e) => `${e.title} [${e.slug}]`).join(", ")}`,
    );
  }

  lines.push("");
  lines.push(
    '如需细节：`query("关键词")` 语义检索，或 `get_entity_profile("<entity-slug>")` 查看人物/项目档案。',
  );

  return lines.join("\n");
}
