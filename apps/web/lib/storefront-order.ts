export function orderStorefrontItems<T extends { id: string }>(
  items: T[],
  orderedIds?: readonly string[],
): T[] {
  if (!orderedIds?.length) return items;
  const positions = new Map(orderedIds.map((id, index) => [id, index]));
  const unranked = orderedIds.length;
  return [...items].sort(
    (a, b) =>
      (positions.get(a.id) ?? unranked) - (positions.get(b.id) ?? unranked),
  );
}
