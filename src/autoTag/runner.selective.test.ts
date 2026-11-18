import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestCompletion, requestViaMainApi } from '@/api/client';
import { readBookMemory } from '@/autoTag/bookMemory';
import { autoTagProfile, buildAutoTagMessages } from '@/autoTag/prompt';
import { cancelFloorTags, requestFloorTags, requestSelectedFloorTags, requestSlotTag } from '@/autoTag/runner';
import { clearAutoGenerateFlags, consumeAutoGenerate } from '@/floor/autoGenerate';
import { getTagGenChannel, settings } from '@/state/settings';
import { getContext, type STContext } from '@/st/context';
import { applyMessageText } from '@/st/messageEdit';

vi.mock('@/api/client', () => ({ requestCompletion: vi.fn(), requestViaMainApi: vi.fn() }));
vi.mock('@/st/context', async importOriginal => ({
  ...await importOriginal<typeof import('@/st/context')>(),
  getContext: vi.fn(),
}));
vi.mock('@/autoTag/bookMemory', () => ({ readBookMemory: vi.fn().mockReturnValue(null) }));
vi.mock('@/autoTag/prompt', () => ({
  autoTagProfile: vi.fn(),
  buildAutoTagMessages: vi.fn(),
}));
vi.mock('@/state/settings', async importOriginal => ({
  ...await importOriginal<typeof import('@/state/settings')>(),
  getTagGenChannel: vi.fn(),
  isCurrentChatExcluded: () => false,
}));
vi.mock('@/st/messageEdit', () => ({ applyMessageText: vi.fn() }));

const original = 'First\n<bbi_image>old first</bbi_image>\nMiddle\n<bbi_image>keep middle</bbi_image>\nLast\n<bbi_image>old last</bbi_image>';
const response = (positions: string[], tag = 'new') => JSON.stringify({
  images: positions.map(position => ({ position, tag: `${tag} ${position}`, size: 'portrait' })),
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
    vi.mocked(getTagGenChannel).mockReturnValue(null);
    vi.mocked(autoTagProfile).mockReturnValue({ comic: false, naiCharPrompts: false, nl: false, lockedSize: null });
    vi.mocked(buildAutoTagMessages).mockImplementation(async (_ctx, _floor, _options, _memory, target) => [
      { role: 'user', content: target!.promptText },
    ]);
    vi.stubGlobal('toastr', { success: vi.fn(), info: vi.fn(() => ({})), clear: vi.fn(), warning: vi.fn(), error: vi.fn() });
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    responses = [response(['P1'], 'new first'), response(['P1'], 'new last')];
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
    expect(buildAutoTagMessages).toHaveBeenCalledTimes(2);
    expect(buildAutoTagMessages).toHaveBeenNthCalledWith(1,
      ctx, 0, expect.objectContaining({ minImages: 1, maxImages: 1 }),
      null, expect.objectContaining({ segments: [
        { id: 'P1', sourceLine: 0, text: 'First' },
      ] }), null, expect.stringContaining('单段独立请求'),
      expect.any(Object), 'First',
    );
    expect(buildAutoTagMessages).toHaveBeenNthCalledWith(2,
      ctx, 0, expect.objectContaining({ minImages: 1, maxImages: 1 }),
      null, expect.objectContaining({ segments: [
        { id: 'P1', sourceLine: 2, text: 'Last' },
      ] }), null, expect.stringContaining('单段独立请求'),
      expect.any(Object), 'Last',
    );
    expect(readBookMemory).toHaveBeenNthCalledWith(1, 0, 'First', 'User');
    expect(readBookMemory).toHaveBeenNthCalledWith(2, 0, 'Last', 'User');
    expect(requestViaMainApi).toHaveBeenNthCalledWith(1, [{ role: 'user', content: 'First ⟦P1⟧' }], expect.any(Object));
    expect(requestViaMainApi).toHaveBeenNthCalledWith(2, [{ role: 'user', content: 'Last ⟦P1⟧' }], expect.any(Object));
    expect(ctx.chat[0].mes).toContain('Middle\n<bbi_image>keep middle</bbi_image>');
    expect(ctx.chat[0].mes).toContain('First\n<bbi_image>new first P1');
    expect(ctx.chat[0].mes).toContain('Last\n<bbi_image>new last P1');
    expect(consumeAutoGenerate('selected-test', 0, 0, 0)).toBe('force');
    expect(consumeAutoGenerate('selected-test', 0, 0, 1)).toBeNull();
    expect(consumeAutoGenerate('selected-test', 0, 0, 2)).toBe('force');
    expect(settings.autoTag).toMatchObject({ minImages: 0, maxImages: 1 });
    expect(toastr.info).toHaveBeenCalledWith('正在分析第 1 / 2 段', expect.any(String), expect.objectContaining({ timeOut: 0 }));
    expect(toastr.info).toHaveBeenCalledWith('正在分析第 2 / 2 段', expect.any(String), expect.objectContaining({ timeOut: 0 }));
    expect(toastr.clear).toHaveBeenCalledTimes(2);
  });

  it.each([[], ['P2'], ['P1', 'P1'], ['P1', 'P2']].map(positions => ({ positions })))('preserves all old tags when each response is invalid: $positions', async ({ positions }) => {
    responses = [response(positions), response(positions)];
    await requestSelectedFloorTags(0, [0, 2]);
    expect(applyMessageText).not.toHaveBeenCalled();
    expect(ctx.chat[0].mes).toBe(original);
    expect(toastr.error).toHaveBeenCalled();
    expect(consumeAutoGenerate('selected-test', 0, 0, 0)).toBeNull();
  });

  it('only retries the failed paragraph and keeps successful paragraph results', async () => {
    settings.autoTag.retryCount = 1;
    responses = [response(['P1'], 'first success'), response([]), response(['P1'], 'last retried')];
    await requestSelectedFloorTags(0, [0, 2]);
    expect(requestViaMainApi).toHaveBeenCalledTimes(3);
    expect(buildAutoTagMessages).toHaveBeenCalledTimes(2);
    expect(requestViaMainApi).toHaveBeenNthCalledWith(2, [{ role: 'user', content: 'Last ⟦P1⟧' }], expect.any(Object));
    expect(requestViaMainApi).toHaveBeenNthCalledWith(3, [{ role: 'user', content: 'Last ⟦P1⟧' }], expect.objectContaining({ source: expect.stringContaining('第 2/2 段 · 第 2 次') }));
    expect(applyMessageText).toHaveBeenCalledTimes(1);
    expect(ctx.chat[0].mes).toContain('First\n<bbi_image>first success P1');
    expect(ctx.chat[0].mes).toContain('Last\n<bbi_image>last retried P1');
  });

  it.each([true, false])('preserves failed paragraph tags and draws only the successful paragraph (first fails=%s)', async firstFails => {
    settings.autoTag.retryCount = 1;
    responses = firstFails
      ? [response([]), response([]), response(['P1'], 'last success')]
      : [response(['P1'], 'first success'), response([]), response([])];
    await requestSelectedFloorTags(0, [0, 2]);
    expect(requestViaMainApi).toHaveBeenCalledTimes(3);
    expect(applyMessageText).toHaveBeenCalledTimes(1);
    expect(ctx.chat[0].mes).toContain(firstFails ? 'old first' : 'first success P1');
    expect(ctx.chat[0].mes).toContain(firstFails ? 'last success P1' : 'old last');
    expect(ctx.chat[0].mes).toContain('keep middle');
    expect(consumeAutoGenerate('selected-test', 0, 0, firstFails ? 2 : 0)).toBe('force');
    expect(consumeAutoGenerate('selected-test', 0, 0, firstFails ? 0 : 2)).toBeNull();
    expect(toastr.warning).toHaveBeenCalledWith(expect.stringContaining(`所选第 ${firstFails ? 1 : 2} 段生成失败`), expect.any(String));
  });

  it('continues to the next paragraph after a network error', async () => {
    vi.mocked(requestViaMainApi).mockRejectedValueOnce(new Error('network failed'));
    responses = [response(['P1'], 'last success')];
    await requestSelectedFloorTags(0, [0, 2]);
    expect(ctx.chat[0].mes).toContain('old first');
    expect(ctx.chat[0].mes).toContain('Last\n<bbi_image>last success P1');
  });

  it('preserves the failed paragraph when assembling its references throws', async () => {
    vi.mocked(buildAutoTagMessages).mockRejectedValueOnce(new Error('reference unavailable'));
    responses = [response(['P1'], 'last success')];
    await requestSelectedFloorTags(0, [0, 2]);
    expect(buildAutoTagMessages).toHaveBeenCalledTimes(2);
    expect(requestViaMainApi).toHaveBeenCalledTimes(1);
    expect(ctx.chat[0].mes).toContain('old first');
    expect(ctx.chat[0].mes).toContain('Last\n<bbi_image>last success P1');
  });

  it('uses independent paragraph requests with a configured tag API channel too', async () => {
    const channel = { id: 'tag-channel' } as NonNullable<ReturnType<typeof getTagGenChannel>>;
    vi.mocked(getTagGenChannel).mockReturnValue(channel);
    vi.mocked(requestCompletion).mockImplementation(async (_channel, _messages, options) => {
      const raw = responses.shift()!;
      options?.validate?.(raw);
      return raw;
    });
    await requestSelectedFloorTags(0, [2, 0, 2]);
    expect(requestViaMainApi).not.toHaveBeenCalled();
    expect(requestCompletion).toHaveBeenNthCalledWith(1, channel, [{ role: 'user', content: 'First ⟦P1⟧' }], expect.any(Object));
    expect(requestCompletion).toHaveBeenNthCalledWith(2, channel, [{ role: 'user', content: 'Last ⟦P1⟧' }], expect.any(Object));
    expect(ctx.chat[0].mes).toContain('First\n<bbi_image>new first P1');
    expect(ctx.chat[0].mes).toContain('Last\n<bbi_image>new last P1');
  });

  it('requests one comic page per paragraph independently', async () => {
    vi.mocked(autoTagProfile).mockReturnValue({ comic: true, naiCharPrompts: false, nl: false, lockedSize: null });
    responses = ['first comic', 'last comic'].map(caption => JSON.stringify({ pages: [{
      position: 'P1', size: 'portrait', summary: caption,
      items: [{ label: 'object', caption, bbox: [0, 0, 1000, 1000] }],
    }] }));
    await requestSelectedFloorTags(0, [0, 2]);
    expect(requestViaMainApi).toHaveBeenCalledTimes(2);
    expect(ctx.chat[0].mes).toMatch(/First\n<bbi_image>[\s\S]*?first comic/);
    expect(ctx.chat[0].mes).toMatch(/Last\n<bbi_image>[\s\S]*?last comic/);
    expect(ctx.chat[0].mes).toContain('keep middle');
  });

  it('waits for the first paragraph before starting the next request', async () => {
    let release!: () => void;
    vi.mocked(requestViaMainApi).mockImplementationOnce(async (_messages, options) => {
      await new Promise<void>(resolve => { release = resolve; });
      const raw = responses.shift()!;
      options?.validate?.(raw);
      return raw;
    });
    const pending = requestSelectedFloorTags(0, [0, 2]);
    await vi.waitFor(() => expect(requestViaMainApi).toHaveBeenCalledTimes(1));
    expect(buildAutoTagMessages).toHaveBeenCalledTimes(1);
    expect(applyMessageText).not.toHaveBeenCalled();
    release();
    await pending;
    expect(requestViaMainApi).toHaveBeenCalledTimes(2);
  });

  it('cancels the batch without sending later requests or replacing old tags', async () => {
    vi.mocked(requestViaMainApi).mockImplementationOnce(async (_messages, options) => {
      cancelFloorTags(0);
      options?.validate?.(response(['P1']));
      return response(['P1']);
    });
    await requestSelectedFloorTags(0, [0, 2]);
    expect(requestViaMainApi).toHaveBeenCalledTimes(1);
    expect(applyMessageText).not.toHaveBeenCalled();
    expect(ctx.chat[0].mes).toBe(original);
    expect(toastr.clear).toHaveBeenCalledTimes(1);
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
    expect(ctx.chat[0].mes).toContain('First\n<bbi_image>new first P1');
    expect(ctx.chat[0].mes).toContain('Last\n<bbi_image>new last P1');
    expect(consumeAutoGenerate('selected-test', 0, 0, 0)).toBeNull();
    expect(consumeAutoGenerate('selected-test', 0, 0, 1)).toBe('force');
    expect(consumeAutoGenerate('selected-test', 0, 0, 2)).toBeNull();
    expect(consumeAutoGenerate('selected-test', 0, 0, 3)).toBe('force');
  });

  it('removes only its drawing flags if saving fails', async () => {
    vi.mocked(applyMessageText).mockImplementationOnce(async (_floor, buildNext) => {
      buildNext(ctx.chat[0].mes);
      throw new Error('save failed');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await requestSelectedFloorTags(0, [0, 2]);
    expect(ctx.chat[0].mes).toBe(original);
    expect(consumeAutoGenerate('selected-test', 0, 0, 0)).toBeNull();
    expect(consumeAutoGenerate('selected-test', 0, 0, 2)).toBeNull();
    expect(toastr.error).toHaveBeenCalledWith('save failed', expect.any(String));
  });

  it('keeps whole-floor regeneration as one request with global count settings', async () => {
    settings.autoTag.maxImages = 2;
    responses = [response(['P1', 'P3'])];
    await requestFloorTags(0, { replace: true });
    expect(requestViaMainApi).toHaveBeenCalledTimes(1);
    expect(buildAutoTagMessages).toHaveBeenCalledWith(
      ctx, 0, expect.objectContaining({ minImages: 0, maxImages: 2 }), null,
      expect.objectContaining({ segments: expect.arrayContaining([
        { id: 'P1', sourceLine: 0, text: 'First' },
        { id: 'P3', sourceLine: 2, text: 'Last' },
      ]) }), null, '', expect.any(Object), undefined,
    );
    expect(ctx.chat[0].mes).not.toContain('keep middle');
    expect(toastr.info).not.toHaveBeenCalled();
  });

  it('keeps single-slot rewriting as one request and leaves every other tag intact', async () => {
    responses = [response(['P1'], 'rewritten first')];
    await requestSlotTag(0, 0);
    expect(requestViaMainApi).toHaveBeenCalledTimes(1);
    expect(ctx.chat[0].mes).toContain('First\n<bbi_image>rewritten first P1');
    expect(ctx.chat[0].mes).toContain('Middle\n<bbi_image>keep middle</bbi_image>');
    expect(ctx.chat[0].mes).toContain('Last\n<bbi_image>old last</bbi_image>');
    expect(toastr.info).not.toHaveBeenCalled();
  });
});
