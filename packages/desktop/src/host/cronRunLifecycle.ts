// 结算原语的唯一实现放在 @zcode/services（desktop host 与远端 server 共用，避免两份实现漂移）；
// 这里保留原路径的再导出，上游既有 import 位置无需改动。
export {
  recordCronRunOutcomeBestEffort,
  startManualClaimHeartbeat,
  settleCronRunTerminalOutcome,
  settleManualDispatchFailureBestEffort,
} from "@zcode/services/node";
