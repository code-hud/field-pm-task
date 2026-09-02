/**
 * Every rule, in evaluation order. The order mirrors the Java service's @Order values
 * (ceiling 10, velocity 20, spike 30, reversal 40). All rules are evaluated on every
 * check, not just up to the first objection — the denial is more useful when it lists
 * everything wrong with the trade.
 *
 * Adding screening is one file: implement { name, code, evaluate(trade, history) } and
 * add it here.
 */
const notionalCeiling = require('./notionalCeiling.js');
const tradeVelocity = require('./tradeVelocity.js');
const notionalSpike = require('./notionalSpike.js');
const rapidReversal = require('./rapidReversal.js');

const rules = [notionalCeiling, tradeVelocity, notionalSpike, rapidReversal];

module.exports = { rules };
