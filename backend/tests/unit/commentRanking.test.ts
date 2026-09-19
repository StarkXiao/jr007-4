import { describe, expect, it } from "vitest";
import {
  buildCommentTree,
  compareByTrust,
  computeCommentRank,
  type CommentTreeNode,
} from "../../src/modules/comments/ranking";

const NOW = new Date("2026-09-19T12:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

describe("computeCommentRank", () => {
  it("信用分越高排序分越高", () => {
    const high = computeCommentRank({ createdAt: NOW, authorCredit: 90, speechWeight: 1 }, NOW);
    const low = computeCommentRank({ createdAt: NOW, authorCredit: 30, speechWeight: 1 }, NOW);
    expect(high).toBeGreaterThan(low);
  });

  it("刷屏降权（权重 0.25）会显著拉低排序分", () => {
    const normal = computeCommentRank({ createdAt: NOW, authorCredit: 80, speechWeight: 1 }, NOW);
    const spammer = computeCommentRank({ createdAt: NOW, authorCredit: 80, speechWeight: 0.25 }, NOW);
    expect(spammer).toBeCloseTo(normal * 0.25);
  });

  it("评论越旧排序分越低，但衰减有封顶", () => {
    const fresh = computeCommentRank({ createdAt: hoursAgo(1), authorCredit: 60, speechWeight: 1 }, NOW);
    const dayOld = computeCommentRank({ createdAt: hoursAgo(24), authorCredit: 60, speechWeight: 1 }, NOW);
    const monthOld = computeCommentRank({ createdAt: hoursAgo(720), authorCredit: 60, speechWeight: 1 }, NOW);

    expect(fresh).toBeGreaterThan(dayOld);
    expect(dayOld).toBeGreaterThan(monthOld);
    // 封顶 24 分：5 天前的评论和一个月前的评论衰减相同
    const fiveDays = computeCommentRank({ createdAt: hoursAgo(120), authorCredit: 60, speechWeight: 1 }, NOW);
    expect(monthOld).toBeCloseTo(fiveDays);
  });

  it("未来的时间戳不会产生负年龄加成", () => {
    const future = computeCommentRank(
      { createdAt: new Date(NOW.getTime() + 3_600_000), authorCredit: 60, speechWeight: 1 },
      NOW,
    );
    const fresh = computeCommentRank({ createdAt: NOW, authorCredit: 60, speechWeight: 1 }, NOW);
    expect(future).toBe(fresh);
    expect(future).toBeCloseTo(60);
  });
});

interface FakeComment {
  id: bigint;
  parentId: bigint | null;
  createdAt: Date;
}

function fake(id: number, parentId: number | null, hoursOld: number): FakeComment {
  return { id: BigInt(id), parentId: parentId === null ? null : BigInt(parentId), createdAt: hoursAgo(hoursOld) };
}

describe("buildCommentTree", () => {
  it("组装多级嵌套，回复按时间正序", () => {
    const comments = [
      fake(1, null, 10),
      fake(3, 2, 4),   // 1 -> 2 -> 3
      fake(2, 1, 8),
      fake(4, 1, 6),   // 1 -> 4
      fake(5, null, 2),
    ];

    const roots = buildCommentTree(comments);
    expect(roots.map((node) => node.comment.id)).toEqual([1n, 5n]);

    const first = roots[0];
    // 同一层的回复按时间正序：id=2（8 小时前）在 id=4（6 小时前）之前
    expect(first.replies.map((node) => node.comment.id)).toEqual([2n, 4n]);
    expect(first.replies[0].replies.map((node) => node.comment.id)).toEqual([3n]);
  });

  it("父评论不可见时整支丢弃", () => {
    // id=2 被隐藏（不在列表里），它的子评论 3 成为孤儿
    const comments = [fake(1, null, 10), fake(3, 2, 4)];
    const roots = buildCommentTree(comments);
    expect(roots).toHaveLength(1);
    expect(roots[0].replies).toHaveLength(0);
  });

  it("空列表返回空树", () => {
    expect(buildCommentTree([])).toEqual([]);
  });
});

describe("compareByTrust", () => {
  const node = (id: number, hoursOld: number): CommentTreeNode<FakeComment> => ({
    comment: fake(id, null, hoursOld),
    replies: [],
  });

  it("排序分高的在前，同分时新的在前", () => {
    const ranks = new Map<bigint, number>([
      [1n, 50],
      [2n, 80],
      [3n, 80],
    ]);
    const rankOf = (comment: FakeComment) => ranks.get(comment.id) ?? 0;

    const a = node(1, 1);
    const b = node(2, 5);
    const c = node(3, 2);

    expect(compareByTrust(a, b, rankOf)).toBeGreaterThan(0);
    expect(compareByTrust(b, a, rankOf)).toBeLessThan(0);
    // b 与 c 同分，c 更新（2 小时前 < 5 小时前），c 排前
    expect(compareByTrust(b, c, rankOf)).toBeGreaterThan(0);
    expect(compareByTrust(c, b, rankOf)).toBeLessThan(0);
  });
});
