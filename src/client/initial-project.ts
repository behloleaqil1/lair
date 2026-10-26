/**
 * Which project the dashboard opens first.
 */

/**
 * The server's default project (LAIR_PROJECT, see GET /api/projects/default)
 * when it is in the list; otherwise "example" if listed, else the first
 * project. Returns undefined for an empty list.
 */
export function pickInitialProject(
  projects: string[],
  serverDefault?: unknown,
): string | undefined {
  if (typeof serverDefault === "string" && projects.includes(serverDefault)) {
    return serverDefault;
  }
  if (projects.includes("example")) {
    return "example";
  }
  return projects[0];
}
