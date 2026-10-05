import { postKeyOf, type PlanLikeItem } from "./plan-platforms";

// The posts a list of plan items makes (docs/works.md "Posts"): items that share
// a day, a time and an idea are ONE post, each item one channel delivery of it.
// Returns the item indices of each post, in order of first appearance. A
// removed item stays a post of its own, so it never joins a live one. Pure:
// saving a plan and the backfill of older plans group the same way.
export function postGroupsOf(items: readonly PlanLikeItem[]): number[][] {
  const groups: number[][] = [];
  const byKey = new Map<string, number[]>();
  items.forEach((item, index) => {
    if (item.removed) {
      groups.push([index]);
      return;
    }
    const key = postKeyOf(item);
    const group = byKey.get(key);
    if (group) {
      group.push(index);
      return;
    }
    const fresh = [index];
    byKey.set(key, fresh);
    groups.push(fresh);
  });
  return groups;
}
