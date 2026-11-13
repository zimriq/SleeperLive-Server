export function endActivity(activity, reason, endedAt) {
  activity.status = 'ended';
  delete activity.endReason;
  activity.endedReason = reason;
  activity.endedAt = endedAt;
  activity.token = null;
  delete activity.invalidTokenHash;
  delete activity.tokenLostAt;
}
