# NemoClaw Harness Adapter Template — 非官方版本

**由 knowlet 維護的獨立社群專案。這不是 NVIDIA 官方 SDK，未受 NVIDIA 或 DeepSeek 授權背書、認證或提供支援。**

[English](README.md) · [SDK 文件](docs/SDK.md) · [架構與相容性](docs/ARCHITECTURE.md) · [安全邊界](SECURITY.md)

這個專案把 headless harness 的執行、設定、模型介面、OCI 建置與 OpenShell BYOC 啟動整理成可重用的 SDK。JavaScript 原生 ESM、附 TypeScript 型別、零第三方執行期依賴；既有 Go、Python 或 Node harness 都能透過 stdin／argv 接入。

**它不是安裝到 NemoClaw host CLI 的 plugin。** 本專案的 `adapter.json` 是自有 schema，不是 NVIDIA 的 `agents/*/manifest.yaml`。安裝後不會自動取得 `nemoclaw onboard --agent your-harness`；官方目前沒有承諾這種公開擴充介面的相容性，詳見[官方說明](https://github.com/NVIDIA/NemoClaw/blob/eb10bf0b93f36968c841c96f58b081bc1301c485/docs/reference/extension-taxonomy-sdk-readiness.mdx)。

## 直接開始

本機 SDK 與測試需要 Node.js 22.16+；受管理的容器啟動刻意要求 Linux/POSIX 與 Node.js 24.5+。本機 demo 不需要 Docker、GPU、模型或 API key。

```bash
git clone -b develop https://github.com/knowlet/NemoClaw-Harness-Template.git
cd NemoClaw-Harness-Template
npm ci --ignore-scripts
npm run check
npm run demo
node bin/nha.mjs init ./my-harness --name my-harness
cd my-harness
npm run validate
npm test
printf 'hello' | node agent.mjs
```

會得到 `Echo: hello`。**這是真正執行的程序範例，但不是 LLM，也沒有建立沙箱。**

產生的專案已包含 SDK、CLI、`adapter.json`、`Dockerfile`、`policy.yaml`、依賴鎖檔與非官方聲明。替換 `agent.mjs`，或修改 `runtime.command` 指向容器內的 Go／Python／Node 程式即可。

## SDK 安裝

套件名稱為 `@knowlet/nemoclaw-harness-sdk`，版本 `0.3.0`；**本專案不宣稱已發布到 npm registry**。

```bash
npm run pack:sdk
# 使用固定且不含維護者名稱的檔名：
npm install ./dist/harness-sdk.tgz
```

```js
import { createAdapter, defineAdapter, runHarness } from '@knowlet/nemoclaw-harness-sdk';

const input = structuredClone(createAdapter('my-harness', 'your-managed-model'));
input.runtime.command = ['/opt/my-harness/bin/agent'];
input.runtime.taskInput = 'stdin';
const adapter = defineAdapter(input);

// 在已建立的沙箱內呼叫；runHarness 本身不建立沙箱。
const result = await runHarness(adapter, '檢查 workspace');
console.log(result.stdout);
```

## Harness 測試套件

產生的專案附 `test/suite.json` 與 `test/harness.test.mjs`，執行 `npm test` 即可測試；換成你的 harness 指令與案例後可直接重用。SDK 的 `/testing` 提供 `runSuite`、`defineSuite`、`toJUnit` 及 loopback 模型 API fixture；JSON／JUnit 報告不包含 task 或輸出本文。

```bash
node bin/nha.mjs test test/suite.json --adapter adapter.local.json \
  --allow-host --json result.json --junit result.xml
```

`adapter.local.json` 需指向你本機已安裝的程式；`--allow-host` 不建立沙箱。受管理執行及其他框架橋接請見[測試套件文件](docs/TESTING.md)。[獨立部署 workflow](.github/workflows/runtime-integration.yml) 會編譯真實 NemoClaw、建立 Docker sandbox，部署失敗不會被 SDK 單元測試掩蓋。

## 模型介面與安全邊界

模型 client 固定使用 `https://inference.local/v1`，只傳非機密 placeholder `openshell`。真正的 provider key 應由外層 gateway 管理，SDK 不建立 provider 或推論路由。需先確認你部署的 NemoClaw／OpenShell 組合確實支援並配置了該端點。

SDK 提供非串流 Chat Completions、tool schema 傳遞、回應大小限制、取消、逾時與錯誤內容抑制；不包含完整 agent loop、tool executor、Responses API 或 streaming。完整 API 見 [SDK 文件](docs/SDK.md)。

`nha exec` 必須明確選擇 `--managed` 或 `--allow-host`。後者會直接在本機執行程式，**不是安全隔離**。前者檢查 root-owned／唯讀設定及非 root 程序，但這些檢查也不是沙箱證明。外層 filesystem／network／process 控制仍由 OpenShell 負責。

## OCI／OpenShell

在產生的專案內：

```bash
# 僅供開發；浮動 tag 與 apt 套件不等於 release provenance lock。
docker build --build-arg BASE_IMAGE=node:24-bookworm-slim -t my-harness:dev .
node bin/nha.mjs plan --name my-harness --image my-harness:dev \
  --dev-image --policy policy.yaml --task hello
node bin/nha.mjs launch --name my-harness --image my-harness:dev \
  --dev-image --policy policy.yaml --task hello
```

`plan` 只輸出 argv；`launch` 才建立 OpenShell sandbox。未加 `--dev-image` 時必須提供 image digest。遠端 gateway 必須能從 registry 取得映像檔。echo 不需推論路由，真正的 LLM harness 則需要預先配置。

## 打包成 NemoClaw 原生 agent

上面的 BYOC 路徑由你自己把映像檔交給 OpenShell；原生路徑改為產生 NemoClaw CLI 在 onboarding
時掃描的 `agents/<name>/` 目錄，讓 `nemoclaw onboard --agent <name>` 直接管理你的 harness。

```bash
node bin/nha.mjs native init ./my-harness --name my-harness --model your-managed-model
node bin/nha.mjs native install ./my-harness --nemoclaw ../NemoClaw
node bin/nha.mjs native verify --nemoclaw ../NemoClaw --name my-harness
```

產生的內容包含 `manifest.yaml`、`policy-additions.yaml`、`Dockerfile`、`start.sh`、
`harness.mjs`、`dependency-review.md` 與 `native-agent.json`。NemoClaw 會在 Docker driver 上
自行建置這個 Dockerfile，並套用產生的 deny-by-default policy。

`native verify` 會載入 checkout 真正編譯出來的 loader，回報 `listed`、`loaderAccepted` 與解析到
的 Dockerfile；它一律回報 `deploymentVerified: false`，因為 loader 接受設定不等於部署成功。真正
的部署（建置映像檔、建立 sandbox、在 sandbox 內執行任務）由 runtime workflow 記錄，不由這個指令
推論。

原生打包鎖定單一上游版本 `NVIDIA/NemoClaw@1eb370f20530bd1312ac86a27782ef8501b28ade`；這個
`agents/` 版面是該版本的內部結構，不是 NVIDIA 公開的擴充 API。詳見[原生打包說明](docs/NATIVE.md)。

## DeepSeek 範例與限制

[DeepSeek candidate 文件](examples/deepseek/README.md) 提供 build-context generator、managed Cordis patch、唯讀 profile 與 headless launcher。範例鎖定 source review 版本，要求使用者提供已審查的 DSH image digest；**不捆綁 DSH，也沒有宣稱完成 live E2E**。

特別處理了 `settings.yaml` 可能覆蓋模型路由的問題：不只加最後一層 patch，也停用 settings override，並禁止對整個 DSH_HOME 開放寫入。這仍不是完整插件權限驗證或安全認證。

其他 NemoClaw lifecycle（snapshot／restore、復原、各項動詞）、Web UI 認證與版本遷移尚未實作；原生 agent 打包只鎖定單一上游版本。`persist`／`reconstruct`／`prohibit` 是經驗證的宣告，不是已實作的備份引擎。請查看[實際驗證紀錄](docs/VALIDATION.md)。

本專案採 [MIT](LICENSE)；第三方 harness 保留其原有授權。散布時請保留 [NOTICE](NOTICE)，不要宣稱 NVIDIA 官方支援。
