// 由各 bundler 通过 define 注入，避免运行时 JSON import 的跨 bundler 兼容问题。
// 非构建环境（如 e2e 测试的 mocha）下 define 不存在，
// 用 typeof 检查 + fallback 避免 ReferenceError。
declare const __ZCODE_VERSION__: string;
declare const __ZCODE_COMMIT__: string;
declare const __ZCODE_BUILD_TIME__: string;

export const ZCODE_VERSION: string =
  typeof __ZCODE_VERSION__ !== "undefined" ? __ZCODE_VERSION__ : "0.0.0-dev";
export const ZCODE_COMMIT: string =
  typeof __ZCODE_COMMIT__ !== "undefined" ? __ZCODE_COMMIT__ : "unknown";
export const ZCODE_BUILD_TIME: string =
  typeof __ZCODE_BUILD_TIME__ !== "undefined" ? __ZCODE_BUILD_TIME__ : "unknown";

// zcode.z.ai 按官方发布版本表校验 app_version（query 参数与 X-ZCode-App-Version 头）：
// 远控页对未知版本直接 404，client/configs 灰度与套餐接口按版本判定能力。
// fork 版本号（<upstream>-nightwares.N）不在表内，所有面向官方端点的版本信号
// 统一上报上游基线版本；fork 完整版本号只用于部署与更新判定。
export function normalizeUpstreamAppVersion(version: string): string {
  return version.replace(/-nightwares\.\d+$/, "");
}
