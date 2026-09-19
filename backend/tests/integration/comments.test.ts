import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import IORedis from "ioredis";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { initStorage } from "../../src/services/storage";
import { recordCommentActivity } from "../../src/services/moderation/spamWeight";
import { COMMENT_SPAM_THRESHOLD } from "../../src/config/constants";

// 评论多级回复、可信度排序与刷屏降权的集成测试。
// 跑在真实数据库与 Redis 上（docker compose up -d postgres redis）。
let app: Express;
let redis: IORedis;

const suffix = Date.now().toString(36);
const password = "Str0ngPass1";

interface TestUser {
  email: string;
  token: string;
  uuid: string;
  id: bigint;
}

const users: Record<string, TestUser> = {};
let spotUuid = "";
let spotId: bigint;

async function registerUser(name: string, creditScore: number): Promise<TestUser> {
  const email = `${name}-${suffix}@example.com`;
  await request(app)
    .post("/api/v1/auth/register")
    .send({ email, password, nickname: `${name}${suffix.slice(-4)}` })
    .expect(201);

  // 直接改库模拟运营结果：信用分 + 历史通过数，让评论即时可见（先发后审）
  const user = await prisma.user.update({
    where: { email },
    data: { creditScore, approvedCount: 10 },
  });

  const login = await request(app).post("/api/v1/auth/login").send({ email, password }).expect(200);
  return { email, token: login.body.data.accessToken, uuid: user.uuid, id: user.id };
}

async function postComment(token: string, body: string, parentId?: string) {
  const response = await request(app)
    .post(`/api/v1/spots/${spotUuid}/comments`)
    .set("Authorization", `Bearer ${token}`)
    .send({ body, parentId: parentId ?? null })
    .expect(201);
  return response.body.data;
}

async function listCommentItems() {
  const response = await request(app).get(`/api/v1/spots/${spotUuid}/comments`).expect(200);
  return response.body.data.items;
}

beforeAll(async () => {
  await initStorage();
  app = createApp();
  redis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1 });

  // 三个信用分不同的账号，都满足"先发后审"门槛，评论即时可见
  users.high = await registerUser("high", 90);
  users.mid = await registerUser("mid", 60);
  users.spammer = await registerUser("spammer", 85);

  const category = await prisma.category.findFirstOrThrow({ where: { isActive: true } });
  const spot = await prisma.spot.create({
    data: {
      ownerId: users.high.id,
      categoryId: category.id,
      status: "published",
      title: `评论测试地点${suffix.slice(-4)}`,
      exactLat: 30.25,
      exactLng: 120.55,
      publicLat: 30.25,
      publicLng: 120.55,
      publishedAt: new Date(),
    },
  });
  spotUuid = spot.uuid;
  spotId = spot.id;
}, 60000);

afterAll(async () => {
  const ids = Object.values(users).map((user) => user.id);
  if (ids.length > 0) {
    await prisma.comment.deleteMany({ where: { userId: { in: ids } } });
    await prisma.spot.deleteMany({ where: { id: spotId } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  if (redis) {
    const keys = await redis.keys("spam:*");
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  }
  await prisma.$disconnect();
}, 60000);

describe("评论多级回复与排序", () => {
  it("支持三级嵌套回复，列表返回树形结构", async () => {
    const root = await postComment(users.high.token, "顶层：长椅旁边有遮雨棚");
    const reply = await postComment(users.mid.token, "回复：棚子下午会漏雨", root.id);
    await postComment(users.high.token, "再回复：漏雨的是西侧角落", reply.id);

    const items = await listCommentItems();
    const rootItem = items.find((item: { id: string }) => item.id === root.id);
    expect(rootItem).toBeDefined();
    expect(rootItem.replies).toHaveLength(1);
    expect(rootItem.replies[0].replies).toHaveLength(1);
    expect(rootItem.replies[0].replies[0].body).toContain("西侧角落");
  });

  it("超过最大深度的回复自动挂到允许的最深祖先下", async () => {
    // 直接造一条 5 层深的评论链（绕过同地点发言次数限制，与业务无关）
    const chain: bigint[] = [];
    let parentId: bigint | null = null;
    for (let depth = 1; depth <= 5; depth += 1) {
      const created: { id: bigint } = await prisma.comment.create({
        data: {
          spotId,
          userId: users.mid.id,
          parentId,
          body: `第 ${depth} 层`,
          status: "visible",
        },
      });
      chain.push(created.id);
      parentId = created.id;
    }

    // 回复第 5 层 → 新评论应挂到第 4 层下，自身落在第 5 层
    const posted = await postComment(users.high.token, "超深回复会被上移一层", chain[4].toString());
    expect(posted.parentId).toBe(chain[3].toString());
  });

  it("顶层评论按可信度排序：高信用作者的旧评论排在低信用作者的新评论之前", async () => {
    const items = await listCommentItems();
    const highRoot = items.find((item: { body: string }) => item.body.includes("顶层：长椅旁边有遮雨棚"));
    const midRoot = await postComment(users.mid.token, "中层信用的补充：人少时段是上午");

    const sorted = await listCommentItems();
    const highIndex = sorted.findIndex((item: { id: string }) => item.id === highRoot.id);
    const midIndex = sorted.findIndex((item: { id: string }) => item.id === midRoot.id);
    expect(highIndex).toBeGreaterThanOrEqual(0);
    expect(midIndex).toBeGreaterThan(highIndex);
  });

  it("短时间高频发言的账号被自动降权：评论沉底并带降权标记", async () => {
    const spammed = await postComment(users.spammer.token, "刷屏账号的评论");

    // 模拟刷屏：窗口内发言次数超过阈值
    for (let i = 0; i <= COMMENT_SPAM_THRESHOLD; i += 1) {
      await recordCommentActivity(users.spammer.id);
    }

    const items = await listCommentItems();
    const spammedItem = items.find((item: { id: string }) => item.id === spammed.id);
    expect(spammedItem.downweighted).toBe(true);

    // 信用 85 的刷屏账号（85 × 0.25 ≈ 21）排在信用 60 的正常账号之后
    const normalItem = items.find((item: { body: string }) => item.body.includes("中层信用"));
    const spammerIndex = items.findIndex((item: { id: string }) => item.id === spammed.id);
    const normalIndex = items.findIndex((item: { id: string }) => item.id === normalItem.id);
    expect(spammerIndex).toBeGreaterThan(normalIndex);

    // 未刷屏的账号不受影响
    expect(normalItem.downweighted).toBe(false);
  });

  it("发评论会累计发言频率", async () => {
    const key = `spam:comment-activity:${users.high.id}`;
    const before = Number((await redis.get(key)) ?? 0);
    await postComment(users.high.token, "又一条补充");
    const after = Number((await redis.get(key)) ?? 0);
    expect(after).toBe(before + 1);
  });
});
