import { describe, expect, it } from "vitest";
import { normalizeUpstreamAppVersion } from "#src/version.js";

describe("normalizeUpstreamAppVersion", () => {
  it("剥离 fork 后缀，保留上游基线", () => {
    expect(normalizeUpstreamAppVersion("3.16.2-nightwares.4")).toBe("3.16.2");
    expect(normalizeUpstreamAppVersion("3.14.3-nightwares.12")).toBe("3.14.3");
  });

  it("官方版本与开发版本原样返回", () => {
    expect(normalizeUpstreamAppVersion("3.16.2")).toBe("3.16.2");
    expect(normalizeUpstreamAppVersion("0.0.0-dev")).toBe("0.0.0-dev");
  });

  it("非 fork 形态的后缀不受影响", () => {
    expect(normalizeUpstreamAppVersion("3.16.2-preview.1")).toBe("3.16.2-preview.1");
    expect(normalizeUpstreamAppVersion("3.16.2-nightwares")).toBe("3.16.2-nightwares");
    expect(normalizeUpstreamAppVersion("3.16.2-nightwares.x")).toBe("3.16.2-nightwares.x");
  });

  it("只处理结尾一次，幂等", () => {
    expect(normalizeUpstreamAppVersion("3.16.2-nightwares.1-nightwares.2")).toBe(
      "3.16.2-nightwares.1",
    );
    expect(
      normalizeUpstreamAppVersion(normalizeUpstreamAppVersion("3.16.2-nightwares.3")),
    ).toBe("3.16.2");
  });
});
