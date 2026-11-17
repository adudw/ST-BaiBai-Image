import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestViaMainApi } from '@/api/client';
import { buildAutoTagMessages } from '@/autoTag/prompt';
import { requestSelectedFloorTags } from '@/autoTag/runner';
import { clearAutoGenerateFlags, consumeAutoGenerate } from '@/floor/autoGenerate';
import { settings } from '@/state/settings';
import { getContext, type STContext } from '@/st/context';
import { applyMessageText } from '@/st/messageEdit';

vi.mock('@/api/client', () => ({ requestCompletion: vi.fn(), requestViaMainApi: vi.fn() }));
vi.mock('@/st/context', async importOriginal => ({
  ...await importOriginal<typeof import('@/st/context')>(),
  getContext: vi.fn(),
}));
vi.mock('@/autoTag/prompt', () => ({
  autoTagProfile: () => ({ comic: false, naiCharPrompts: false, nl: false, lockedSize: null }),
  buildAutoTagMessages: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/state/settings', async importOriginal => ({
  ...await importOriginal<typeof import('@/state/settings')>(),
  getTagGenChannel: () => null,
  isCurrentChatExcluded: () => false,
}));
vi.mock('@/st/messageEdit', () => ({ applyMessageText: vi.fn() }));

const original = 'First\n<bbi_image>old first</bbi_image>\nMiddle\n<bbi_image>keep middle</bbi_image>\nLast\n<bbi_image>old last</bbi_image>';
const response = (positions: string[]) => JSON.stringify({
  images: positions.map(position => ({ position, tag: `new ${position}`, size: 'portrait' })),
});

describe('manual paragraph generation runner', () => {
  let ctx: STContext;
  let responses: string[];
  let savedAutoTag: typeof settings.autoTag;
  let savedEnabled: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    clearAutoGenerateFlags();
    savedAutoTag = settings.autoTag;
    savedEnabled = settings.enabled;
    settings.enabled = true;
    settings.autoTag = { ...settings.autoTag, minImages: 0, maxImages: 1, retryCount: 0, autoGenerate: false };
    ctx = {
      chat: [{ name: 'Char', is_user: false, is_system: false, mes: original }],
      chatMetadata: {}, name1: 'User', name2: 'Char', getCurrentChatId: () => 'selected-test',
    } as STContext;
    vi.mocked(getContext).mockReturnValue(ctx);
    vi.stubGlobal('toastr', { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() });
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    responses = [response(['P2', 'P1'])];
    vi.mocked(requestViaMainApi).mockImplementation(async (_messages, options) => {
      const raw = responses.shift()!;
      options?.validate?.(raw);
      return raw;
    });
    vi.mocked(applyMessageText).mockImplementation(async (_floor, buildNext) => {
      const next = buildNext(ctx.chat[0].mes);
      if (next === null) return 'build-failed';
      ctx.chat[0].mes = next;
      return 'saved';
    });
  });

  afterEach(() => {
    settings.autoTag = savedAutoTag;
    settings.enabled = savedEnabled;
    clearAutoGenerateFlags();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('generates two images for two paragraphs despite a global maximum of one and automatic drawing disabled', async () => {
    await requestSelectedFloorTags(0, [0, 2]);
    expect(buildAutoTagMessages).toHaveBeenCalledWith(
      ctx, 0, expect.objectContaining({ minImages: 2, maxImages: 2 }),
      null, expect.objectContaining({ segments: [
        { id: 'P1', sourceLine: 0, text: 'First' },
        { id: 'P2', sourceLine: 2, text: 'Last' },
      ] }), null, expect.stringContaining('每段必须且只能生成一张图片'),
      expect.any(Object), 'First\nLast',
    );
    expect(ctx.chat[0].mes).toContain('Middle\n<bbi_image>keep middle</bbi_image>');
    expect(ctx.chat[0].mes).toContain('First\n<bbi_image>new P1');
    expect(ctx.chat[0].mes).toContain('Last\n<bbi_image>new P2');
    expect(consumeAutoGenerate('selected-test', 0, 0, 0)).toBe('force');
    expect(consumeAutoGenerate('selected-test', 0, 0, 1)).toBeNull();
    expect(consumeAutoGenerate('selected-test', 0, 0, 2)).toBe('force');
    expect(settings.autoTag).toMatchObject({ minImages: 0, maxImages: 1 });
  });

  it.each([[], ['P1'], ['P1', 'P1'], ['P1', 'P2', 'P2']].map(positions => ({ positions })))('preserves all old tags when the response is invalid: $positions', async ({ positions }) => {
    responses = [response(positions)];
    await requestSelectedFloorTags(0, [0, 2]);
    expect(applyMessageText).not.toHaveBeenCalled();
    expect(ctx.chat[0].mes).toBe(original);
    expect(toastr.error).toHaveBeenCalled();
    expect(consumeAutoGenerate('selected-test', 0, 0, 0)).toBeNull();
  });

  it('retries an incomplete response and only applies the complete response', async () => {
    settings.autoTag.retryCount = 1;
    responses = [response(['P1']), response(['P1', 'P2'])];
    await requestSelectedFloorTags(0, [0, 2]);
    expect(requestViaMainApi).toHaveBeenCalledTimes(2);
    expect(applyMessageText).toHaveBeenCalledTimes(1);
    expect(ctx.chat[0].mes).toContain('Last\n<bbi_image>new P2');
  });

  it('marks the final new image indexes after another plugin inserts a paragraph and tag', async () => {
    vi.mocked(applyMessageText).mockImplementationOnce(async (_floor, buildNext) => {
      const next = buildNext(`Added\n<bbi_image>keep added</bbi_image>\n${original}`);
      if (next === null) return 'build-failed';
      ctx.chat[0].mes = next;
      return 'saved';
    });
    await requestSelectedFloorTags(0, [0, 2]);
    expect(ctx.chat[0].mes).toContain('Added\n<bbi_image>keep added</bbi_image>');
    expect(ctx.chat[0].mes).toContain('First\n<bbi_image>new P1');
    expect(ctx.chat[0].mes).toContain('Last\n<bbi_image>new P2');
    expect(consumeAutoGenerate('selected-test', 0, 0, 0)).toBeNull();
    expect(consumeAutoGenerate('selected-test', 0, 0, 1)).toBe('force');
    expect(consumeAutoGenerate('selected-test', 0, 0, 2)).toBeNull();
    expect(consumeAutoGenerate('selected-test', 0, 0, 3)).toBe('force');
  });
});
