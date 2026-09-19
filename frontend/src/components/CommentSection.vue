<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "@/api/client";
import type { Comment, Paged } from "@/api/types";
import { useAuthStore } from "@/stores/auth";
import CommentItem from "./CommentItem.vue";
import ReportDialog from "./ReportDialog.vue";

const props = defineProps<{ spotUuid: string }>();

const auth = useAuthStore();
const items = ref<Comment[]>([]);
const ownPending = ref<Comment[]>([]);
const total = ref(0);
const loading = ref(false);
const body = ref("");
const submitting = ref(false);
const replyTo = ref<Comment | null>(null);
const reportTarget = ref<string | null>(null);

async function load() {
  loading.value = true;
  try {
    const result = await api.get<Paged<Comment> & { ownPending: Comment[] }>(
      `/spots/${props.spotUuid}/comments`,
      { pageSize: 50 },
    );
    items.value = result.items;
    ownPending.value = result.ownPending;
    total.value = result.total;
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    loading.value = false;
  }
}

async function submit() {
  const text = body.value.trim();
  if (!text) return;

  submitting.value = true;
  try {
    const comment = await api.post<Comment & { pendingModeration: boolean }>(
      `/spots/${props.spotUuid}/comments`,
      { body: text, parentId: replyTo.value?.id ?? null },
    );

    if (comment.pendingModeration) {
      ElMessage.info("评论已提交，审核通过后会公开显示");
    } else {
      ElMessage.success("评论已发布");
    }

    body.value = "";
    replyTo.value = null;
    await load();
  } catch (error) {
    // 后端对"疑似个人信息"返回明确文案，这里直接展示给用户
    ElMessage.error((error as Error).message);
  } finally {
    submitting.value = false;
  }
}

async function remove(comment: Comment) {
  try {
    await ElMessageBox.confirm("删除后无法恢复，确定删除这条评论吗？", "删除评论", {
      confirmButtonText: "删除",
      cancelButtonText: "取消",
      type: "warning",
    });
    await api.del(`/comments/${comment.id}`);
    ElMessage.success("已删除");
    await load();
  } catch {
    // 用户取消
  }
}

function startReply(comment: Comment) {
  replyTo.value = comment;
  body.value = `@${comment.author?.nickname ?? "匿名"} `;
}

onMounted(load);

defineExpose({ reload: load });
</script>

<template>
  <div class="comment-section">
    <h3 style="margin: 0 0 4px; font-size: 16px">大家的补充（{{ total }}）</h3>
    <p class="muted" style="margin: 0 0 12px; font-size: 12px">按可信度排序，长期活跃的可靠贡献者排前面</p>

    <div v-if="auth.isLoggedIn" class="comment-editor">
      <el-input
        v-model="body"
        type="textarea"
        :rows="3"
        maxlength="300"
        show-word-limit
        :placeholder="replyTo ? `回复 ${replyTo.author?.nickname ?? '匿名'}` : '补充你看到的细节，比如什么时段人少'"
      />
      <div class="comment-editor__actions">
        <el-button v-if="replyTo" text @click="replyTo = null">取消回复</el-button>
        <el-button type="primary" :loading="submitting" :disabled="!body.trim()" @click="submit">
          发表
        </el-button>
      </div>
      <p v-if="auth.isMuted" class="muted">你当前处于禁言期，暂时无法发表评论。</p>
    </div>

    <el-alert v-else type="info" :closable="false" style="margin-bottom: 12px">
      <RouterLink :to="{ name: 'login', query: { redirect: `/spots/${spotUuid}` } }">登录</RouterLink>
      后可以补充你的观察。
    </el-alert>

    <div v-if="ownPending.length" class="comment-pending">
      <p class="muted" style="margin: 0 0 6px">你还有 {{ ownPending.length }} 条评论在审核或已被隐藏</p>
      <div v-for="comment in ownPending" :key="comment.id" class="comment comment--own">
        <div class="comment__head">
          <el-tag size="small" :type="comment.status === 'pending' ? 'warning' : 'danger'">
            {{ comment.status === "pending" ? "审核中" : "已隐藏" }}
          </el-tag>
          <span class="muted">{{ new Date(comment.createdAt).toLocaleString("zh-CN") }}</span>
        </div>
        <div class="comment__body">{{ comment.body }}</div>
      </div>
    </div>

    <div v-loading="loading">
      <el-empty v-if="!loading && items.length === 0" description="还没有人补充，欢迎你来做第一个" />

      <CommentItem
        v-for="comment in items"
        :key="comment.id"
        :comment="comment"
        @reply="startReply"
        @remove="remove"
        @report="(id: string) => (reportTarget = id)"
      />
    </div>

    <ReportDialog
      :visible="reportTarget !== null"
      target-type="comment"
      :target-id="reportTarget ?? '0'"
      @update:visible="(value: boolean) => !value && (reportTarget = null)"
    />
  </div>
</template>

<style scoped>
.comment-editor {
  margin-bottom: 16px;
}

.comment-editor__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}

.comment-pending {
  margin-bottom: 16px;
  padding: 10px;
  border-radius: var(--radius-sm);
  background: rgba(230, 126, 34, 0.08);
}

.comment--own {
  border-bottom: none;
  padding: 6px 0;
}
</style>
