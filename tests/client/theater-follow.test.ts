import { describe, expect, it } from 'vitest';
import { Follower } from '../../src/client/theater/follow';

describe('keeping a theater screen in step', () => {
  it('leaves small gaps alone and nudges at one steady speed, with slack', () => {
    const f = new Follower();
    expect(f.step(0.3, true, 0)).toEqual({ rate: 1 });
    expect(f.step(-0.3, true, 200)).toEqual({ rate: 1 });
    // Behind by more than half a second: a little faster, the same speed every check.
    expect(f.step(0.9, true, 400)).toEqual({ rate: 1.05 });
    expect(f.step(0.7, true, 600)).toEqual({ rate: 1.05 });
    // Keeps going until it's really close, not just under where it started.
    expect(f.step(0.3, true, 800)).toEqual({ rate: 1.05 });
    expect(f.step(0.1, true, 1000)).toEqual({ rate: 1 });
    // Ahead: a little slower.
    expect(f.step(-0.8, true, 1200)).toEqual({ rate: 0.95 });
  });

  it('does nothing while the video is loading', () => {
    const f = new Follower();
    expect(f.step(10, false, 0)).toEqual({ rate: 1 });
    expect(f.step(1, false, 200)).toEqual({ rate: 1 });
  });

  it('after a skip on a slow stream, jumps once, then aims ahead instead of jumping over and over', () => {
    const f = new Follower();
    // The showing skipped ahead 20 minutes: jump there.
    expect(f.step(1200, true, 0)).toEqual({ rate: 1, jumpAhead: 0 });
    // Loading takes 4 seconds; meanwhile, no chasing.
    for (let t = 200; t < 4000; t += 200)
      expect(f.step(1200 - t / 1000, false, t)).toEqual({ rate: 1 });
    // Playing again, 4 seconds behind. Too soon for another jump: nudge.
    expect(f.step(4, true, 4000)).toEqual({ rate: 1.05 });
    // Still well behind later on: one more jump, aimed 4 seconds ahead to make up for loading.
    expect(f.step(3.6, true, 8000)).toEqual({ rate: 1, jumpAhead: 4 });
    // And no third jump right after it.
    expect(f.step(3.5, true, 9000).jumpAhead).toBeUndefined();
  });
});
