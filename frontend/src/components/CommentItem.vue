<script setup lang="ts">
import { computed, ref } from "vue";
import type { Comment } from "@/api/types";
import { useAuthStore } from "@/stores/auth";

/**
 * 单条评论 + 递归渲染子回复。
 * 折叠策略：
 * - 深度达到 COLLAPSE_DEPTH 的子树默认整组收起，点击"展开 N 条回复"查看；
 * - 同一层回复超过 PREVIEW_COUNT 条时只显示前几条，"查看其余 N 条"展开。
 * 数据操作（回复/删除/举报）统一抛给父级处理，本组件只管展示与折叠状态。
 */

const COLLAPSE_DEPTH = 3;
const PREVIEW_COUNT = 3;

const props = withDefaults(defineProps<{ comment: Comment; depth?: number }>(), { depth: 1 });

const emit = defineEmits<{
  reply: [comment: Comment];
  remove: [comment: Comment];
  report: [commentId: string];
}>();

const auth = useAuthStore();

const expanded = ref(false);
const showAll = ref(false);

const children = computed(() => props.comment.replies ?? []);
const isDeep = computed(() => props.depth >= COLLAPSE_DEPTH);

const visibleChildren = computed(() => {
  if (isDeep.value && !expanded.value) return [];
  return showAll.value ? children.value : children.value.slice(0, PREVIEW_COUNT);
});

const hiddenCount = computed(() => children.value.length - visibleChildren.value.length);

function toggleExpand() {
  expanded.value = !expanded.value;
  if (!expanded.value) showAll.value = false;
}
</script>

<template>
  <div class="comment" :class="{ 'comment--downweighted': comment.downweighted }">
    <div class="comment__head">
      <span class="comment__author">{{ comment.author?.nickname ?? "匿名" }}</span>
      <span class="muted">{{ new Date(comment.createdAt).toLocaleString("zh-CN") }}</span>
      <el-tag v-if="comment.edited" size="small" type="info">已编辑</el-tag>
      <el-tooltip
        v-if="comment.downweighted"
        content="该账号短时间内发言过于频繁，系统已自动降低其评论的展示权重"
        placement="top"
      >
        <el-tag size="small" type="warning">已降权</el-tag>
      </el-tooltip>
    </div>
    <div class="comment__body">{{ comment.body }}</div>

    <div class="comment__actions">
      <el-button v-if="auth.isLoggedIn" text size="small" @click="emit('reply', comment)">回复</el-button>
      <el-button
        v-if="auth.user?.uuid === comment.author?.uuid || auth.isModerator"
        text
        size="small"
        @click="emit('remove', comment)"
      >
        删除
      </el-button>
      <el-button v-if="auth.isLoggedIn" text size="small" @click="emit('report', comment.id)">举报</el-button>
    </div>

    <div v-if="children.length" class="comment__replies">
      <el-button v-if="isDeep && !expanded" text size="small" class="comment__toggle" @click="toggleExpand">
        展开 {{ children.length }} 条回复
      </el-button>

      <template v-else>
        <CommentItem
          v-for="child in visibleChildren"
          :key="child.id"
          :comment="child"
          :depth="depth + 1"
          @reply="(target: Comment) => emit('reply', target)"
          @remove="(target: Comment) => emit('remove', target)"
          @report="(id: string) => emit('report', id)"
        />

        <el-button v-if="hiddenCount > 0" text size="small" class="comment__toggle" @click="showAll = true">
          查看其余 {{ hiddenCount }} 条回复
        </el-button>
        <el-button
          v-else-if="showAll && children.length > PREVIEW_COUNT"
          text
          size="small"
          class="comment__toggle"
          @click="showAll = false"
        >
          收起
        </el-button>
        <el-button v-if="isDeep" text size="small" class="comment__toggle" @click="toggleExpand">
          收起回复
        </el-button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.comment__actions {
  display: flex;
  gap: 4px;
  margin-top: 4px;
}

.comment--downweighted {
  opacity: 0.55;
}

.comment--downweighted:hover {
  opacity: 0.85;
}

.comment__toggle {
  align-self: flex-start;
}
</style>
