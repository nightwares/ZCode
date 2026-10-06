import assert from "node:assert/strict";
import test from "node:test";
import { getPathLeaf, isFileSystemRootPath } from "../src/lib/path.js";
import {
  getWorkspaceDisplayName,
  getWorkspaceDisplayNameKey,
  resolveWorkspaceDisplayName,
  resolveWorkspaceTabDisplayName,
} from "../src/lib/workspaceDisplayName.js";
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

test("resolveWorkspaceDisplayName prefers the user override keyed by identity", () => {
  const identity = "remote:docker:atelier-devcontainer-1:/";
  assert.equal(
    resolveWorkspaceDisplayName({
      workspacePath: "/",
      workspaceIdentity: identity,
      remoteTarget: { kind: "docker", container: "atelier-devcontainer-1" },
      rootLabel: "Root directory",
      overrides: { [identity]: "Atelier 容器" },
    }),
    "Atelier 容器",
  );
});

test("resolveWorkspaceDisplayName falls back to auto derivation without an override", () => {
  assert.equal(
    resolveWorkspaceDisplayName({
      workspacePath: "/",
      workspaceIdentity: "remote:docker:atelier-devcontainer-1:/",
      remoteTarget: { kind: "docker", container: "atelier-devcontainer-1" },
      rootLabel: "Root directory",
      overrides: {},
    }),
    "docker:atelier-devcontainer-1",
  );
});

test("resolveWorkspaceDisplayName trims blank overrides and ignores them", () => {
  const identity = "remote:docker:atelier-devcontainer-1:/";
  assert.equal(
    resolveWorkspaceDisplayName({
      workspacePath: "/",
      workspaceIdentity: identity,
      remoteTarget: { kind: "docker", container: "atelier-devcontainer-1" },
      rootLabel: "Root directory",
      overrides: { [identity]: "   " },
    }),
    "docker:atelier-devcontainer-1",
  );
});

test("resolveWorkspaceDisplayName keys local workspaces by path when identity is absent", () => {
  assert.equal(
    resolveWorkspaceDisplayName({
      workspacePath: "/home/dev/medx",
      overrides: { "/home/dev/medx": "Medx 主项目" },
    }),
    "Medx 主项目",
  );
});

test("resolveWorkspaceTabDisplayName threads tab shape through the resolver", () => {
  const tab = {
    workspacePath: "/",
    workspaceIdentity: "remote:wsl:Ubuntu-24.04:/",
    remoteTarget: { kind: "wsl", distro: "Ubuntu-24.04" },
  };
  assert.equal(resolveWorkspaceTabDisplayName(tab, null, "Root directory"), "wsl:Ubuntu-24.04");
  assert.equal(
    resolveWorkspaceTabDisplayName(tab, { "remote:wsl:Ubuntu-24.04:/": "Ubuntu dev" }),
    "Ubuntu dev",
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


test("getWorkspaceDisplayNameKey prefers identity and falls back to path", () => {
  assert.equal(
    getWorkspaceDisplayNameKey({
      workspacePath: "/",
      workspaceIdentity: "  remote:ssh:host:22:user:/srv  ",
    }),
    "remote:ssh:host:22:user:/srv",
  );
  assert.equal(getWorkspaceDisplayNameKey({ workspacePath: "/home/dev/atelier" }), "/home/dev/atelier");
});
