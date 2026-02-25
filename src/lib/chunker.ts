// src/lib/chunker.ts
import { hashContent } from "./hash";
import { MAX_CHUNK_SIZE, MIN_CHUNK_SIZE, CHUNK_OVERLAP } from "./constants";

export interface TextChunk {
  content: string;
  index: number;
  heading: string | null;
  metadata: { charStart: number; charEnd: number };
}

export function chunkDocument(text: string | null | undefined, title: string): TextChunk[] {
  if (!text || !text.trim()) return [];

  // Short documents: single chunk
  if (text.length <= MAX_CHUNK_SIZE) {
    return [
      {
        content: `${title}\n\n${text}`.trim(),
        index: 0,
        heading: null,
        metadata: { charStart: 0, charEnd: text.length },
      },
    ];
  }

  // Split by headings first
  const sections = splitByHeadings(text);
  const chunks: TextChunk[] = [];
  let chunkIndex = 0;

  for (const section of sections) {
    // If a section is small enough, keep it as one chunk
    if (section.content.length <= MAX_CHUNK_SIZE) {
      const chunkText = chunkIndex === 0
        ? `${title}\n\n${section.content}`.trim()
        : section.content.trim();

      if (chunkText.length >= MIN_CHUNK_SIZE) {
        chunks.push({
          content: chunkText,
          index: chunkIndex++,
          heading: section.heading,
          metadata: { charStart: section.start, charEnd: section.end },
        });
      }
      continue;
    }

    // Large section: split by paragraphs with overlap
    const paragraphChunks = splitByParagraphs(
      section.content,
      section.heading,
      section.start,
      chunkIndex === 0 ? title : null
    );

    for (const pc of paragraphChunks) {
      chunks.push({ ...pc, index: chunkIndex++ });
    }
  }

  // Fallback: if no chunks produced, force-split
  if (chunks.length === 0) {
    return forceSplit(text, title);
  }

  return chunks;
}

interface Section {
  heading: string | null;
  content: string;
  start: number;
  end: number;
}

function splitByHeadings(text: string): Section[] {
  const headingRegex = /^(#{1,3})\s+(.+)$/gm;
  const sections: Section[] = [];
  let lastIndex = 0;
  let lastHeading: string | null = null;
  let match;

  while ((match = headingRegex.exec(text)) !== null) {
    // Content before this heading
    if (match.index > lastIndex) {
      const content = text.slice(lastIndex, match.index).trim();
      if (content) {
        sections.push({
          heading: lastHeading,
          content,
          start: lastIndex,
          end: match.index,
        });
      }
    }
    lastHeading = match[2];
    lastIndex = match.index;
  }

  // Remaining content
  if (lastIndex < text.length) {
    const content = text.slice(lastIndex).trim();
    if (content) {
      sections.push({
        heading: lastHeading,
        content,
        start: lastIndex,
        end: text.length,
      });
    }
  }

  // No headings found: return whole text as one section
  if (sections.length === 0) {
    sections.push({ heading: null, content: text, start: 0, end: text.length });
  }

  return sections;
}

function splitByParagraphs(
  text: string,
  heading: string | null,
  baseStart: number,
  prefixTitle: string | null
): TextChunk[] {
  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim());
  const chunks: TextChunk[] = [];
  let currentChunk = prefixTitle ? `${prefixTitle}\n\n` : "";
  let chunkStart = baseStart;

  for (const para of paragraphs) {
    if (currentChunk.length + para.length > MAX_CHUNK_SIZE && currentChunk.length >= MIN_CHUNK_SIZE) {
      chunks.push({
        content: currentChunk.trim(),
        index: 0, // Will be reassigned by caller
        heading,
        metadata: { charStart: chunkStart, charEnd: chunkStart + currentChunk.length },
      });

      // Start new chunk with overlap from end of current
      const overlapText = currentChunk.slice(-CHUNK_OVERLAP);
      chunkStart += currentChunk.length - CHUNK_OVERLAP;
      currentChunk = overlapText;
    }
    currentChunk += (currentChunk ? "\n\n" : "") + para;
  }

  if (currentChunk.trim().length >= MIN_CHUNK_SIZE) {
    chunks.push({
      content: currentChunk.trim(),
      index: 0,
      heading,
      metadata: { charStart: chunkStart, charEnd: chunkStart + currentChunk.length },
    });
  }

  return chunks;
}

function forceSplit(text: string, title: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  let i = 0;
  let chunkIndex = 0;

  // Guard: ensure forward progress even if CHUNK_OVERLAP >= MAX_CHUNK_SIZE
  const effectiveOverlap = Math.min(CHUNK_OVERLAP, MAX_CHUNK_SIZE - 1);

  while (i < text.length) {
    const end = Math.min(i + MAX_CHUNK_SIZE, text.length);
    const content = chunkIndex === 0
      ? `${title}\n\n${text.slice(i, end)}`
      : text.slice(i, end);

    chunks.push({
      content: content.trim(),
      index: chunkIndex++,
      heading: null,
      metadata: { charStart: i, charEnd: end },
    });

    const nextI = end - effectiveOverlap;
    if (nextI <= i) break; // Safety: prevent infinite loop
    i = nextI;
    if (i >= text.length) break;
  }

  return chunks;
}

/** @deprecated Use hashContent from ./hash directly. Kept for backward compatibility. */
export const hashChunk = hashContent;
