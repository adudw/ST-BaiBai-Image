<script setup lang="ts">
import { computed, ref } from 'vue';
import ModalMask from '@/components/ModalMask.vue';

const props = defineProps<{
  segments: Array<{ sourceLine: number; text: string }>;
}>();

const emit = defineEmits<{
  (e: 'confirm', lines: number[]): void;
  (e: 'cancel'): void;
}>();

const open = ref(false);
const selected = ref(new Set<number>());
const count = computed(() => selected.value.size);

function toggle(sourceLine: number): void {
  const next = new Set(selected.value);
  if (next.has(sourceLine)) next.delete(sourceLine);
  else next.add(sourceLine);
  selected.value = next;
}

function setAll(checked: boolean): void {
  selected.value = checked ? new Set(props.segments.map(segment => segment.sourceLine)) : new Set();
}

function confirm(): void {
  if (!selected.value.size) return;
  emit('confirm', [...selected.value].sort((a, b) => a - b));
}

requestAnimationFrame(() => { open.value = true; });
</script>

<template>
  <ModalMask :open="open" top-layer @close="emit('cancel')">
    <section class="bbi-modal bbi-select-segments" role="dialog" aria-modal="true" aria-label="选择剧情段落">
      <header class="bbi-modal-head">
        <span class="bbi-modal-title">选择剧情段落</span>
        <button class="bbi-icon-mini" type="button" aria-label="关闭" @click="emit('cancel')">×</button>
      </header>
      <p class="bbi-select-segments__hint">
        每个勾选段落固定生成一张图片，不使用设置里的最少／最多张数。未选段落及其 tag 保留；成功后替换所选段落的旧 tag。
      </p>
      <div class="bbi-select-segments__tools">
        <button class="bbi-btn" type="button" @click="setAll(true)">全选</button>
        <button class="bbi-btn" type="button" @click="setAll(false)">清空</button>
        <span>已选 {{ count }} / {{ segments.length }} 段 · 生成 {{ count }} 张</span>
      </div>
      <div class="bbi-select-segments__list">
        <label v-for="(segment, index) in segments" :key="segment.sourceLine" class="bbi-select-segments__item">
          <input
            type="checkbox"
            :checked="selected.has(segment.sourceLine)"
            @change="toggle(segment.sourceLine)"
          >
          <span class="bbi-select-segments__number">{{ index + 1 }}</span>
          <span class="bbi-select-segments__text">{{ segment.text }}</span>
        </label>
      </div>
      <footer class="bbi-modal-foot">
        <span class="bbi-modal-foot-spacer"></span>
        <button class="bbi-btn" type="button" @click="emit('cancel')">取消</button>
        <button class="bbi-btn bbi-btn-primary" type="button" :disabled="!count" @click="confirm">
          生成 {{ count }} 张图片
        </button>
      </footer>
    </section>
  </ModalMask>
</template>

<style scoped>
.bbi-select-segments {
  width: min(680px, calc(100vw - 32px));
  max-height: min(82vh, 820px);
  display: flex;
  flex-direction: column;
}
.bbi-select-segments__hint {
  margin: 8px 0 12px;
  color: var(--bbi-ink-soft);
  font-size: 13px;
  line-height: 1.6;
}
.bbi-select-segments__tools {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  color: var(--bbi-ink-soft);
  font-size: 12px;
}
.bbi-select-segments__tools span { margin-left: auto; }
.bbi-select-segments__list {
  min-height: 120px;
  overflow: auto;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
}
.bbi-select-segments__item {
  display: grid;
  grid-template-columns: 18px 28px minmax(0, 1fr);
  align-items: start;
  gap: 9px;
  padding: 10px 12px;
  cursor: pointer;
  color: var(--bbi-ink);
  font-size: 13px;
  line-height: 1.6;
}
.bbi-select-segments__item + .bbi-select-segments__item { border-top: 1px solid var(--bbi-line); }
.bbi-select-segments__item:hover { background: var(--bbi-surface-2); }
.bbi-select-segments__item input { margin: 4px 0 0; accent-color: var(--bbi-accent); }
.bbi-select-segments__number { color: var(--bbi-ink-muted); text-align: right; }
.bbi-select-segments__text { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.bbi-modal-foot-spacer { flex: 1 1 auto; }
</style>
