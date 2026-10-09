import { describe, expect, it } from "vitest";
import { boundaryInRange, clipAtTime, clipsInRange } from "../src/utils/clip_utils.js";

const clip = (startTime: number, endTime: number) => ({ startTime, endTime });

describe("clipAtTime", () => {
  const clips = [clip(0, 4), clip(4, 8), clip(10, 12)];

  it("finds the clip containing a point", () => {
    expect(clipAtTime(clips, 2)).toBe(clips[0]);
    expect(clipAtTime(clips, 11)).toBe(clips[2]);
  });

  it("treats clip edges as [start, end): a boundary point belongs to the next clip", () => {
    expect(clipAtTime(clips, 4)).toBe(clips[1]);
    expect(clipAtTime(clips, 8)).toBeNull();
  });

  it("returns null in gaps and outside", () => {
    expect(clipAtTime(clips, 9)).toBeNull();
    expect(clipAtTime(clips, 100)).toBeNull();
  });
});

describe("clipsInRange", () => {
  const clips = [clip(0, 4), clip(4, 8), clip(10, 12)];

  it("returns clips overlapping the range", () => {
    expect(clipsInRange(clips, 3, 11)).toEqual([clips[0], clips[1], clips[2]]);
    expect(clipsInRange(clips, 8, 10)).toEqual([]);
  });
});

describe("boundaryInRange", () => {
  it("finds an adjacent clip junction inside the selection", () => {
    const a = clip(0, 8);
    const b = clip(8, 16);
    const boundary = boundaryInRange([b, a], 6, 10);
    expect(boundary).not.toBeNull();
    expect(boundary!.outgoing).toBe(a);
    expect(boundary!.incoming).toBe(b);
  });

  it("returns null when the junction is outside the selection", () => {
    const a = clip(0, 8);
    const b = clip(8, 16);
    expect(boundaryInRange([a, b], 9, 12)).toBeNull();
  });

  it("returns null when clips are not adjacent (gap between them)", () => {
    const a = clip(0, 8);
    const b = clip(9, 16);
    expect(boundaryInRange([a, b], 6, 10)).toBeNull();
  });
});
