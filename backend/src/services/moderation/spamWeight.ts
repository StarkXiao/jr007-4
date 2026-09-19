import {
  COMMENT_SPAM_DOWNWEIGHT_SECONDS,
  COMMENT_SPAM_FACTOR,
  COMMENT_SPAM_THRESHOLD,
  COMMENT_SPAM_WINDOW_SECONDS,
} from "../../config/constants";
import { redis } from "../../db/redis";
import { logger } from "../../utils/logger";

const activityKey = (userId: bigint) => `spam:comment-activity:${userId}`;
const downweightKey = (userId: bigint) => `spam:comment-downweight:${userId}`;

/**
 * 记录一次评论发言；窗口内超过阈值就把账号标记为"刷屏降权"，
 * 标记自带 TTL，时间到自动恢复正常权重。
 * Redis 不可用时静默跳过——降权只是排序优化，不能因此阻断发言，
 * 与 rateLimit 中间件"故障时放行"的取舍一致。
 */
export async function recordCommentActivity(userId: bigint): Promise<void> {
  try {
    const key = activityKey(userId);
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, COMMENT_SPAM_WINDOW_SECONDS);
    }
    if (count > COMMENT_SPAM_THRESHOLD) {
      await redis.set(downweightKey(userId), "1", "EX", COMMENT_SPAM_DOWNWEIGHT_SECONDS);
    }
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "刷屏检测异常，已跳过");
  }
}

/**
 * 批量取发言权重系数：被降权的账号为 COMMENT_SPAM_FACTOR，其余为 1。
 * 返回 Map 的键是 userId 的字符串形式，便于和序列化后的 id 对应。
 */
export async function getSpeechWeights(userIds: bigint[]): Promise<Map<string, number>> {
  const weights = new Map<string, number>();
  if (userIds.length === 0) return weights;

  try {
    const values = await redis.mget(...userIds.map((id) => downweightKey(id)));
    userIds.forEach((id, index) => {
      weights.set(id.toString(), values[index] === "1" ? COMMENT_SPAM_FACTOR : 1);
    });
  } catch (error) {
    // 读不到权重时全部按正常权重处理，宁可漏降权也不能让列表打不开
    logger.warn({ err: (error as Error).message }, "读取发言权重异常，按正常权重处理");
    userIds.forEach((id) => weights.set(id.toString(), 1));
  }
  return weights;
}
