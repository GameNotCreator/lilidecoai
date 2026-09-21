/** Enumerate only checkpoint output references, never immutable source assets. */
export function checkpointAssetIds(value: unknown): string[] {
  const ids = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.__checkpointImage === "string")
      ids.add(record.__checkpointImage);
    Object.values(record).forEach(visit);
  };
  visit(value);
  return [...ids];
}
