/**
 * Frozen reward constants for the RL loop.
 *
 * These live outside mutable repo state so the loop cannot edit its own
 * judge.  REWARD_CHECKSUM is the SHA-256 of JSON.stringify(REWARD_CONFIG)
 * + computeTickReward.toString() at ship time — if the config values or
 * function body change, verifyJudgeIntegrity() halts the next tick.
 */

const crypto = require('crypto');

const REWARD_CONFIG = Object.freeze({
  REVIEW_CLEAN:   1,
  VERIFY_PASS:    3,
  NPM_TEST_BONUS: 2,
  COMMIT_LANDED:  1,
  HALT_PENALTY:  -3,
});

// SHA-256 of JSON.stringify(REWARD_CONFIG) + computeTickReward.toString() at ship time.
// Regenerate: node -e "const c=require('./lib/reward-config');const h=require('crypto').createHash('sha256');h.update(JSON.stringify(c.REWARD_CONFIG));h.update(require('./commands/autopilot').computeTickReward.toString());console.log(h.digest('hex'))"
const REWARD_CHECKSUM = '5a84be0f7f392d6ef05337be0776f864852e94d6391da0b41486298555595a40';

module.exports = { REWARD_CONFIG, REWARD_CHECKSUM };
