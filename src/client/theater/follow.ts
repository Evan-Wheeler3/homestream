// Keeping a theater screen in step with the showing's clock without making the
// sound stutter. Every change of playback speed and every jump is audible, so:
// leave small gaps alone, nudge at one fixed speed (and only start or stop
// nudging with some slack), wait out loading instead of chasing it, and when a
// jump is needed, land where the movie will be once it has loaded.

/** Closer than this (seconds) is in step: nobody can tell. */
const START_NUDGING = 0.5;
/** Nudging stops once this close. */
const STOP_NUDGING = 0.15;
/** Further off than this, jump instead of nudging. */
const JUMP = 3;
/** How much faster or slower a nudge plays (the pitch stays the same). */
const NUDGE = 0.05;
/** At most one jump in this long (ms), so a slow stream can't end up jumping over and over. */
const JUMP_COOLDOWN = 8000;
/** The most a jump will aim ahead to make up for loading (seconds). */
const MAX_LEAD = 6;

export interface FollowStep {
  /** Playback speed to use (only set it on the video when it changes). */
  rate: number;
  /** Jump to this many seconds ahead of the showing's position (usually 0). */
  jumpAhead?: number;
}

export class Follower {
  private nudging = 0;
  private lastJumpAt = -Infinity;
  private jumpStartedAt: number | null = null;
  /** How long the last jump took to play again (seconds): the next one aims that far ahead. */
  private lead = 0;

  /**
   * One check. `drift`: where the showing is minus where the video is (seconds).
   * `ready`: the video has enough loaded to play here (not seeking or buffering).
   */
  step(drift: number, ready: boolean, now: number): FollowStep {
    if (!ready) {
      // Loading: chasing a moving target now only makes things worse.
      this.nudging = 0;
      return { rate: 1 };
    }
    if (this.jumpStartedAt !== null) {
      this.lead = Math.min(MAX_LEAD, (now - this.jumpStartedAt) / 1000);
      this.jumpStartedAt = null;
    }
    const off = Math.abs(drift);
    if (off > JUMP && now - this.lastJumpAt >= JUMP_COOLDOWN) {
      this.lastJumpAt = now;
      this.jumpStartedAt = now;
      this.nudging = 0;
      return { rate: 1, jumpAhead: this.lead };
    }
    if (this.nudging ? off < STOP_NUDGING : off < START_NUDGING) {
      this.nudging = 0;
      return { rate: 1 };
    }
    this.nudging = Math.sign(drift);
    return { rate: 1 + this.nudging * NUDGE };
  }

  /** The video was moved on purpose (paused and lined up, or a new movie). */
  reset() {
    this.nudging = 0;
    this.jumpStartedAt = null;
  }
}
