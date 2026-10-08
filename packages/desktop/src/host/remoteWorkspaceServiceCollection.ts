/* eslint-disable max-lines -- 远程 workspace 服务注册需集中维护，以保持依赖注入顺序 */
import {
  ServiceCollection,
  IFileService,
  IMediaPreviewService,
  IGitService,
  IGitCheckpointService,
  ISystemService,
  ITerminalService,
  ISettingService,
  ICredentialService,
  IBroadcastService,
  IZCodeTaskService,
  IZCodeAgentService,
  IZCodeSessionService,
  IConversationShareService,
  IBotsService,
  IFileWatcherService,
  IOAuthService,
  IModelSelectionService,
  IProviderSettingsService,
  IUsageStatsService,
  ICodingPlanSubscriptionService,
  IClientConfigService,
  IClientScenesService,
  ISkillsService,
  ISkillSyncService,
  IMcpSyncService,
  IPluginSyncService,
  IPluginsService,
  IPluginManagementService,
  ISubagentsService,
  ICommandsService,
  IHooksService,
  IMemoryService,
  ISettingsSyncService,
  IPromptAttachmentTransferService,
  type IServiceAccessor,
} from "@zcode/services";
import {
  ConversationShareHttpClient,
  ConversationShareService,
  createSettingService,
  createCredentialService,
  createBroadcastService,
  createNodeApiClient,
  createHostApiNetworkTransport,
  registerHostApiNetworkTransportForDispose,
  createOAuthService,
  createOAuthProviderLogoutHandler,
  createAccountProviderCredentialStore,
  createAccountProviderCredentialService,
  createAccountProviderRequestAuthService,
  createAccountRequestAuthService,
  resolveCurrentAccountAccess,
  resolveAccountTeamPlanRuntimeApiKey,
  createSettingsSyncService,
  createBotsService,
  createUsageStatsService,
  createMediaPreviewService,
  createCodingPlanSubscriptionService,
  createClientScenesService,
  createServiceLogger,
  createSubagentsService,
  createMemoryService,
  createRemoteConversationShareArtifactSource,
  OAuthCredentialRepo,
} from "@zcode/services/node";
import {
  BIGMODEL_PROVIDER_ID,
  buildRuntimeZCodeApiUrl,
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  type ProviderFamilyDomain,
  type ZCodeSessionRuntimePreferencesResult,
  type BrowserBackendDescriptor,
  type BrowserCommandResult,
  type ZCodeBrowserListParams,
  type ZCodeBrowserExecuteParams,
  zcodeBrowserListParamsSchema,
  zcodeBrowserExecuteParamsSchema,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import { assertLegacyRemoteWorkspaceRpcContract } from "./legacyRemoteWorkspaceRpcContract.js";
import {
  createRemoteProviderProvisioningExecutorFromWorkspace,
  registerRemoteProviderProvisioningExecutor,
} from "./remoteProviderProvisioningService.js";

const runtimePreferencesLogger = createServiceLogger("remote-runtime-preferences");
const browserControlLogger = createServiceLogger("remote-browser-control");
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";

export function createRemoteWorkspaceServiceCollection(params: {
  clientConfigService: IClientConfigService;
  connectionServices: IServiceAccessor;
  sourceServices?: ServiceCollection;
  parentPort: Parameters<typeof createBroadcastService>[0];
  createReportingRemoteZCodeTaskService: <T extends object>(service: T) => T;
  createRemotePromptAttachmentTaskService: <T extends object>(service: T) => T;
  createRemotePromptAttachmentSessionService: <T extends object>(service: T) => T;
  promptAttachmentTransferService: IPromptAttachmentTransferService;
  runtimePreferencesBridge: {
    onError: (error: unknown) => void;
  };
  /**
   * browser-use 中继（Tier 3a）：远端 agent 的 browser 命令经 stdio 转发到这里，
   * 再由既有 browserControlMainBridge 走桌面 IAB（WebContentsView+CDP）执行。
   * 形状即 createBrowserControlMainBridge 的返回值（list/execute）。
   */
  browserControlRelay: {
    list(input: ZCodeBrowserListParams): Promise<BrowserBackendDescriptor[]>;
    execute(input: ZCodeBrowserExecuteParams): Promise<BrowserCommandResult>;
  };
  /** Defense-in-depth：请求携带的 remoteSessionId 是否像本窗口已登记的 logical session。 */
  isPlausibleRemoteSessionId?: (remoteSessionId: string) => boolean;
}): ServiceCollection {
  assertLegacyRemoteWorkspaceRpcContract(params.connectionServices);
  const localSettingService = createSettingService();
  const localCredentialService = createCredentialService();
  const localAccountProviderCredentialStore = createAccountProviderCredentialStore({
    credentialService: localCredentialService,
  });
  const hostApiNetworkTransport = createHostApiNetworkTransport(async () => {
    const settings = await localSettingService.get();
    return {
      httpProxy: settings.httpProxy,
      noProxy: settings.httpProxyNoProxy,
      caCertPath: settings.httpProxyCaCertPath,
    };
  });
  const localApiClient = createNodeApiClient({
    fetchImpl: hostApiNetworkTransport.fetch,
  });
  const localBroadcastService = createBroadcastService(params.parentPort);
  let handleOAuthProviderLogout: ReturnType<typeof createOAuthProviderLogoutHandler> | null = null;
  const localOAuthCredentialRepo = new OAuthCredentialRepo(localCredentialService, {
    onCorruptOAuthSessionCleared: async (providers) => {
      // remote workspace host 读写的是本机 OAuth 凭据。
      // 损坏恢复必须和 local host 一样清理 Start/Coding Plan 派生 provider，避免手机 remote 残留旧 key。
      await Promise.all(
        providers.map((provider) => handleOAuthProviderLogout?.(provider) ?? Promise.resolve()),
      );
    },
  });
  const localAccountProviderCredentialService = createAccountProviderCredentialService({
    credentialStore: localAccountProviderCredentialStore,
    async loadOAuthAccessToken(family) {
      const providerId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
      return (await localOAuthCredentialRepo.loadTokenSet(providerId))?.accessToken ?? null;
    },
    // desktop-attached remote 只复用本机已解析或旧存储中的 Key；远端刷新仍由本机正式账号链负责。
    resolveProviderApiKey: async () => null,
  });
  const readLocalAccountProviderSettings = async () => {
    const settings = await localSettingService.get();
    return {
      providerFamilyDomain: settings.providerFamilyDomain ?? null,
      selections: settings.providerFamilyConnectionSelections ?? {},
    };
  };
  const loadLocalAccountIdentity = async (family: ProviderFamilyDomain) => {
    const providerId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
    return (await localOAuthCredentialRepo.loadUserProfile(providerId))?.id ?? null;
  };
  const localAccountRequestAuthService = createAccountRequestAuthService(
    createAccountProviderRequestAuthService({
      resolveCurrentAccountAccess: (access) =>
        resolveCurrentAccountAccess({
          access,
          readSettings: readLocalAccountProviderSettings,
          loadAccountIdentity: loadLocalAccountIdentity,
        }),
      loadOAuthTokenSet: (providerId) => localOAuthCredentialRepo.loadTokenSet(providerId),
      async loadIndividualPlanApiKey(providerId, family) {
        const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
        const accountIdentity = (await localOAuthCredentialRepo.loadUserProfile(oauthProviderId))
          ?.id;
        if (!accountIdentity) return null;
        return localAccountProviderCredentialService.loadCodingPlanApiKey({
          providerId,
          family,
          accountIdentity,
        });
      },
      resolveTeamPlanApiKey: (access) =>
        resolveAccountTeamPlanRuntimeApiKey({
          apiClient: localApiClient,
          credentialService: localCredentialService,
          access,
        }),
    }),
  );
  const localCodingPlanSubscriptionService = createCodingPlanSubscriptionService({
    apiClient: localApiClient,
    credentialService: localCredentialService,
  });
  handleOAuthProviderLogout = createOAuthProviderLogoutHandler({
    accountProviderCredentialStore: localAccountProviderCredentialStore,
  });
  const conversationShareClient = new ConversationShareHttpClient({
    // 远端 workspace 的分享也必须使用真实 API；本地 Mock 仅用于单测，不生成无法跨进程访问的链接。
    apiClient: localApiClient,
    baseUrl: buildRuntimeZCodeApiUrl(process.env, "/api/v1"),
    tokenProvider: async () =>
      (await localCredentialService.load(ZCODE_JWT_TOKEN_KEY))?.trim() || null,
  });
  const conversationShareService = new ConversationShareService({
    zcodeAgentService: params.connectionServices.zcodeAgentService,
    client: conversationShareClient,
    artifactSource: createRemoteConversationShareArtifactSource(
      params.connectionServices.fileService,
    ),
  });
  const reportingRemoteZCodeTaskService = params.createReportingRemoteZCodeTaskService(
    params.connectionServices.zcodeTaskService,
  );
  // 手机 remote 的 replayable mirror 在 reporting wrapper 中发布用户消息；
  // 附件物化必须包在 reporting 外层，确保 mirror 和真正发给远端 agent 的 prompt 使用同一份远端路径。
  const remoteZCodeTaskService = params.createRemotePromptAttachmentTaskService(
    reportingRemoteZCodeTaskService,
  );
  const remoteZCodeSessionService = params.createRemotePromptAttachmentSessionService(
    params.connectionServices.zcodeSessionService,
  );
  const remoteProviderProvisioningService =
    createRemoteProviderProvisioningExecutorFromWorkspace(params);

  // desktop-attached remote 的 Agent 运行在远端，但 app-global 设置权威仍在
  // desktop shared Host。通过窄化的 runtime-preferences 请求原路返回，避免远端读取自己的 setting。
  const { onError } = params.runtimePreferencesBridge;
  params.connectionServices.zcodeAgentService.onDynamicSessionRuntimePreferencesRequest()(
    (request) => {
      const startedAt = Date.now();
      const requestContext = {
        event: "zcode_protocol.runtime_preferences.host_request_received",
        module: "desktop.host.remote_workspace",
        requestId: request.requestId,
        scope: request.scope,
        sessionId: request.sessionId,
      };
      // 诊断：Agent 侧超时只能说明没有拿到响应；这里记录 Host 是否收到请求，
      // 用“收到但无 response”区分 transport 丢包和设置读取卡住。
      runtimePreferencesLogger.info(
        undefined,
        "runtime preferences host request received",
        requestContext,
      );
      void (async () => {
        const trackStage = <T>(stage: string, promise: Promise<T>): Promise<T> => {
          const stageStartedAt = Date.now();
          return promise.then(
            (value) => {
              runtimePreferencesLogger.debug(
                undefined,
                "runtime preferences host stage completed",
                {
                  ...requestContext,
                  durationMs: Math.max(0, Date.now() - stageStartedAt),
                  stage,
                },
              );
              return value;
            },
            (error: unknown) => {
              runtimePreferencesLogger.warn(undefined, "runtime preferences host stage failed", {
                ...requestContext,
                durationMs: Math.max(0, Date.now() - stageStartedAt),
                error: error instanceof Error ? error.message : String(error),
                stage,
              });
              throw error;
            },
          );
        };
        let resolution:
          | { status: "resolved"; preferences: ZCodeSessionRuntimePreferencesResult }
          | { status: "failed"; message: string };
        try {
          // 与本地 Host 同源：固定预算不依赖配置网关，远程/手机偏好响应不再串行等待网络。
          const settings = await trackStage("settings", localSettingService.get());
          const modelContextBudgetStrategy = DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY;
          resolution = {
            status: "resolved",
            preferences: {
              askUserQuestionAutoResolutionEnabled:
                settings.askUserQuestionAutoResolutionEnabled !== false,
              nativeSearchEnhancementsEnabled: settings.nativeSearchEnhancementsEnabled !== false,
              memoryEnabled: settings.memoryEnabled === true,
              modelContextBudgetStrategy,
              // remote workspace 与本地 Host 保持同一 scope 边界，首次执行不得再次等待 client config。
              ...(request.scope === "user-execution" && settings.integratedTerminalShell
                ? { integratedTerminalShell: settings.integratedTerminalShell }
                : {}),
            },
          };
        } catch (error) {
          resolution = {
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          };
          runtimePreferencesLogger.warn(undefined, "runtime preferences host resolution failed", {
            ...requestContext,
            durationMs: Math.max(0, Date.now() - startedAt),
            error: resolution.message,
          });
        }
        // 只把设置读取失败编码为 -32603；发送失败交给最终 onError 记录，不能重试同一请求。
        await params.connectionServices.zcodeAgentService.respondSessionRuntimePreferences({
          requestId: request.requestId,
          resolution,
        });
        runtimePreferencesLogger.info(undefined, "runtime preferences host response sent", {
          ...requestContext,
          durationMs: Math.max(0, Date.now() - startedAt),
          resolutionStatus: resolution.status,
        });
      })().catch((error: unknown) => {
        runtimePreferencesLogger.warn(undefined, "runtime preferences host response failed", {
          ...requestContext,
          durationMs: Math.max(0, Date.now() - startedAt),
          error: error instanceof Error ? error.message : String(error),
        });
        onError(error);
      });
    },
  );

  // Tier 3a browser 桥：远端 agent 的 browser-use 命令经 stdio 到达这里，转发给桌面
  // Host 既有的 browserControlMainBridge（IAB），结果原路 respond 回远端。订阅寿命与
  // 上面的 runtime-preferences 桥一致：随这份远端 services 的 dispose 一起收口。
  const warnIfRemoteSessionIdImplausible = (
    remoteSessionId: string | undefined,
    requestContext: Record<string, unknown>,
  ): void => {
    if (!remoteSessionId || !params.isPlausibleRemoteSessionId) {
      return;
    }
    if (params.isPlausibleRemoteSessionId(remoteSessionId)) {
      return;
    }
    // Defense-in-depth：remoteSessionId 用于录制产物上传归属等路由，真正的授权边界
    // 在 main 侧命令执行与 resolveScopedCapabilities 的完整 scope 校验。这里只 warn
    // 仍继续服务，避免 logical session 尚未登记/已换代时误伤正常命令。
    browserControlLogger.warn(undefined, "browser control remoteSessionId not recognized", {
      ...requestContext,
      remoteSessionId,
    });
  };
  params.connectionServices.zcodeAgentService.onDynamicBrowserControlRequest()((request) => {
    const startedAt = Date.now();
    const requestContext = {
      event: "zcode_protocol.browser_control.host_request_received",
      module: "desktop.host.remote_workspace",
      kind: request.kind,
      requestId: request.requestId,
    };
    browserControlLogger.info(undefined, "browser control host request received", requestContext);
    const respondRelayFailure = async (message: string): Promise<void> => {
      // relay_failed 错误壳会被远端 respondBrowserControl 的 schema 校验拒绝并按
      // backend_unavailable + uncertain 结算——语义等价，无需为它扩协议错误码。
      await params.connectionServices.zcodeAgentService.respondBrowserControl({
        requestId: request.requestId,
        result: {
          ok: false,
          error: { code: "relay_failed", message, sideEffect: "uncertain" },
          elapsedMs: 0,
        },
      });
    };
    void (async () => {
      let result: Record<string, unknown>;
      if (request.kind === "list") {
        const parsed = zcodeBrowserListParamsSchema.safeParse(request.input);
        if (!parsed.success) {
          browserControlLogger.warn(undefined, "browser control relay input invalid", {
            ...requestContext,
            issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
          });
          await respondRelayFailure("browser control list input failed host validation");
          return;
        }
        warnIfRemoteSessionIdImplausible(parsed.data.remoteSessionId, requestContext);
        result = { browsers: await params.browserControlRelay.list(parsed.data) };
      } else {
        const parsed = zcodeBrowserExecuteParamsSchema.safeParse(request.input);
        if (!parsed.success) {
          browserControlLogger.warn(undefined, "browser control relay input invalid", {
            ...requestContext,
            issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
          });
          await respondRelayFailure("browser control execute input failed host validation");
          return;
        }
        warnIfRemoteSessionIdImplausible(parsed.data.remoteSessionId, requestContext);
        result = await params.browserControlRelay.execute(parsed.data);
      }
      await params.connectionServices.zcodeAgentService.respondBrowserControl({
        requestId: request.requestId,
        result,
      });
      browserControlLogger.debug(undefined, "browser control host response sent", {
        ...requestContext,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    })().catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      browserControlLogger.warn(undefined, "browser control host relay failed", {
        ...requestContext,
        durationMs: Math.max(0, Date.now() - startedAt),
        error: message,
      });
      // 中继已失败时 respond 也可能失败（transport 断开）；两次都只记日志，不重试。
      await respondRelayFailure(message).catch((respondError: unknown) => {
        browserControlLogger.warn(undefined, "browser control relay failure respond failed", {
          ...requestContext,
          error: respondError instanceof Error ? respondError.message : String(respondError),
        });
      });
    });
  });

  // Web 手机远控进入 SSH task 时只连到 remote workspace host，
  // 没有桌面 renderer 那层 `baseServices + remoteServices` 合并。
  // 因此这里为 remote workspace host 补齐本地全局 channel；文件、终端、ZCode Agent 仍来自远端，
  // 设置、凭据、OAuth、模型供应商和 settings-sync 继续读写本机配置。
  const services = new ServiceCollection()
    .register(IFileService, params.connectionServices.fileService)
    .register(IGitService, params.connectionServices.gitService)
    .register(IGitCheckpointService, params.connectionServices.gitCheckpointService)
    .register(ISystemService, params.connectionServices.systemService)
    .register(ITerminalService, params.connectionServices.terminalService)
    .register(ISettingService, localSettingService)
    .register(ICredentialService, localCredentialService)
    .register(IBroadcastService, localBroadcastService)
    .register(IZCodeTaskService, remoteZCodeTaskService)
    .register(IZCodeAgentService, params.connectionServices.zcodeAgentService)
    .register(IZCodeSessionService, remoteZCodeSessionService)
    .register(IConversationShareService, conversationShareService)
    .register(
      IBotsService,
      createBotsService({
        credentialService: localCredentialService,
        zcodeTaskService: remoteZCodeTaskService,
        broadcastService: localBroadcastService,
        settingService: localSettingService,
        modelSelectionService: params.connectionServices.modelSelectionService,
        // 修复原因：remote workspace host 首屏只需要远端文件/agent 能力；
        // bot 启动后台任务如果立即轮询或 getAll，会重复拉本机 preset 并放大 SSH/Docker 连接耗时。
        runStartupBackgroundTasks: false,
      }),
    )
    .register(IFileWatcherService, params.connectionServices.fileWatcherService)
    .register(
      IOAuthService,
      createOAuthService(localCredentialService, {
        apiClient: localApiClient,
        onProviderLogout: handleOAuthProviderLogout,
      }),
    )
    // Provider/Model 事实属于目标 Environment。远端 workspace 的选择和设置视图
    // 必须直接读取远端 Registry，不能继续显示 Desktop 本地 Provider。
    .register(IModelSelectionService, params.connectionServices.modelSelectionService)
    .register(IProviderSettingsService, params.connectionServices.providerSettingsService)
    .register(
      IUsageStatsService,
      createUsageStatsService({
        apiClient: localApiClient,
        accountRequestAuthService: localAccountRequestAuthService,
        credentialService: localCredentialService,
        zcodeAgentService: params.connectionServices.zcodeAgentService,
      }),
    )
    .register(ICodingPlanSubscriptionService, localCodingPlanSubscriptionService)
    .register(IClientConfigService, params.clientConfigService)
    .register(IClientScenesService, createClientScenesService({ apiClient: localApiClient }))
    // 远端 workspace 的项目级 skills/plugins/commands 位于 SSH/Docker 文件系统。
    // 这里必须透出远端服务，避免本机服务拿远端 workspacePath 去本机目录扫描。
    .register(ISkillsService, params.connectionServices.skillsService)
    .register(ISkillSyncService, params.connectionServices.skillSyncService)
    .register(IMcpSyncService, params.connectionServices.mcpSyncService)
    .register(IPluginSyncService, params.connectionServices.pluginSyncService)
    .register(IPluginsService, params.connectionServices.pluginsService)
    // 远端设置页插件管理也必须打到远端 agent（插件目录在远端文件系统）。
    .register(IPluginManagementService, params.connectionServices.pluginManagementService)
    .register(ICommandsService, params.connectionServices.commandsService)
    .register(ISubagentsService, createSubagentsService({ isDesktopRuntime: true }))
    .register(IHooksService, params.connectionServices.hooksService)
    .register(IMemoryService, createMemoryService())
    .register(
      ISettingsSyncService,
      createSettingsSyncService({ settingService: localSettingService }),
    )
    .register(IPromptAttachmentTransferService, params.promptAttachmentTransferService);
  registerHostApiNetworkTransportForDispose(services, hostApiNetworkTransport);
  registerRemoteProviderProvisioningExecutor(services, remoteProviderProvisioningService);
  return services;
}
