"use strict";
/// <reference types="node" />
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RpcClient = void 0;
var child_process_1 = require("child_process");
var readline_1 = require("readline");
var path_1 = require("path");
var fs_1 = require("fs");
// Fix for CommonJS/ESM interop - use the module directly if .default doesn't exist
var path = path_1.default || path_1;
var fs = fs_1.default || fs_1;
var readline = readline_1.default || readline_1;
var setup_1 = require("../setup");
var RpcClient = /** @class */ (function () {
    function RpcClient(scriptPath, options) {
        if (options === void 0) { options = {}; }
        var _this = this;
        this.nextId = 1;
        this.pending = new Map();
        this.closed = false;
        this.globalTrackingEnabled = !options.disableGlobalTracking;
        // Convert TypeScript source path to compiled JavaScript path
        var compiledScriptPath = this.resolveCompiledScript(scriptPath);
        // Verify compiled script exists
        if (!fs.existsSync(compiledScriptPath)) {
            throw new Error("Compiled script not found: ".concat(compiledScriptPath, ". Run 'npm run build' first."));
        }
        // Use node directly with compiled JavaScript
        this.proc = (0, child_process_1.spawn)('node', [compiledScriptPath], {
            stdio: ['pipe', 'pipe', 'pipe'], // all piped to satisfy typings; stderr will pipe to main process stderr implicitly
            env: __assign(__assign({}, process.env), { NODE_ENV: 'integration' })
        });
        if (!this.proc.stdout) {
            throw new Error('Failed to access stdout of child process');
        }
        this.rl = readline.createInterface({ input: this.proc.stdout });
        this.rl.on('line', function (line) { return _this.handleLine(line); });
        // Handle process errors
        this.proc.on('error', function (error) {
            console.error('RPC Client process error:', error);
            _this.cleanup();
        });
        // Create cleanup function and optionally track it
        this.cleanupFn = function () { return __awaiter(_this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!!this.closed) return [3 /*break*/, 2];
                        return [4 /*yield*/, this.close()];
                    case 1:
                        _a.sent();
                        _a.label = 2;
                    case 2: return [2 /*return*/];
                }
            });
        }); };
        // Only track with global system if enabled
        if (this.globalTrackingEnabled) {
            (0, setup_1.trackResource)(this.cleanupFn);
        }
    }
    RpcClient.prototype.handleLine = function (line) {
        var trimmed = line.trim();
        if (!trimmed.startsWith('{'))
            return; // skip log lines
        var msg;
        try {
            msg = JSON.parse(trimmed);
        }
        catch (_a) {
            return; // ignore non-JSON lines
        }
        var id = msg.id;
        if (id === null || typeof id === 'undefined') {
            // Notifications / parse errors – expose via event later if needed
            return;
        }
        var pending = this.pending.get(id);
        if (pending) {
            clearTimeout(pending.timer);
            pending.resolve(msg);
            this.pending.delete(id);
        }
    };
    RpcClient.prototype.send = function (method_1) {
        return __awaiter(this, arguments, void 0, function (method, params) {
            var id, request, payload, promise, pending;
            var _this = this;
            if (params === void 0) { params = {}; }
            return __generator(this, function (_a) {
                if (this.closed) {
                    throw new Error('RPC Client is closed');
                }
                id = this.nextId++;
                request = { jsonrpc: '2.0', id: id, method: method, params: params };
                payload = JSON.stringify(request) + '\n';
                promise = new Promise(function (resolve, reject) {
                    var timer = setTimeout(function () {
                        if (_this.pending.has(id)) {
                            _this.pending.delete(id);
                            reject(new Error("RPC timeout for id ".concat(id)));
                        }
                    }, 5000);
                    _this.pending.set(id, { resolve: resolve, reject: reject, timer: timer });
                });
                try {
                    this.proc.stdin.write(payload);
                }
                catch (error) {
                    pending = this.pending.get(id);
                    if (pending) {
                        clearTimeout(pending.timer);
                        this.pending.delete(id);
                    }
                    throw error;
                }
                return [2 /*return*/, promise];
            });
        });
    };
    RpcClient.prototype.sendRaw = function (rawLine) {
        if (this.closed) {
            throw new Error('RPC Client is closed');
        }
        this.proc.stdin.write(rawLine + '\n');
    };
    RpcClient.prototype.cleanup = function () {
        // Clear timers and reject all pending requests
        for (var _i = 0, _a = this.pending; _i < _a.length; _i++) {
            var _b = _a[_i], id = _b[0], pending = _b[1];
            clearTimeout(pending.timer);
            pending.reject(new Error("RPC Client closed, request ".concat(id, " cancelled")));
        }
        this.pending.clear();
    };
    RpcClient.prototype.close = function () {
        return __awaiter(this, void 0, void 0, function () {
            var _this = this;
            return __generator(this, function (_a) {
                if (this.closed)
                    return [2 /*return*/];
                this.closed = true;
                // Cleanup pending requests and clear timers
                this.cleanup();
                // Close readline interface
                this.rl.close();
                // Send termination signal and wait for process to exit
                return [2 /*return*/, new Promise(function (resolve, reject) {
                        var timeout = setTimeout(function () {
                            // Force kill if process doesn't exit gracefully
                            _this.proc.kill('SIGKILL');
                            reject(new Error('RPC Client process did not exit gracefully'));
                        }, 3000);
                        _this.proc.on('exit', function (code) {
                            clearTimeout(timeout);
                            console.log("RPC Client process exited with code ".concat(code));
                            resolve();
                        });
                        _this.proc.on('error', function (error) {
                            clearTimeout(timeout);
                            reject(error);
                        });
                        // Send termination signal
                        _this.proc.kill('SIGTERM');
                    }).finally(function () {
                        // Only untrack if we were tracking
                        if (_this.globalTrackingEnabled) {
                            (0, setup_1.untrackResource)(_this.cleanupFn);
                        }
                    })];
            });
        });
    };
    /**
     * Convert TypeScript source path to compiled JavaScript path
     */
    RpcClient.prototype.resolveCompiledScript = function (scriptPath) {
        // Handle absolute paths and relative paths
        var absolutePath = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(scriptPath);
        // Convert src/index.ts -> dist/index.js
        if (absolutePath.includes('/src/') && absolutePath.endsWith('.ts')) {
            return absolutePath.replace('/src/', '/dist/').replace('.ts', '.js');
        }
        // If it's already a .js file, assume it's correct
        if (absolutePath.endsWith('.js')) {
            return absolutePath;
        }
        // Fallback: assume it's in src and needs to go to dist
        var relativePath = path.relative(process.cwd(), absolutePath);
        if (relativePath.startsWith('src/')) {
            return path.join(process.cwd(), 'dist', relativePath.substring(4).replace('.ts', '.js'));
        }
        throw new Error("Unable to resolve compiled script path for: ".concat(scriptPath));
    };
    return RpcClient;
}());
exports.RpcClient = RpcClient;
