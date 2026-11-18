import type { PreparedTargetText, TargetSegment } from '@/autoTag/clean';
import { parseComicPlan, parseImagePlan, type ImageInsertion, type ImagePlan } from '@/autoTag/protocol';
import { serializeImageTag, stripImageTags } from '@/st/imageTagRegex';

/** One mandatory image at each selected paragraph, independent of the global count range. */
export function buildSelectedTaskNote(target: PreparedTargetText): string {
  return `【用户手动选段生成】
${target.segments.length === 1 ? '本次是单段独立请求，目标正文仅有当前这一段，只生成它的一张图片；没有其它待分配的段落。\n' : ''}目标正文中的 ${target.segments.length} 个段落全部由用户明确选中，每段必须且只能生成一张图片。
position 必须逐一覆盖 ${target.segments.map(segment => segment.id).join('、')}，每个编号恰好出现一次；按段落顺序输出，不得遗漏、重复、合并段落或额外生成。
每张图片只表现它对应段落中的一个可见瞬间，不得把另一段的事件拼进同一张图。即使两段连续或相似，也分别生成；上下文、角色库、世界书和角色参考只用于理解指代与补充外貌设定，不代表这些人物必须入镜。
参考信息中的动作、事件和人物组合不得作为当前画面的新增内容；有指代不明确时只补充理解当前段落所必需的信息，不把参考剧情改编进图片。
本次张数固定，不采用自动选图、空结果、去重或最少/最多张数的设置。漫画模式同样每段恰好一页。
本次不更新角色档案，changes 返回空数组。`;
}

/** Reject missing, extra or duplicate positions before any old tag can be replaced. */
export function parseSelectedImagePlan(raw: string, segments: TargetSegment[], comic: boolean): ImagePlan {
  const plan = comic
    ? parseComicPlan(raw, segments)
    // Do not truncate extra images before validating the exact per-paragraph count.
    : parseImagePlan(raw, segments, 0, Number.MAX_SAFE_INTEGER);
  if (plan.images.length !== segments.length) {
    throw new Error(`选段生成要求每段恰好一张图片：选了 ${segments.length} 段，但模型返回了 ${plan.images.length} 张`);
  }
  const byPosition = new Map(plan.images.map(image => [image.position, image]));
  if (byPosition.size !== segments.length || segments.some(segment => !byPosition.has(segment.id))) {
    throw new Error('选段生成的段落位置有重复或遗漏，每个选中段落必须恰好对应一张图片');
  }
  return { images: segments.map(segment => byPosition.get(segment.id)!), changes: [] };
}

interface Line { text: string; eol: string }

function linesOf(source: string): Line[] {
  const lines: Line[] = [];
  const newline = /\r\n|\n|\r/g;
  let start = 0;
  for (let match = newline.exec(source); match; match = newline.exec(source)) {
    lines.push({ text: source.slice(start, match.index), eol: match[0] });
    start = match.index + match[0].length;
  }
  lines.push({ text: source.slice(start), eol: '' });
  return lines;
}

function newlineCount(text: string): number {
  return (text.match(/\r\n|\n|\r/g) ?? []).length;
}

function retainedTagAnchors(source: string, selectedLines: ReadonlySet<number>): number[] {
  return [...source.matchAll(/<bbi_image>[\s\S]+?<\/bbi_image>/gi)]
    .filter(match => match.index !== undefined)
    .map(match => {
      const prefix = stripImageTags(source.slice(0, match.index!));
      const count = newlineCount(prefix);
      return Math.max(0, count - (/(?:\r\n|\n|\r)$/.test(prefix) ? 1 : 0));
    })
    .filter(anchor => !selectedLines.has(anchor));
}

/** Replace tags attached to selected narrative lines and retain all other tag markup verbatim. */
export function replaceSelectedImageTags(
  source: string,
  selectedLines: ReadonlySet<number>,
  images: ImageInsertion[],
): string {
  const base = stripImageTags(source);
  const retained = new Map<number, string[]>();
  const matches = [...source.matchAll(/<bbi_image>[\s\S]+?<\/bbi_image>/gi)];
  for (const match of matches) {
    if (match.index === undefined) continue;
    const prefix = stripImageTags(source.slice(0, match.index));
    const count = newlineCount(prefix);
    const anchorLine = Math.max(0, count - (/(?:\r\n|\n|\r)$/.test(prefix) ? 1 : 0));
    if (selectedLines.has(anchorLine)) continue;
    const list = retained.get(anchorLine) ?? [];
    list.push(match[0]);
    retained.set(anchorLine, list);
  }

  const generated = new Map<number, string[]>();
  for (const image of images) {
    const list = generated.get(image.sourceLine) ?? [];
    list.push(serializeImageTag(image));
    generated.set(image.sourceLine, list);
  }

  const lines = linesOf(base);
  const fallbackEol = lines.find(line => line.eol)?.eol || '\n';
  let output = '';
  lines.forEach((line, index) => {
    output += line.text;
    const insertions = [...(retained.get(index) ?? []), ...(generated.get(index) ?? [])];
    const eol = line.eol || fallbackEol;
    for (const tag of insertions) output += `${eol}${tag}`;
    output += line.eol;
  });
  return output;
}

/** Final tag-sequence indexes of the newly generated images after preserved tags are kept. */
export function selectedImageSequences(
  source: string,
  selectedLines: ReadonlySet<number>,
  images: ImageInsertion[],
): number[] {
  const retainedCounts = new Map<number, number>();
  for (const anchor of retainedTagAnchors(source, selectedLines)) {
    retainedCounts.set(anchor, (retainedCounts.get(anchor) ?? 0) + 1);
  }
  const imageRows = images.map((image, index) => ({ image, index }));
  const byLine = new Map<number, Array<{ image: ImageInsertion; index: number }>>();
  for (const row of imageRows) {
    const list = byLine.get(row.image.sourceLine) ?? [];
    list.push(row);
    byLine.set(row.image.sourceLine, list);
  }
  const allLines = new Set([...retainedCounts.keys(), ...byLine.keys()]);
  const sequences = new Array<number>(images.length);
  let sequence = 0;
  for (const line of [...allLines].sort((a, b) => a - b)) {
    const retained = retainedCounts.get(line) ?? 0;
    sequence += retained;
    for (const row of byLine.get(line) ?? []) sequences[row.index] = sequence++;
  }
  return sequences;
}
