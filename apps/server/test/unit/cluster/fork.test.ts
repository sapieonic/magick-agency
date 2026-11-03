import { describe, expect, it } from 'vitest';
import { analysisChildHeapMb, execArgvWithHeap } from '../../../src/cluster/fork.js';

describe('execArgvWithHeap', () => {
  it("replaces the parent's heap limit (either spelling) and keeps every other flag", () => {
    expect(execArgvWithHeap(['--max-old-space-size=4096', '--max-http-header-size=16384'], 768))
      .toEqual(['--max-http-header-size=16384', '--max-old-space-size=768']);
    expect(execArgvWithHeap(['--import', 'tsx', '--max-old-space-size', '4096'], 512))
      .toEqual(['--import', 'tsx', '--max-old-space-size=512']);
  });

  it('leaves the flags alone when no heap is given', () => {
    expect(execArgvWithHeap(['--max-old-space-size=4096'], undefined)).toEqual(['--max-old-space-size=4096']);
  });
});

describe('analysisChildHeapMb', () => {
  it('is the recording budget plus 512 MB', () => {
    expect(analysisChildHeapMb(512 * 1024 * 1024)).toBe(1024);
    expect(analysisChildHeapMb(1)).toBe(513);
  });
});
