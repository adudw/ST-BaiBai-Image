import type { ImageInsertion } from '@/autoTag/protocol';
import { serializeImageTag } from '@/st/imageTagRegex';
import { stripImageTags } from '@/st/imageTagRegex';

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
