/**
 * Frozen reward constants for the RL loop.
 *
 * These live outside mutable repo state so the loop cannot edit its own
 * judge.  REWARD_CHECKSUM is the SHA-256 of computeTickReward.toString()
 * at ship time — if the function body changes, verifyJudgeIntegrity()
 * halts the next tick.
 */

const crypto = require('crypto');

const REWARD_CONFIG = Object.freeze({
  REVIEW_CLEAN:   1,
  VERIFY_PASS:    3,
  NPM_TEST_BONUS: 2,
  COMMIT_LANDED:  1,
  HALT_PENALTY:  -3,
});

// SHA-256 of computeTickReward.toString() at ship time.
// Regenerate: node -e "const{computeTickReward}=require('./commands/autopilot');const c=require('crypto');console.log(c.createHash('sha256').update(computeTickReward.toString()).digest('hex'))"
const REWARD_CHECKSUM = '29f56ce4e39bc93b37f92f063efc04886444a4a9c7817e52b1d42105ea170b19';

module.exports = { REWARD_CONFIG, REWARD_CHECKSUM };
