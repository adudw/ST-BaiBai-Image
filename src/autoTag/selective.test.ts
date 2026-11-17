import { describe, expect, it } from 'vitest';
import { prepareTargetText } from '@/autoTag/clean';
import { buildSelectedTaskNote, parseSelectedImagePlan, replaceSelectedImageTags, selectedImageSequences } from '@/autoTag/selective';
import type { ImageInsertion } from '@/autoTag/protocol';

const image = (sourceLine: number, tag: string): ImageInsertion => ({
  position: `P${sourceLine + 1}`,
  sourceLine,
  tag,
  nl: '',
  negative: '',
  characters: [],
  size: 'portrait',
});

describe('one image per selected paragraph', () => {
  const target = prepareTargetText('她推开门。\n\n她坐在窗边。', []);
  const result = (positions: string[]) => JSON.stringify({
    images: positions.map(position => ({ position, tag: '1girl, sitting', size: 'portrait' })),
  });

  it('requires one image for a single selected paragraph', () => {
    const single = prepareTargetText('她坐在窗边。', []);
    expect(parseSelectedImagePlan(result(['P1']), single.segments, false).images).toHaveLength(1);
    expect(() => parseSelectedImagePlan(result(['P1', 'P1']), single.segments, false)).toThrow(/恰好一张/);
  });

  it('orders a valid batch by paragraph and maps it to the original source lines', () => {
    const plan = parseSelectedImagePlan(result(['P2', 'P1']), target.segments, false);
    expect(plan.images.map(image => [image.position, image.sourceLine])).toEqual([['P1', 0], ['P2', 2]]);
  });

  it.each([
    { positions: [] },
    { positions: ['P1'] },
    { positions: ['P1', 'P2', 'P2'] },
  ])('rejects incorrect counts $positions without truncating extra images', ({ positions }) => {
    expect(() => parseSelectedImagePlan(result(positions), target.segments, false)).toThrow(/恰好一张/);
  });

  it('rejects two images at one position even when the total count is right', () => {
    expect(() => parseSelectedImagePlan(result(['P1', 'P1']), target.segments, false)).toThrow(/重复或遗漏/);
  });

  it('rejects a position outside the selected paragraphs', () => {
    expect(() => parseSelectedImagePlan(result(['P1', 'P3']), target.segments, false)).toThrow(/可选位置/);
  });

  it('requires all selected positions explicitly in the task note', () => {
    const note = buildSelectedTaskNote(target);
    expect(note).toContain('每段必须且只能生成一张图片');
    expect(note).toContain('P1、P2');
    expect(note).toContain('不得遗漏、重复、合并段落或额外生成');
  });

  it('enforces one page per selected paragraph for comic plans too', () => {
    const page = (position: string) => ({
      position,
      size: 'portrait',
      summary: 'manga page',
      items: [{ label: 'character', caption: 'girl sitting by the window', bbox: [0, 0, 1000, 1000] }],
    });
    const valid = JSON.stringify({ pages: [page('P2'), page('P1')] });
    expect(parseSelectedImagePlan(valid, target.segments, true).images.map(image => image.position)).toEqual(['P1', 'P2']);
    expect(() => parseSelectedImagePlan(JSON.stringify({ pages: [page('P1')] }), target.segments, true)).toThrow(/恰好一张/);
    expect(() => parseSelectedImagePlan(JSON.stringify({ pages: [page('P1'), page('P1')] }), target.segments, true)).toThrow(/重复或遗漏/);
  });

  it('replaces both selected paragraph tags while preserving the middle paragraph tag', () => {
    const source = 'First\n<bbi_image>old first</bbi_image>\nMiddle\n<bbi_image>keep</bbi_image>\nLast\n<bbi_image>old last</bbi_image>';
    const segments = [{ id: 'P1', sourceLine: 0, text: 'First' }, { id: 'P2', sourceLine: 2, text: 'Last' }];
    const plan = parseSelectedImagePlan(result(['P2', 'P1']), segments, false);
    const next = replaceSelectedImageTags(source, new Set([0, 2]), plan.images);
    expect(next).toContain('Middle\n<bbi_image>keep</bbi_image>');
    expect(next).not.toContain('old first');
    expect(next).not.toContain('old last');
    expect(next.match(/<bbi_image>/g)).toHaveLength(3);
    expect(selectedImageSequences(source, new Set([0, 2]), plan.images)).toEqual([0, 2]);
  });
});

describe('replaceSelectedImageTags', () => {
  it('replaces only selected paragraph tags and preserves other tag markup', () => {
    const oldFirst = '<bbi_image><tag>old first</tag><size>portrait</size></bbi_image>';
    const oldSecond = '<bbi_image><tag>old second</tag><size>portrait</size></bbi_image>';
    const source = `First scene\n${oldFirst}\nSecond scene\n${oldSecond}`;

    const result = replaceSelectedImageTags(source, new Set([0]), [image(0, 'new first')]);

    expect(result).toContain('First scene\n<bbi_image>new first<size>portrait</size>');
    expect(result).not.toContain('old first');
    expect(result).toContain(`Second scene\n${oldSecond}`);
  });

  it('adds a tag to a selected paragraph without disturbing an untagged paragraph', () => {
    const existing = '<bbi_image><tag>kept</tag><size>portrait</size></bbi_image>';
    const source = `First scene\n${existing}\nSecond scene`;

    const result = replaceSelectedImageTags(source, new Set([1]), [image(1, 'added')]);

    expect(result).toContain(`First scene\n${existing}`);
    expect(result).toContain('Second scene\n<bbi_image>added<size>portrait</size>');
  });

  it('returns final image indexes when preserved tags appear before new images', () => {
    const existing = '<bbi_image><tag>kept</tag><size>portrait</size></bbi_image>';
    const source = `First scene\n${existing}\nSecond scene\nThird scene`;

    expect(selectedImageSequences(source, new Set([1]), [image(1, 'new'), image(2, 'newer')])).toEqual([1, 2]);
  });
});
