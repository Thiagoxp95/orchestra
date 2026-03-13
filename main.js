//#region \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") {
		for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
			key = keys[i];
			if (!__hasOwnProp.call(to, key) && key !== except) {
				__defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
		}
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let node_child_process = require("node:child_process");
node_child_process = __toESM(node_child_process);
let node_crypto = require("node:crypto");
node_crypto = __toESM(node_crypto);
let node_fs = require("node:fs");
node_fs = __toESM(node_fs);
let node_os = require("node:os");
node_os = __toESM(node_os);
let node_path = require("node:path");
node_path = __toESM(node_path);
let electron = require("electron");
let effect_Effect = require("effect/Effect");
effect_Effect = __toESM(effect_Effect);
let electron_updater = require("electron-updater");
let node_net = require("node:net");
node_net = __toESM(node_net);
let effect = require("effect");

//#region ../../packages/shared/src/Net.ts
var NetError = class extends effect.Data.TaggedError("NetError") {};
function isErrnoExceptionWithCode(cause) {
	return typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string";
}
const closeServer = (server) => {
	try {
		server.close();
	} catch {}
};
const tryReservePort = (port) => effect.Effect.callback((resume) => {
	const server = node_net.createServer();
	let settled = false;
	const settle = (effect$1) => {
		if (settled) return;
		settled = true;
		resume(effect$1);
	};
	server.unref();
	server.once("error", (cause) => {
		settle(effect.Effect.fail(new NetError({
			message: "Could not find an available port.",
			cause
		})));
	});
	server.listen(port, () => {
		const address = server.address();
		const resolved = typeof address === "object" && address !== null ? address.port : 0;
		server.close(() => {
			if (resolved > 0) {
				settle(effect.Effect.succeed(resolved));
				return;
			}
			settle(effect.Effect.fail(new NetError({ message: "Could not find an available port." })));
		});
	});
	return effect.Effect.sync(() => {
		closeServer(server);
	});
});
/**
* NetService - Service tag for startup networking helpers.
*/
var NetService = class NetService extends effect.ServiceMap.Service()("@t3tools/shared/Net/NetService") {
	static layer = effect.Layer.sync(NetService, () => {
		/**
		* Returns true when a TCP server can bind to {host, port}.
		* `EADDRNOTAVAIL` is treated as available so IPv6-absent hosts don't fail
		* loopback availability checks.
		*/
		const canListenOnHost = (port, host) => effect.Effect.callback((resume) => {
			const server = node_net.createServer();
			let settled = false;
			const settle = (value) => {
				if (settled) return;
				settled = true;
				resume(effect.Effect.succeed(value));
			};
			server.unref();
			server.once("error", (cause) => {
				if (isErrnoExceptionWithCode(cause) && cause.code === "EADDRNOTAVAIL") {
					settle(true);
					return;
				}
				settle(false);
			});
			server.once("listening", () => {
				server.close(() => {
					settle(true);
				});
			});
			server.listen({
				host,
				port
			});
			return effect.Effect.sync(() => {
				closeServer(server);
			});
		});
		/**
		* Reserve an ephemeral loopback port and release it immediately.
		* Returns the reserved port number.
		*/
		const reserveLoopbackPort = (host = "127.0.0.1") => effect.Effect.callback((resume) => {
			const probe = node_net.createServer();
			let settled = false;
			const settle = (effect$2) => {
				if (settled) return;
				settled = true;
				resume(effect$2);
			};
			probe.once("error", (cause) => {
				settle(effect.Effect.fail(new NetError({
					message: "Failed to reserve loopback port",
					cause
				})));
			});
			probe.listen(0, host, () => {
				const address = probe.address();
				const port = typeof address === "object" && address !== null ? address.port : 0;
				probe.close(() => {
					if (port > 0) {
						settle(effect.Effect.succeed(port));
						return;
					}
					settle(effect.Effect.fail(new NetError({ message: "Failed to reserve loopback port" })));
				});
			});
			return effect.Effect.sync(() => {
				closeServer(probe);
			});
		});
		return {
			canListenOnHost,
			isPortAvailableOnLoopback: (port) => effect.Effect.zipWith(canListenOnHost(port, "127.0.0.1"), canListenOnHost(port, "::1"), (ipv4, ipv6) => ipv4 && ipv6),
			reserveLoopbackPort,
			findAvailablePort: (preferred) => effect.Effect.catch(tryReservePort(preferred), () => tryReservePort(0))
		};
	});
};

//#endregion
//#region ../../packages/shared/src/logging.ts
var RotatingFileSink = class {
	filePath;
	maxBytes;
	maxFiles;
	throwOnError;
	currentSize = 0;
	constructor(options) {
		if (options.maxBytes < 1) throw new Error(`maxBytes must be >= 1 (received ${options.maxBytes})`);
		if (options.maxFiles < 1) throw new Error(`maxFiles must be >= 1 (received ${options.maxFiles})`);
		this.filePath = options.filePath;
		this.maxBytes = options.maxBytes;
		this.maxFiles = options.maxFiles;
		this.throwOnError = options.throwOnError ?? false;
		node_fs.default.mkdirSync(node_path.default.dirname(this.filePath), { recursive: true });
		this.pruneOverflowBackups();
		this.currentSize = this.readCurrentSize();
	}
	write(chunk) {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		if (buffer.length === 0) return;
		try {
			if (this.currentSize > 0 && this.currentSize + buffer.length > this.maxBytes) this.rotate();
			node_fs.default.appendFileSync(this.filePath, buffer);
			this.currentSize += buffer.length;
			if (this.currentSize > this.maxBytes) this.rotate();
		} catch {
			this.currentSize = this.readCurrentSize();
			if (this.throwOnError) throw new Error(`Failed to write log chunk to ${this.filePath}`);
		}
	}
	rotate() {
		try {
			const oldest = this.withSuffix(this.maxFiles);
			if (node_fs.default.existsSync(oldest)) node_fs.default.rmSync(oldest, { force: true });
			for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
				const source = this.withSuffix(index);
				const target = this.withSuffix(index + 1);
				if (node_fs.default.existsSync(source)) node_fs.default.renameSync(source, target);
			}
			if (node_fs.default.existsSync(this.filePath)) node_fs.default.renameSync(this.filePath, this.withSuffix(1));
			this.currentSize = 0;
		} catch {
			this.currentSize = this.readCurrentSize();
			if (this.throwOnError) throw new Error(`Failed to rotate log file ${this.filePath}`);
		}
	}
	pruneOverflowBackups() {
		try {
			const dir = node_path.default.dirname(this.filePath);
			const baseName = node_path.default.basename(this.filePath);
			for (const entry of node_fs.default.readdirSync(dir)) {
				if (!entry.startsWith(`${baseName}.`)) continue;
				const suffix = Number(entry.slice(baseName.length + 1));
				if (!Number.isInteger(suffix) || suffix <= this.maxFiles) continue;
				node_fs.default.rmSync(node_path.default.join(dir, entry), { force: true });
			}
		} catch {
			if (this.throwOnError) throw new Error(`Failed to prune log backups for ${this.filePath}`);
		}
	}
	readCurrentSize() {
		try {
			return node_fs.default.statSync(this.filePath).size;
		} catch {
			return 0;
		}
	}
	withSuffix(index) {
		return `${this.filePath}.${index}`;
	}
};

//#endregion
//#region src/confirmDialog.ts
const CONFIRM_BUTTON_INDEX = 1;
async function showDesktopConfirmDialog(message, ownerWindow) {
	const normalizedMessage = message.trim();
	if (normalizedMessage.length === 0) return false;
	const options = {
		type: "question",
		buttons: ["No", "Yes"],
		defaultId: CONFIRM_BUTTON_INDEX,
		cancelId: 0,
		noLink: true,
		message: normalizedMessage
	};
	return (ownerWindow ? await electron.dialog.showMessageBox(ownerWindow, options) : await electron.dialog.showMessageBox(options)).response === CONFIRM_BUTTON_INDEX;
}

//#endregion
//#region ../../packages/shared/src/shell.ts
const PATH_CAPTURE_START = "__T3CODE_PATH_START__";
const PATH_CAPTURE_END = "__T3CODE_PATH_END__";
const PATH_CAPTURE_COMMAND = [
	`printf '%s\n' '${PATH_CAPTURE_START}'`,
	"printenv PATH",
	`printf '%s\n' '${PATH_CAPTURE_END}'`
].join("; ");
function extractPathFromShellOutput(output) {
	const startIndex = output.indexOf(PATH_CAPTURE_START);
	if (startIndex === -1) return null;
	const valueStartIndex = startIndex + 21;
	const endIndex = output.indexOf(PATH_CAPTURE_END, valueStartIndex);
	if (endIndex === -1) return null;
	const pathValue = output.slice(valueStartIndex, endIndex).trim();
	return pathValue.length > 0 ? pathValue : null;
}
function readPathFromLoginShell(shell, execFile = node_child_process.execFileSync) {
	return extractPathFromShellOutput(execFile(shell, ["-ilc", PATH_CAPTURE_COMMAND], {
		encoding: "utf8",
		timeout: 5e3
	})) ?? void 0;
}

//#endregion
//#region src/fixPath.ts
function fixPath() {
	if (process.platform !== "darwin") return;
	try {
		const result = readPathFromLoginShell(process.env.SHELL ?? "/bin/zsh");
		if (result) process.env.PATH = result;
	} catch {}
}

//#endregion
//#region src/updateState.ts
function shouldBroadcastDownloadProgress(currentState, nextPercent) {
	if (currentState.status !== "downloading") return true;
	const currentPercent = currentState.downloadPercent;
	if (currentPercent === null) return true;
	const previousStep = Math.floor(currentPercent / 10);
	return Math.floor(nextPercent / 10) !== previousStep || nextPercent === 100;
}
function nextStatusAfterDownloadFailure(currentState) {
	return currentState.availableVersion ? "available" : "error";
}
function getCanRetryAfterDownloadFailure(currentState) {
	return currentState.availableVersion !== null;
}
function getAutoUpdateDisabledReason(args) {
	if (args.isDevelopment || !args.isPackaged) return "Automatic updates are only available in packaged production builds.";
	if (args.disabledByEnv) return "Automatic updates are disabled by the T3CODE_DISABLE_AUTO_UPDATE setting.";
	if (args.platform === "linux" && !args.appImage) return "Automatic updates on Linux require running the AppImage build.";
	return null;
}

//#endregion
//#region src/updateMachine.ts
function createInitialDesktopUpdateState(currentVersion) {
	return {
		enabled: false,
		status: "disabled",
		currentVersion,
		availableVersion: null,
		downloadedVersion: null,
		downloadPercent: null,
		checkedAt: null,
		message: null,
		errorContext: null,
		canRetry: false
	};
}
function reduceDesktopUpdateStateOnCheckStart(state, checkedAt) {
	return {
		...state,
		status: "checking",
		checkedAt,
		message: null,
		downloadPercent: null,
		errorContext: null,
		canRetry: false
	};
}
function reduceDesktopUpdateStateOnCheckFailure(state, message, checkedAt) {
	return {
		...state,
		status: "error",
		message,
		checkedAt,
		downloadPercent: null,
		errorContext: "check",
		canRetry: true
	};
}
function reduceDesktopUpdateStateOnUpdateAvailable(state, version, checkedAt) {
	return {
		...state,
		status: "available",
		availableVersion: version,
		downloadedVersion: null,
		downloadPercent: null,
		checkedAt,
		message: null,
		errorContext: null,
		canRetry: false
	};
}
function reduceDesktopUpdateStateOnNoUpdate(state, checkedAt) {
	return {
		...state,
		status: "up-to-date",
		availableVersion: null,
		downloadedVersion: null,
		downloadPercent: null,
		checkedAt,
		message: null,
		errorContext: null,
		canRetry: false
	};
}
function reduceDesktopUpdateStateOnDownloadStart(state) {
	return {
		...state,
		status: "downloading",
		downloadPercent: 0,
		message: null,
		errorContext: null,
		canRetry: false
	};
}
function reduceDesktopUpdateStateOnDownloadFailure(state, message) {
	return {
		...state,
		status: nextStatusAfterDownloadFailure(state),
		message,
		downloadPercent: null,
		errorContext: "download",
		canRetry: getCanRetryAfterDownloadFailure(state)
	};
}
function reduceDesktopUpdateStateOnDownloadProgress(state, percent) {
	return {
		...state,
		status: "downloading",
		downloadPercent: percent,
		message: null,
		errorContext: null,
		canRetry: false
	};
}
function reduceDesktopUpdateStateOnDownloadComplete(state, version) {
	return {
		...state,
		status: "downloaded",
		availableVersion: version,
		downloadedVersion: version,
		downloadPercent: 100,
		message: null,
		errorContext: null,
		canRetry: true
	};
}
function reduceDesktopUpdateStateOnInstallFailure(state, message) {
	return {
		...state,
		status: "downloaded",
		message,
		errorContext: "install",
		canRetry: true
	};
}

//#endregion
//#region src/main.ts
fixPath();
const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONFIRM_CHANNEL = "desktop:confirm";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const MENU_ACTION_CHANNEL = "desktop:menu-action";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
const STATE_DIR = process.env.T3CODE_STATE_DIR?.trim() || node_path.join(node_os.homedir(), ".t3", "userdata");
const DESKTOP_SCHEME = "t3";
const ROOT_DIR = node_path.resolve(__dirname, "../../..");
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const APP_DISPLAY_NAME = isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)";
const APP_USER_MODEL_ID = "com.t3tools.t3code";
const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
const COMMIT_HASH_DISPLAY_LENGTH = 12;
const LOG_DIR = node_path.join(STATE_DIR, "logs");
const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
const LOG_FILE_MAX_FILES = 10;
const APP_RUN_ID = node_crypto.randomBytes(6).toString("hex");
const AUTO_UPDATE_STARTUP_DELAY_MS = 15e3;
const AUTO_UPDATE_POLL_INTERVAL_MS = 14400 * 1e3;
let mainWindow = null;
let backendProcess = null;
let backendPort = 0;
let backendAuthToken = "";
let backendWsUrl = "";
let restartAttempt = 0;
let restartTimer = null;
let isQuitting = false;
let desktopProtocolRegistered = false;
let aboutCommitHashCache;
let desktopLogSink = null;
let backendLogSink = null;
let restoreStdIoCapture = null;
let destructiveMenuIconCache;
const initialUpdateState = () => createInitialDesktopUpdateState(electron.app.getVersion());
function logTimestamp() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
function logScope(scope) {
	return `${scope} run=${APP_RUN_ID}`;
}
function sanitizeLogValue(value) {
	return value.replace(/\s+/g, " ").trim();
}
function writeDesktopLogHeader(message) {
	if (!desktopLogSink) return;
	desktopLogSink.write(`[${logTimestamp()}] [${logScope("desktop")}] ${message}\n`);
}
function writeBackendSessionBoundary(phase, details) {
	if (!backendLogSink) return;
	const normalizedDetails = sanitizeLogValue(details);
	backendLogSink.write(`[${logTimestamp()}] ---- APP SESSION ${phase} run=${APP_RUN_ID} ${normalizedDetails} ----\n`);
}
function formatErrorMessage(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}
function writeDesktopStreamChunk(streamName, chunk, encoding) {
	if (!desktopLogSink) return;
	const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof chunk === "string" ? encoding : void 0);
	desktopLogSink.write(`[${logTimestamp()}] [${logScope(streamName)}] `);
	desktopLogSink.write(buffer);
	if (buffer.length === 0 || buffer[buffer.length - 1] !== 10) desktopLogSink.write("\n");
}
function installStdIoCapture() {
	if (!electron.app.isPackaged || desktopLogSink === null || restoreStdIoCapture !== null) return;
	const originalStdoutWrite = process.stdout.write.bind(process.stdout);
	const originalStderrWrite = process.stderr.write.bind(process.stderr);
	const patchWrite = (streamName, originalWrite) => (chunk, encodingOrCallback, callback) => {
		const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : void 0;
		writeDesktopStreamChunk(streamName, chunk, encoding);
		if (typeof encodingOrCallback === "function") return originalWrite(chunk, encodingOrCallback);
		if (callback !== void 0) return originalWrite(chunk, encoding, callback);
		if (encoding !== void 0) return originalWrite(chunk, encoding);
		return originalWrite(chunk);
	};
	process.stdout.write = patchWrite("stdout", originalStdoutWrite);
	process.stderr.write = patchWrite("stderr", originalStderrWrite);
	restoreStdIoCapture = () => {
		process.stdout.write = originalStdoutWrite;
		process.stderr.write = originalStderrWrite;
		restoreStdIoCapture = null;
	};
}
function initializePackagedLogging() {
	if (!electron.app.isPackaged) return;
	try {
		desktopLogSink = new RotatingFileSink({
			filePath: node_path.join(LOG_DIR, "desktop-main.log"),
			maxBytes: LOG_FILE_MAX_BYTES,
			maxFiles: LOG_FILE_MAX_FILES
		});
		backendLogSink = new RotatingFileSink({
			filePath: node_path.join(LOG_DIR, "server-child.log"),
			maxBytes: LOG_FILE_MAX_BYTES,
			maxFiles: LOG_FILE_MAX_FILES
		});
		installStdIoCapture();
		writeDesktopLogHeader(`runtime log capture enabled logDir=${LOG_DIR}`);
	} catch (error) {
		console.error("[desktop] failed to initialize packaged logging", error);
	}
}
function captureBackendOutput(child) {
	if (!electron.app.isPackaged || backendLogSink === null) return;
	const writeChunk = (chunk) => {
		if (!backendLogSink) return;
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
		backendLogSink.write(buffer);
	};
	child.stdout?.on("data", writeChunk);
	child.stderr?.on("data", writeChunk);
}
initializePackagedLogging();
function getDestructiveMenuIcon() {
	if (process.platform !== "darwin") return void 0;
	if (destructiveMenuIconCache !== void 0) return destructiveMenuIconCache ?? void 0;
	try {
		const icon = electron.nativeImage.createFromNamedImage("trash").resize({
			width: 14,
			height: 14
		});
		if (icon.isEmpty()) {
			destructiveMenuIconCache = null;
			return;
		}
		icon.setTemplateImage(true);
		destructiveMenuIconCache = icon;
		return icon;
	} catch {
		destructiveMenuIconCache = null;
		return;
	}
}
let updatePollTimer = null;
let updateStartupTimer = null;
let updateCheckInFlight = false;
let updateDownloadInFlight = false;
let updaterConfigured = false;
let updateState = initialUpdateState();
function resolveUpdaterErrorContext() {
	if (updateDownloadInFlight) return "download";
	if (updateCheckInFlight) return "check";
	return updateState.errorContext;
}
electron.protocol.registerSchemesAsPrivileged([{
	scheme: DESKTOP_SCHEME,
	privileges: {
		standard: true,
		secure: true,
		supportFetchAPI: true,
		corsEnabled: true
	}
}]);
function resolveAppRoot() {
	if (!electron.app.isPackaged) return ROOT_DIR;
	return electron.app.getAppPath();
}
/** Read the baked-in app-update.yml config (if applicable). */
function readAppUpdateYml() {
	try {
		const ymlPath = electron.app.isPackaged ? node_path.join(process.resourcesPath, "app-update.yml") : node_path.join(electron.app.getAppPath(), "dev-app-update.yml");
		const raw = node_fs.readFileSync(ymlPath, "utf-8");
		const entries = {};
		for (const line of raw.split("\n")) {
			const match = line.match(/^(\w+):\s*(.+)$/);
			if (match?.[1] && match[2]) entries[match[1]] = match[2].trim();
		}
		return entries.provider ? entries : null;
	} catch {
		return null;
	}
}
function normalizeCommitHash(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!COMMIT_HASH_PATTERN.test(trimmed)) return null;
	return trimmed.slice(0, COMMIT_HASH_DISPLAY_LENGTH).toLowerCase();
}
function resolveEmbeddedCommitHash() {
	const packageJsonPath = node_path.join(resolveAppRoot(), "package.json");
	if (!node_fs.existsSync(packageJsonPath)) return null;
	try {
		const raw = node_fs.readFileSync(packageJsonPath, "utf8");
		return normalizeCommitHash(JSON.parse(raw).t3codeCommitHash);
	} catch {
		return null;
	}
}
function resolveAboutCommitHash() {
	if (aboutCommitHashCache !== void 0) return aboutCommitHashCache;
	const envCommitHash = normalizeCommitHash(process.env.T3CODE_COMMIT_HASH);
	if (envCommitHash) {
		aboutCommitHashCache = envCommitHash;
		return aboutCommitHashCache;
	}
	if (!electron.app.isPackaged) {
		aboutCommitHashCache = null;
		return aboutCommitHashCache;
	}
	aboutCommitHashCache = resolveEmbeddedCommitHash();
	return aboutCommitHashCache;
}
function resolveBackendEntry() {
	return node_path.join(resolveAppRoot(), "apps/server/dist/index.mjs");
}
function resolveBackendCwd() {
	if (!electron.app.isPackaged) return resolveAppRoot();
	return node_os.homedir();
}
function resolveDesktopStaticDir() {
	const appRoot = resolveAppRoot();
	const candidates = [node_path.join(appRoot, "apps/server/dist/client"), node_path.join(appRoot, "apps/web/dist")];
	for (const candidate of candidates) if (node_fs.existsSync(node_path.join(candidate, "index.html"))) return candidate;
	return null;
}
function resolveDesktopStaticPath(staticRoot, requestUrl) {
	const url = new URL(requestUrl);
	const rawPath = decodeURIComponent(url.pathname);
	const normalizedPath = node_path.posix.normalize(rawPath).replace(/^\/+/, "");
	if (normalizedPath.includes("..")) return node_path.join(staticRoot, "index.html");
	const requestedPath = normalizedPath.length > 0 ? normalizedPath : "index.html";
	const resolvedPath = node_path.join(staticRoot, requestedPath);
	if (node_path.extname(resolvedPath)) return resolvedPath;
	const nestedIndex = node_path.join(resolvedPath, "index.html");
	if (node_fs.existsSync(nestedIndex)) return nestedIndex;
	return node_path.join(staticRoot, "index.html");
}
function isStaticAssetRequest(requestUrl) {
	try {
		const url = new URL(requestUrl);
		return node_path.extname(url.pathname).length > 0;
	} catch {
		return false;
	}
}
function handleFatalStartupError(stage, error) {
	const message = formatErrorMessage(error);
	const detail = error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
	writeDesktopLogHeader(`fatal startup error stage=${stage} message=${message}`);
	console.error(`[desktop] fatal startup error (${stage})`, error);
	if (!isQuitting) {
		isQuitting = true;
		electron.dialog.showErrorBox("T3 Code failed to start", `Stage: ${stage}\n${message}${detail}`);
	}
	stopBackend();
	restoreStdIoCapture?.();
	electron.app.quit();
}
function registerDesktopProtocol() {
	if (isDevelopment || desktopProtocolRegistered) return;
	const staticRoot = resolveDesktopStaticDir();
	if (!staticRoot) throw new Error("Desktop static bundle missing. Build apps/server (with bundled client) first.");
	const staticRootResolved = node_path.resolve(staticRoot);
	const staticRootPrefix = `${staticRootResolved}${node_path.sep}`;
	const fallbackIndex = node_path.join(staticRootResolved, "index.html");
	electron.protocol.registerFileProtocol(DESKTOP_SCHEME, (request, callback) => {
		try {
			const candidate = resolveDesktopStaticPath(staticRootResolved, request.url);
			const resolvedCandidate = node_path.resolve(candidate);
			const isInRoot = resolvedCandidate === fallbackIndex || resolvedCandidate.startsWith(staticRootPrefix);
			const isAssetRequest = isStaticAssetRequest(request.url);
			if (!isInRoot || !node_fs.existsSync(resolvedCandidate)) {
				if (isAssetRequest) {
					callback({ error: -6 });
					return;
				}
				callback({ path: fallbackIndex });
				return;
			}
			callback({ path: resolvedCandidate });
		} catch {
			callback({ path: fallbackIndex });
		}
	});
	desktopProtocolRegistered = true;
}
function dispatchMenuAction(action) {
	const existingWindow = electron.BrowserWindow.getFocusedWindow() ?? mainWindow ?? electron.BrowserWindow.getAllWindows()[0];
	const targetWindow = existingWindow ?? createWindow();
	if (!existingWindow) mainWindow = targetWindow;
	const send = () => {
		if (targetWindow.isDestroyed()) return;
		targetWindow.webContents.send(MENU_ACTION_CHANNEL, action);
		if (!targetWindow.isVisible()) targetWindow.show();
		targetWindow.focus();
	};
	if (targetWindow.webContents.isLoadingMainFrame()) {
		targetWindow.webContents.once("did-finish-load", send);
		return;
	}
	send();
}
function handleCheckForUpdatesMenuClick() {
	const disabledReason = getAutoUpdateDisabledReason({
		isDevelopment,
		isPackaged: electron.app.isPackaged,
		platform: process.platform,
		appImage: process.env.APPIMAGE,
		disabledByEnv: process.env.T3CODE_DISABLE_AUTO_UPDATE === "1"
	});
	if (disabledReason) {
		console.info("[desktop-updater] Manual update check requested, but updates are disabled.");
		electron.dialog.showMessageBox({
			type: "info",
			title: "Updates unavailable",
			message: "Automatic updates are not available right now.",
			detail: disabledReason,
			buttons: ["OK"]
		});
		return;
	}
	if (!electron.BrowserWindow.getAllWindows().length) mainWindow = createWindow();
	checkForUpdates("menu");
}
function configureApplicationMenu() {
	const template = [];
	if (process.platform === "darwin") template.push({
		label: electron.app.name,
		submenu: [
			{ role: "about" },
			{
				label: "Check for Updates...",
				click: () => handleCheckForUpdatesMenuClick()
			},
			{ type: "separator" },
			{
				label: "Settings...",
				accelerator: "CmdOrCtrl+,",
				click: () => dispatchMenuAction("open-settings")
			},
			{ type: "separator" },
			{ role: "services" },
			{ type: "separator" },
			{ role: "hide" },
			{ role: "hideOthers" },
			{ role: "unhide" },
			{ type: "separator" },
			{ role: "quit" }
		]
	});
	template.push({
		label: "File",
		submenu: [...process.platform === "darwin" ? [] : [{
			label: "Settings...",
			accelerator: "CmdOrCtrl+,",
			click: () => dispatchMenuAction("open-settings")
		}, { type: "separator" }], { role: process.platform === "darwin" ? "close" : "quit" }]
	}, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" }, {
		role: "help",
		submenu: [{
			label: "Check for Updates...",
			click: () => handleCheckForUpdatesMenuClick()
		}]
	});
	electron.Menu.setApplicationMenu(electron.Menu.buildFromTemplate(template));
}
function resolveResourcePath(fileName) {
	const candidates = [
		node_path.join(__dirname, "../resources", fileName),
		node_path.join(process.resourcesPath, "resources", fileName),
		node_path.join(process.resourcesPath, fileName)
	];
	for (const candidate of candidates) if (node_fs.existsSync(candidate)) return candidate;
	return null;
}
function resolveIconPath(ext) {
	return resolveResourcePath(`icon.${ext}`);
}
function configureAppIdentity() {
	electron.app.setName(APP_DISPLAY_NAME);
	const commitHash = resolveAboutCommitHash();
	electron.app.setAboutPanelOptions({
		applicationName: APP_DISPLAY_NAME,
		applicationVersion: electron.app.getVersion(),
		version: commitHash ?? "unknown"
	});
	if (process.platform === "win32") electron.app.setAppUserModelId(APP_USER_MODEL_ID);
	if (process.platform === "darwin" && electron.app.dock) {
		const iconPath = resolveIconPath("png");
		if (iconPath) electron.app.dock.setIcon(iconPath);
	}
}
function clearUpdatePollTimer() {
	if (updateStartupTimer) {
		clearTimeout(updateStartupTimer);
		updateStartupTimer = null;
	}
	if (updatePollTimer) {
		clearInterval(updatePollTimer);
		updatePollTimer = null;
	}
}
function emitUpdateState() {
	for (const window of electron.BrowserWindow.getAllWindows()) {
		if (window.isDestroyed()) continue;
		window.webContents.send(UPDATE_STATE_CHANNEL, updateState);
	}
}
function setUpdateState(patch) {
	updateState = {
		...updateState,
		...patch
	};
	emitUpdateState();
}
function shouldEnableAutoUpdates() {
	return getAutoUpdateDisabledReason({
		isDevelopment,
		isPackaged: electron.app.isPackaged,
		platform: process.platform,
		appImage: process.env.APPIMAGE,
		disabledByEnv: process.env.T3CODE_DISABLE_AUTO_UPDATE === "1"
	}) === null;
}
async function checkForUpdates(reason) {
	if (isQuitting || !updaterConfigured || updateCheckInFlight) return;
	if (updateState.status === "downloading" || updateState.status === "downloaded") {
		console.info(`[desktop-updater] Skipping update check (${reason}) while status=${updateState.status}.`);
		return;
	}
	updateCheckInFlight = true;
	setUpdateState(reduceDesktopUpdateStateOnCheckStart(updateState, (/* @__PURE__ */ new Date()).toISOString()));
	console.info(`[desktop-updater] Checking for updates (${reason})...`);
	try {
		await electron_updater.autoUpdater.checkForUpdates();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		setUpdateState(reduceDesktopUpdateStateOnCheckFailure(updateState, message, (/* @__PURE__ */ new Date()).toISOString()));
		console.error(`[desktop-updater] Failed to check for updates: ${message}`);
	} finally {
		updateCheckInFlight = false;
	}
}
async function downloadAvailableUpdate() {
	if (!updaterConfigured || updateDownloadInFlight || updateState.status !== "available") return {
		accepted: false,
		completed: false
	};
	updateDownloadInFlight = true;
	setUpdateState(reduceDesktopUpdateStateOnDownloadStart(updateState));
	console.info("[desktop-updater] Downloading update...");
	try {
		await electron_updater.autoUpdater.downloadUpdate();
		return {
			accepted: true,
			completed: true
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		setUpdateState(reduceDesktopUpdateStateOnDownloadFailure(updateState, message));
		console.error(`[desktop-updater] Failed to download update: ${message}`);
		return {
			accepted: true,
			completed: false
		};
	} finally {
		updateDownloadInFlight = false;
	}
}
async function installDownloadedUpdate() {
	if (isQuitting || !updaterConfigured || updateState.status !== "downloaded") return {
		accepted: false,
		completed: false
	};
	isQuitting = true;
	clearUpdatePollTimer();
	try {
		await stopBackendAndWaitForExit();
		electron_updater.autoUpdater.quitAndInstall();
		return {
			accepted: true,
			completed: true
		};
	} catch (error) {
		const message = formatErrorMessage(error);
		isQuitting = false;
		setUpdateState(reduceDesktopUpdateStateOnInstallFailure(updateState, message));
		console.error(`[desktop-updater] Failed to install update: ${message}`);
		return {
			accepted: true,
			completed: false
		};
	}
}
function configureAutoUpdater() {
	const enabled = shouldEnableAutoUpdates();
	setUpdateState({
		...createInitialDesktopUpdateState(electron.app.getVersion()),
		enabled,
		status: enabled ? "idle" : "disabled"
	});
	if (!enabled) return;
	updaterConfigured = true;
	const githubToken = process.env.T3CODE_DESKTOP_UPDATE_GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || "";
	if (githubToken) {
		const appUpdateYml = readAppUpdateYml();
		if (appUpdateYml?.provider === "github") electron_updater.autoUpdater.setFeedURL({
			...appUpdateYml,
			provider: "github",
			private: true,
			token: githubToken
		});
	}
	electron_updater.autoUpdater.autoDownload = false;
	electron_updater.autoUpdater.autoInstallOnAppQuit = false;
	electron_updater.autoUpdater.allowPrerelease = electron.app.getVersion().includes("-");
	let lastLoggedDownloadMilestone = -1;
	electron_updater.autoUpdater.on("checking-for-update", () => {
		console.info("[desktop-updater] Looking for updates...");
	});
	electron_updater.autoUpdater.on("update-available", (info) => {
		setUpdateState(reduceDesktopUpdateStateOnUpdateAvailable(updateState, info.version, (/* @__PURE__ */ new Date()).toISOString()));
		lastLoggedDownloadMilestone = -1;
		console.info(`[desktop-updater] Update available: ${info.version}`);
	});
	electron_updater.autoUpdater.on("update-not-available", () => {
		setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, (/* @__PURE__ */ new Date()).toISOString()));
		lastLoggedDownloadMilestone = -1;
		console.info("[desktop-updater] No updates available.");
	});
	electron_updater.autoUpdater.on("error", (error) => {
		const message = formatErrorMessage(error);
		if (!updateCheckInFlight && !updateDownloadInFlight) setUpdateState({
			status: "error",
			message,
			checkedAt: (/* @__PURE__ */ new Date()).toISOString(),
			downloadPercent: null,
			errorContext: resolveUpdaterErrorContext(),
			canRetry: updateState.availableVersion !== null || updateState.downloadedVersion !== null
		});
		console.error(`[desktop-updater] Updater error: ${message}`);
	});
	electron_updater.autoUpdater.on("download-progress", (progress) => {
		const percent = Math.floor(progress.percent);
		if (shouldBroadcastDownloadProgress(updateState, progress.percent) || updateState.message !== null) setUpdateState(reduceDesktopUpdateStateOnDownloadProgress(updateState, progress.percent));
		const milestone = percent - percent % 10;
		if (milestone > lastLoggedDownloadMilestone) {
			lastLoggedDownloadMilestone = milestone;
			console.info(`[desktop-updater] Download progress: ${percent}%`);
		}
	});
	electron_updater.autoUpdater.on("update-downloaded", (info) => {
		setUpdateState(reduceDesktopUpdateStateOnDownloadComplete(updateState, info.version));
		console.info(`[desktop-updater] Update downloaded: ${info.version}`);
	});
	clearUpdatePollTimer();
	updateStartupTimer = setTimeout(() => {
		updateStartupTimer = null;
		checkForUpdates("startup");
	}, AUTO_UPDATE_STARTUP_DELAY_MS);
	updateStartupTimer.unref();
	updatePollTimer = setInterval(() => {
		checkForUpdates("poll");
	}, AUTO_UPDATE_POLL_INTERVAL_MS);
	updatePollTimer.unref();
}
function backendEnv() {
	return {
		...process.env,
		T3CODE_MODE: "desktop",
		T3CODE_NO_BROWSER: "1",
		T3CODE_PORT: String(backendPort),
		T3CODE_STATE_DIR: STATE_DIR,
		T3CODE_AUTH_TOKEN: backendAuthToken
	};
}
function scheduleBackendRestart(reason) {
	if (isQuitting || restartTimer) return;
	const delayMs = Math.min(500 * 2 ** restartAttempt, 1e4);
	restartAttempt += 1;
	console.error(`[desktop] backend exited unexpectedly (${reason}); restarting in ${delayMs}ms`);
	restartTimer = setTimeout(() => {
		restartTimer = null;
		startBackend();
	}, delayMs);
}
function startBackend() {
	if (isQuitting || backendProcess) return;
	const backendEntry = resolveBackendEntry();
	if (!node_fs.existsSync(backendEntry)) {
		scheduleBackendRestart(`missing server entry at ${backendEntry}`);
		return;
	}
	const captureBackendLogs = electron.app.isPackaged && backendLogSink !== null;
	const child = node_child_process.spawn(process.execPath, [backendEntry], {
		cwd: resolveBackendCwd(),
		env: {
			...backendEnv(),
			ELECTRON_RUN_AS_NODE: "1"
		},
		stdio: captureBackendLogs ? [
			"ignore",
			"pipe",
			"pipe"
		] : "inherit"
	});
	backendProcess = child;
	let backendSessionClosed = false;
	const closeBackendSession = (details) => {
		if (backendSessionClosed) return;
		backendSessionClosed = true;
		writeBackendSessionBoundary("END", details);
	};
	writeBackendSessionBoundary("START", `pid=${child.pid ?? "unknown"} port=${backendPort} cwd=${resolveBackendCwd()}`);
	captureBackendOutput(child);
	child.once("spawn", () => {
		restartAttempt = 0;
	});
	child.on("error", (error) => {
		if (backendProcess === child) backendProcess = null;
		closeBackendSession(`pid=${child.pid ?? "unknown"} error=${error.message}`);
		scheduleBackendRestart(error.message);
	});
	child.on("exit", (code, signal) => {
		if (backendProcess === child) backendProcess = null;
		closeBackendSession(`pid=${child.pid ?? "unknown"} code=${code ?? "null"} signal=${signal ?? "null"}`);
		if (isQuitting) return;
		scheduleBackendRestart(`code=${code ?? "null"} signal=${signal ?? "null"}`);
	});
}
function stopBackend() {
	if (restartTimer) {
		clearTimeout(restartTimer);
		restartTimer = null;
	}
	const child = backendProcess;
	backendProcess = null;
	if (!child) return;
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGTERM");
		setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}, 2e3).unref();
	}
}
async function stopBackendAndWaitForExit(timeoutMs = 5e3) {
	if (restartTimer) {
		clearTimeout(restartTimer);
		restartTimer = null;
	}
	const child = backendProcess;
	backendProcess = null;
	if (!child) return;
	const backendChild = child;
	if (backendChild.exitCode !== null || backendChild.signalCode !== null) return;
	await new Promise((resolve) => {
		let settled = false;
		let forceKillTimer = null;
		let exitTimeoutTimer = null;
		function settle() {
			if (settled) return;
			settled = true;
			backendChild.off("exit", onExit);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			if (exitTimeoutTimer) clearTimeout(exitTimeoutTimer);
			resolve();
		}
		function onExit() {
			settle();
		}
		backendChild.once("exit", onExit);
		backendChild.kill("SIGTERM");
		forceKillTimer = setTimeout(() => {
			if (backendChild.exitCode === null && backendChild.signalCode === null) backendChild.kill("SIGKILL");
		}, 2e3);
		forceKillTimer.unref();
		exitTimeoutTimer = setTimeout(() => {
			settle();
		}, timeoutMs);
		exitTimeoutTimer.unref();
	});
}
function registerIpcHandlers() {
	electron.ipcMain.removeHandler(PICK_FOLDER_CHANNEL);
	electron.ipcMain.handle(PICK_FOLDER_CHANNEL, async () => {
		const owner = electron.BrowserWindow.getFocusedWindow() ?? mainWindow;
		const result = owner ? await electron.dialog.showOpenDialog(owner, { properties: ["openDirectory", "createDirectory"] }) : await electron.dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
		if (result.canceled) return null;
		return result.filePaths[0] ?? null;
	});
	electron.ipcMain.removeHandler(CONFIRM_CHANNEL);
	electron.ipcMain.handle(CONFIRM_CHANNEL, async (_event, message) => {
		if (typeof message !== "string") return false;
		return showDesktopConfirmDialog(message, electron.BrowserWindow.getFocusedWindow() ?? mainWindow);
	});
	electron.ipcMain.removeHandler(CONTEXT_MENU_CHANNEL);
	electron.ipcMain.handle(CONTEXT_MENU_CHANNEL, async (_event, items, position) => {
		const normalizedItems = items.filter((item) => typeof item.id === "string" && typeof item.label === "string").map((item) => ({
			id: item.id,
			label: item.label,
			destructive: item.destructive === true
		}));
		if (normalizedItems.length === 0) return null;
		const popupPosition = position && Number.isFinite(position.x) && Number.isFinite(position.y) && position.x >= 0 && position.y >= 0 ? {
			x: Math.floor(position.x),
			y: Math.floor(position.y)
		} : null;
		const window = electron.BrowserWindow.getFocusedWindow() ?? mainWindow;
		if (!window) return null;
		return new Promise((resolve) => {
			const template = [];
			let hasInsertedDestructiveSeparator = false;
			for (const item of normalizedItems) {
				if (item.destructive && !hasInsertedDestructiveSeparator && template.length > 0) {
					template.push({ type: "separator" });
					hasInsertedDestructiveSeparator = true;
				}
				const itemOption = {
					label: item.label,
					click: () => resolve(item.id)
				};
				if (item.destructive) {
					const destructiveIcon = getDestructiveMenuIcon();
					if (destructiveIcon) itemOption.icon = destructiveIcon;
				}
				template.push(itemOption);
			}
			electron.Menu.buildFromTemplate(template).popup({
				window,
				...popupPosition,
				callback: () => resolve(null)
			});
		});
	});
	electron.ipcMain.removeHandler(OPEN_EXTERNAL_CHANNEL);
	electron.ipcMain.handle(OPEN_EXTERNAL_CHANNEL, async (_event, rawUrl) => {
		if (typeof rawUrl !== "string" || rawUrl.length === 0) return false;
		let parsedUrl;
		try {
			parsedUrl = new URL(rawUrl);
		} catch {
			return false;
		}
		if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") return false;
		try {
			await electron.shell.openExternal(parsedUrl.toString());
			return true;
		} catch {
			return false;
		}
	});
	electron.ipcMain.removeHandler(UPDATE_GET_STATE_CHANNEL);
	electron.ipcMain.handle(UPDATE_GET_STATE_CHANNEL, async () => updateState);
	electron.ipcMain.removeHandler(UPDATE_DOWNLOAD_CHANNEL);
	electron.ipcMain.handle(UPDATE_DOWNLOAD_CHANNEL, async () => {
		const result = await downloadAvailableUpdate();
		return {
			accepted: result.accepted,
			completed: result.completed,
			state: updateState
		};
	});
	electron.ipcMain.removeHandler(UPDATE_INSTALL_CHANNEL);
	electron.ipcMain.handle(UPDATE_INSTALL_CHANNEL, async () => {
		if (isQuitting) return {
			accepted: false,
			completed: false,
			state: updateState
		};
		const result = await installDownloadedUpdate();
		return {
			accepted: result.accepted,
			completed: result.completed,
			state: updateState
		};
	});
}
function getIconOption() {
	if (process.platform === "darwin") return {};
	const iconPath = resolveIconPath(process.platform === "win32" ? "ico" : "png");
	return iconPath ? { icon: iconPath } : {};
}
function createWindow() {
	const window = new electron.BrowserWindow({
		width: 1100,
		height: 780,
		minWidth: 840,
		minHeight: 620,
		show: false,
		autoHideMenuBar: true,
		...getIconOption(),
		title: APP_DISPLAY_NAME,
		titleBarStyle: "hiddenInset",
		trafficLightPosition: {
			x: 16,
			y: 18
		},
		webPreferences: {
			preload: node_path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true
		}
	});
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	window.on("page-title-updated", (event) => {
		event.preventDefault();
		window.setTitle(APP_DISPLAY_NAME);
	});
	window.webContents.on("did-finish-load", () => {
		window.setTitle(APP_DISPLAY_NAME);
		emitUpdateState();
	});
	window.once("ready-to-show", () => {
		window.show();
	});
	if (isDevelopment) {
		window.loadURL(process.env.VITE_DEV_SERVER_URL);
		window.webContents.openDevTools({ mode: "detach" });
	} else window.loadURL(`${DESKTOP_SCHEME}://app/index.html`);
	window.on("closed", () => {
		if (mainWindow === window) mainWindow = null;
	});
	return window;
}
configureAppIdentity();
async function bootstrap() {
	writeDesktopLogHeader("bootstrap start");
	backendPort = await effect_Effect.service(NetService).pipe(effect_Effect.flatMap((net) => net.reserveLoopbackPort()), effect_Effect.provide(NetService.layer), effect_Effect.runPromise);
	writeDesktopLogHeader(`reserved backend port via NetService port=${backendPort}`);
	backendAuthToken = node_crypto.randomBytes(24).toString("hex");
	backendWsUrl = `ws://127.0.0.1:${backendPort}/?token=${encodeURIComponent(backendAuthToken)}`;
	process.env.T3CODE_DESKTOP_WS_URL = backendWsUrl;
	writeDesktopLogHeader(`bootstrap resolved websocket url=${backendWsUrl}`);
	registerIpcHandlers();
	writeDesktopLogHeader("bootstrap ipc handlers registered");
	startBackend();
	writeDesktopLogHeader("bootstrap backend start requested");
	mainWindow = createWindow();
	writeDesktopLogHeader("bootstrap main window created");
}
electron.app.on("before-quit", () => {
	isQuitting = true;
	writeDesktopLogHeader("before-quit received");
	clearUpdatePollTimer();
	stopBackend();
	restoreStdIoCapture?.();
});
electron.app.whenReady().then(() => {
	writeDesktopLogHeader("app ready");
	configureAppIdentity();
	configureApplicationMenu();
	registerDesktopProtocol();
	configureAutoUpdater();
	bootstrap().catch((error) => {
		handleFatalStartupError("bootstrap", error);
	});
	electron.app.on("activate", () => {
		if (electron.BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
	});
}).catch((error) => {
	handleFatalStartupError("whenReady", error);
});
electron.app.on("window-all-closed", () => {
	if (process.platform !== "darwin") electron.app.quit();
});
if (process.platform !== "win32") {
	process.on("SIGINT", () => {
		if (isQuitting) return;
		isQuitting = true;
		writeDesktopLogHeader("SIGINT received");
		clearUpdatePollTimer();
		stopBackend();
		restoreStdIoCapture?.();
		electron.app.quit();
	});
	process.on("SIGTERM", () => {
		if (isQuitting) return;
		isQuitting = true;
		writeDesktopLogHeader("SIGTERM received");
		clearUpdatePollTimer();
		stopBackend();
		restoreStdIoCapture?.();
		electron.app.quit();
	});
}

//#endregion
//# sourceMappingURL=main.js.map