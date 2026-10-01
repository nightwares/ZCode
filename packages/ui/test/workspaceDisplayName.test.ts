import assert from "node:assert/strict";
import test from "node:test";
import { getPathLeaf, isFileSystemRootPath } from "../src/lib/path.js";
import { getWorkspaceDisplayName } from "../src/lib/workspaceDisplayName.js";
import type { RemoteTarget } from "../../shared/src/remoteTarget.js";

test("isFileSystemRootPath recognises POSIX and Windows drive roots", () => {
  assert.equal(isFileSystemRootPath("/"), true);
  assert.equal(isFileSystemRootPath("C:\\"), true);
  assert.equal(isFileSystemRootPath("c:/"), true);
  assert.equal(isFileSystemRootPath(" / "), true);
  assert.equal(isFileSystemRootPath("/home/dev"), false);
  assert.equal(isFileSystemRootPath("C:\\dev"), false);
  assert.equal(isFileSystemRootPath(""), false);
  assert.equal(isFileSystemRootPath("workspace"), false);
});

test("getPathLeaf keeps its path-leaf contract for non-root paths", () => {
  assert.equal(getPathLeaf("/home/dev/atelier"), "atelier");
  assert.equal(getPathLeaf("C:\\dev\\atelier"), "atelier");
});

test("root workspace display name falls back to the remote host identity", () => {
  const docker = getWorkspaceDisplayName({
    workspacePath: "/",
    remoteTarget: { kind: "docker", container: "atelier-devcontainer-1" },
    rootLabel: "Root directory",
  });
  assert.equal(docker, "docker:atelier-devcontainer-1");

  const ssh = getWorkspaceDisplayName({
    workspacePath: "/",
    remoteTarget: { kind: "ssh", host: "box.example.com", username: "dev", port: 2222 },
    rootLabel: "Root directory",
  });
  assert.equal(ssh, "box.example.com:2222");

  const wsl = getWorkspaceDisplayName({
    workspacePath: "/",
    remoteTarget: { kind: "wsl", distro: "Ubuntu-24.04" },
    rootLabel: "Root directory",
  });
  assert.equal(wsl, "wsl:Ubuntu-24.04");
});

test("local root workspace display name falls back to the localized root label", () => {
  assert.equal(
    getWorkspaceDisplayName({ workspacePath: "/", rootLabel: "Root directory" }),
    "Root directory",
  );
  assert.equal(
    getWorkspaceDisplayName({ workspacePath: "D:\\", rootLabel: "根目录" }),
    "根目录",
  );
});

test("non-root workspace display name stays the path leaf", () => {
  const remoteTarget: RemoteTarget = { kind: "docker", container: "atelier-devcontainer-1" };
  assert.equal(
    getWorkspaceDisplayName({
      workspacePath: "/work/atelier",
      remoteTarget,
      rootLabel: "Root directory",
    }),
    "atelier",
  );
});
