import { h, render } from 'vue';
import SelectSegmentsDialog from '@/floor/SelectSegmentsDialog.vue';

const HOST_ID = 'bbi-app-host';

export interface SelectableSegment {
  sourceLine: number;
  text: string;
}

/** Open the paragraph picker in the plugin shadow root; null means the user cancelled. */
export function selectStorySegments(segments: SelectableSegment[]): Promise<number[] | null> {
  const root = document.getElementById(HOST_ID)?.shadowRoot;
  if (!root) {
    console.warn('[柏宝绘] 插件 host 不在，段落选择窗口无法呼出', { hostId: HOST_ID });
    toastr.warning('柏宝绘窗口尚未就绪，请稍后重试', '柏宝绘');
    return Promise.resolve(null);
  }
  const container = document.createElement('div');
  root.appendChild(container);
  return new Promise(resolve => {
    let settled = false;
    const settle = (lines: number[] | null) => {
      if (settled) return;
      settled = true;
      render(null, container);
      container.remove();
      resolve(lines);
    };
    render(
      h(SelectSegmentsDialog, {
        segments,
        onConfirm: (lines: number[]) => settle(lines),
        onCancel: () => settle(null),
      }),
      container,
    );
  });
}
