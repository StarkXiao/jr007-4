/**
 * 评论的可信度排序与多级树组装。
 * 全部是纯函数，不碰 DB 与 Redis，方便单测，也让排序规则只有一份实现。
 */

/** 时间衰减：每小时扣 0.2 分，封顶 24 分——老评论会下沉，但不会无限沉底 */
const RECENCY_DECAY_PER_HOUR = 0.2;
const RECENCY_DECAY_CAP = 24;

export interface CommentRankInput {
  createdAt: Date;
  /** 作者信用分（0–100） */
  authorCredit: number;
  /** 发言权重（0–1），刷屏账号会被压低 */
  speechWeight: number;
}

/**
 * 排序分 = 作者信用分 × 发言权重 − 时间衰减。
 * 高信用的近期评论排最前；刷屏账号的评论权重打折后沉底。
 */
export function computeCommentRank(input: CommentRankInput, now: Date = new Date()): number {
  const ageHours = Math.max(0, (now.getTime() - input.createdAt.getTime()) / 3_600_000);
  const recencyPenalty = Math.min(ageHours * RECENCY_DECAY_PER_HOUR, RECENCY_DECAY_CAP);
  return input.authorCredit * input.speechWeight - recencyPenalty;
}

export interface CommentTreeNode<T> {
  comment: T;
  replies: CommentTreeNode<T>[];
}

/**
 * 把扁平评论列表组装成多级树，每层回复按时间正序（对话顺序乱了就读不懂了）。
 * 父评论不在可见集合中（被隐藏/删除）的回复会成为孤儿，整支丢弃——
 * 与"父评论被隐藏后整串不再展示"的行为一致。
 */
export function buildCommentTree<T extends { id: bigint; parentId: bigint | null; createdAt: Date }>(
  comments: T[],
): CommentTreeNode<T>[] {
  const nodes = new Map<string, CommentTreeNode<T>>();
  for (const comment of comments) {
    nodes.set(comment.id.toString(), { comment, replies: [] });
  }

  const roots: CommentTreeNode<T>[] = [];
  for (const node of nodes.values()) {
    const { parentId } = node.comment;
    if (parentId === null) {
      roots.push(node);
      continue;
    }
    const parent = nodes.get(parentId.toString());
    if (parent) parent.replies.push(node);
  }

  const sortReplies = (list: CommentTreeNode<T>[]): void => {
    for (const node of list) {
      node.replies.sort((a, b) => a.comment.createdAt.getTime() - b.comment.createdAt.getTime());
      sortReplies(node.replies);
    }
  };
  sortReplies(roots);

  return roots;
}

/** 顶层评论比较器：排序分降序，同分时新的在前 */
export function compareByTrust<T extends { createdAt: Date }>(
  a: CommentTreeNode<T>,
  b: CommentTreeNode<T>,
  rankOf: (comment: T) => number,
): number {
  const diff = rankOf(b.comment) - rankOf(a.comment);
  if (diff !== 0) return diff;
  return b.comment.createdAt.getTime() - a.comment.createdAt.getTime();
}
