import { describe, expect, it } from 'vitest';
import { replaceSelectedImageTags, selectedImageSequences } from '@/autoTag/selective';
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
