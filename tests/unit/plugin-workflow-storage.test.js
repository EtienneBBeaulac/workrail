"use strict";
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
var plugin_workflow_storage_1 = require("../../src/infrastructure/storage/plugin-workflow-storage");
var error_handler_1 = require("../../src/core/error-handler");
var promises_1 = require("fs/promises");
var fs_1 = require("fs");
var path_1 = require("path");
// Helper function to create mock Dirent objects
function createMockDirent(name, isDirectory) {
    if (isDirectory === void 0) { isDirectory = true; }
    return {
        name: name,
        isFile: function () { return !isDirectory; },
        isDirectory: function () { return isDirectory; },
        isBlockDevice: function () { return false; },
        isCharacterDevice: function () { return false; },
        isSymbolicLink: function () { return false; },
        isFIFO: function () { return false; },
        isSocket: function () { return false; }
    };
}
// Mock dependencies
jest.mock('fs/promises');
jest.mock('fs');
var mockFs = promises_1.default;
var mockExistsSync = fs_1.existsSync;
describe('PluginWorkflowStorage', function () {
    var storage;
    var mockPluginPath;
    var mockWorkflowsPath;
    beforeEach(function () {
        jest.clearAllMocks();
        mockPluginPath = '/test/node_modules/workrail-workflows-test';
        mockWorkflowsPath = path_1.default.join(mockPluginPath, 'workflows');
        // Default mock behavior
        mockExistsSync.mockReturnValue(true);
        mockFs.readdir.mockResolvedValue([]);
    });
    afterEach(function () {
        jest.resetAllMocks();
    });
    describe('Configuration and Initialization', function () {
        it('should initialize with default configuration', function () {
            storage = new plugin_workflow_storage_1.PluginWorkflowStorage();
            var config = storage.getConfig();
            expect(config.scanInterval).toBeGreaterThanOrEqual(30000);
            expect(config.maxFileSize).toBe(1024 * 1024); // 1MB
            expect(config.maxFiles).toBe(50);
            expect(config.maxPlugins).toBe(20);
            expect(config.pluginPaths).toEqual(expect.arrayContaining([
                expect.stringContaining('node_modules')
            ]));
        });
        it('should accept custom configuration', function () {
            var customConfig = {
                pluginPaths: ['/custom/path'],
                scanInterval: 60000,
                maxFileSize: 2 * 1024 * 1024,
                maxFiles: 100,
                maxPlugins: 50
            };
            storage = new plugin_workflow_storage_1.PluginWorkflowStorage(customConfig);
            var config = storage.getConfig();
            expect(config.pluginPaths).toEqual(['/custom/path']);
            expect(config.scanInterval).toBe(60000);
            expect(config.maxFileSize).toBe(2 * 1024 * 1024);
            expect(config.maxFiles).toBe(100);
            expect(config.maxPlugins).toBe(50);
        });
        it('should enforce minimum configuration values', function () {
            var invalidConfig = {
                scanInterval: 10000, // below minimum
                maxFiles: 0, // below minimum
                maxPlugins: 0 // below minimum
            };
            storage = new plugin_workflow_storage_1.PluginWorkflowStorage(invalidConfig);
            var config = storage.getConfig();
            expect(config.scanInterval).toBe(30000); // enforced minimum
            expect(config.maxFiles).toBe(1); // enforced minimum
            expect(config.maxPlugins).toBe(1); // enforced minimum
        });
        it('should use predefined configurations correctly', function () {
            expect(plugin_workflow_storage_1.PLUGIN_WORKFLOW_CONFIGS.development.scanInterval).toBe(60000);
            expect(plugin_workflow_storage_1.PLUGIN_WORKFLOW_CONFIGS.production.maxFileSize).toBe(1024 * 1024);
        });
    });
    describe('Security Features', function () {
        beforeEach(function () {
            storage = new plugin_workflow_storage_1.PluginWorkflowStorage({
                pluginPaths: ['/test/node_modules'],
                maxFileSize: 1024 * 1024,
                maxFiles: 5,
                maxPlugins: 3
            });
        });
        it('should prevent scanning too many plugins', function () { return __awaiter(void 0, void 0, void 0, function () {
            var mockPackageJson;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        mockExistsSync.mockReturnValue(true);
                        mockFs.readdir.mockResolvedValue([
                            createMockDirent('workrail-workflows-plugin1'),
                            createMockDirent('workrail-workflows-plugin2'),
                            createMockDirent('workrail-workflows-plugin3'),
                            createMockDirent('workrail-workflows-plugin4') // exceeds limit of 3
                        ]);
                        mockPackageJson = {
                            name: 'test-plugin',
                            version: '1.0.0',
                            workrail: { workflows: true }
                        };
                        mockFs.stat.mockResolvedValue({ size: 1000 });
                        mockFs.readFile.mockImplementation((function (filePath) {
                            var pathStr = filePath.toString();
                            if (pathStr.endsWith('package.json')) {
                                return Promise.resolve(JSON.stringify(mockPackageJson));
                            }
                            return Promise.resolve('[]');
                        }));
                        return [4 /*yield*/, expect(storage.loadAllWorkflows()).rejects.toThrow(error_handler_1.StorageError)];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, expect(storage.loadAllWorkflows()).rejects.toThrow(/Too many plugins found/)];
                    case 2:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); });
        it('should validate file sizes during scanning', function () { return __awaiter(void 0, void 0, void 0, function () {
            var mockPackageJson;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        mockExistsSync.mockReturnValue(true);
                        mockFs.readdir.mockImplementation((function (dirPath) {
                            var pathStr = dirPath.toString();
                            if (pathStr.endsWith('node_modules')) {
                                return Promise.resolve(['workrail-workflows-test']);
                            }
                            if (pathStr.endsWith('workflows')) {
                                return Promise.resolve(['test-workflow.json']);
                            }
                            return Promise.resolve([]);
                        }));
                        mockPackageJson = {
                            name: 'test-plugin',
                            version: '1.0.0',
                            workrail: { workflows: true }
                        };
                        mockFs.stat.mockImplementation((function (filePath) {
                            var pathStr = filePath.toString();
                            if (pathStr.endsWith('package.json')) {
                                return Promise.resolve({ size: 1000 });
                            }
                            // Oversized workflow file
                            return Promise.resolve({ size: 2 * 1024 * 1024 }); // 2MB, exceeds 1MB limit
                        }));
                        mockFs.readFile.mockImplementation((function (filePath) {
                            var pathStr = filePath.toString();
                            if (pathStr.endsWith('package.json')) {
                                return Promise.resolve(JSON.stringify(mockPackageJson));
                            }
                            return Promise.resolve('{"id": "test", "name": "Test"}');
                        }));
                        return [4 /*yield*/, expect(storage.loadAllWorkflows()).rejects.toThrow(error_handler_1.SecurityError)];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, expect(storage.loadAllWorkflows()).rejects.toThrow(/exceeds size limit/)];
                    case 2:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); });
        it('should validate workflow file counts', function () { return __awaiter(void 0, void 0, void 0, function () {
            var mockPackageJson;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        mockExistsSync.mockReturnValue(true);
                        mockFs.readdir.mockImplementation((function (dirPath) {
                            var pathStr = dirPath.toString();
                            if (pathStr.endsWith('node_modules')) {
                                return Promise.resolve(['workrail-workflows-test']);
                            }
                            if (pathStr.endsWith('workflows')) {
                                // Return more files than the limit of 5
                                return Promise.resolve([
                                    'workflow1.json', 'workflow2.json', 'workflow3.json',
                                    'workflow4.json', 'workflow5.json', 'workflow6.json'
                                ]);
                            }
                            return Promise.resolve([]);
                        }));
                        mockPackageJson = {
                            name: 'test-plugin',
                            version: '1.0.0',
                            workrail: { workflows: true }
                        };
                        mockFs.stat.mockResolvedValue({ size: 1000 });
                        mockFs.readFile.mockImplementation((function (filePath) {
                            var pathStr = filePath.toString();
                            if (pathStr.endsWith('package.json')) {
                                return Promise.resolve(JSON.stringify(mockPackageJson));
                            }
                            return Promise.resolve('{"id": "test", "name": "Test"}');
                        }));
                        return [4 /*yield*/, expect(storage.loadAllWorkflows()).rejects.toThrow(error_handler_1.StorageError)];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, expect(storage.loadAllWorkflows()).rejects.toThrow(/Too many workflow files/)];
                    case 2:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); });
        it('should validate package.json size limits', function () { return __awaiter(void 0, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        mockExistsSync.mockReturnValue(true);
                        mockFs.readdir.mockResolvedValue([createMockDirent('workrail-workflows-test')]);
                        // Oversized package.json (over 64KB limit)
                        mockFs.stat.mockImplementation((function (filePath) {
                            var pathStr = filePath.toString();
                            if (pathStr.endsWith('package.json')) {
                                return Promise.resolve({ size: 128 * 1024 }); // 128KB
                            }
                            return Promise.resolve({ size: 1000 });
                        }));
                        return [4 /*yield*/, expect(storage.loadAllWorkflows()).rejects.toThrow(error_handler_1.SecurityError)];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, expect(storage.loadAllWorkflows()).rejects.toThrow(/exceeds size limit/)];
                    case 2:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); });
        it('should validate workflow IDs for security', function () { return __awaiter(void 0, void 0, void 0, function () {
            var maliciousWorkflow, mockPackageJson;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        maliciousWorkflow = {
                            id: '../../../malicious', // path traversal attempt
                            name: 'Malicious Workflow',
                            version: '1.0.0'
                        };
                        mockExistsSync.mockReturnValue(true);
                        mockFs.readdir.mockImplementation((function (dirPath) {
                            var pathStr = dirPath.toString();
                            if (pathStr.endsWith('node_modules')) {
                                return Promise.resolve(['workrail-workflows-test']);
                            }
                            if (pathStr.endsWith('workflows')) {
                                return Promise.resolve(['malicious.json']);
                            }
                            return Promise.resolve([]);
                        }));
                        mockPackageJson = {
                            name: 'test-plugin',
                            version: '1.0.0',
                            workrail: { workflows: true }
                        };
                        mockFs.stat.mockResolvedValue({ size: 1000 });
                        mockFs.readFile.mockImplementation((function (filePath) {
                            var pathStr = filePath.toString();
                            if (pathStr.endsWith('package.json')) {
                                return Promise.resolve(JSON.stringify(mockPackageJson));
                            }
                            return Promise.resolve(JSON.stringify(maliciousWorkflow));
                        }));
                        return [4 /*yield*/, expect(storage.loadAllWorkflows()).rejects.toThrow(error_handler_1.InvalidWorkflowError)];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); });
    });
    describe('Plugin Detection and Loading', function () {
        beforeEach(function () {
            storage = new plugin_workflow_storage_1.PluginWorkflowStorage({
                pluginPaths: ['/test/node_modules'],
                maxPlugins: 10
            });
        });
        it('should detect workrail workflow plugins correctly', function () { return __awaiter(void 0, void 0, void 0, function () {
            var mockPackageJson, plugins;
            return __generator(this, function (_a) {
                mockExistsSync.mockReturnValue(true);
                mockFs.readdir.mockResolvedValue([
                    createMockDirent('workrail-workflows-coding'), // should be detected
                    createMockDirent('@workrail/workflows-ai'), // should be detected
                    createMockDirent('regular-package'), // should be ignored
                    createMockDirent('workrail-other-package') // should be ignored
                ]);
                mockPackageJson = {
                    name: 'workrail-workflows-coding',
                    version: '1.0.0',
                    workrail: { workflows: true }
                };
                mockFs.stat.mockResolvedValue({ size: 1000 });
                mockFs.readFile.mockImplementation(function (filePath) {
                    var pathStr = filePath.toString();
                    if (pathStr.includes('workrail-workflows-coding') && pathStr.endsWith('package.json')) {
                        return Promise.resolve(JSON.stringify(mockPackageJson));
                    }
                    if (pathStr.includes('@workrail/workflows-ai') && pathStr.endsWith('package.json')) {
                        return Promise.resolve(JSON.stringify(__assign(__assign({}, mockPackageJson), { name: '@workrail/workflows-ai' })));
                    }
                    return Promise.resolve('[]');
                });
                plugins = storage.getLoadedPlugins();
                // Should only process the 2 workrail workflow packages
                expect(mockFs.readFile).toHaveBeenCalledWith(expect.stringContaining('workrail-workflows-coding'), 'utf-8');
                return [2 /*return*/];
            });
        }); });
        it('should handle invalid package.json gracefully', function () { return __awaiter(void 0, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        mockExistsSync.mockReturnValue(true);
                        mockFs.readdir.mockResolvedValue([createMockDirent('workrail-workflows-invalid')]);
                        mockFs.stat.mockResolvedValue({ size: 1000 });
                        mockFs.readFile.mockResolvedValue('invalid json content');
                        return [4 /*yield*/, expect(storage.loadAllWorkflows()).rejects.toThrow(error_handler_1.InvalidWorkflowError)];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, expect(storage.loadAllWorkflows()).rejects.toThrow(/Invalid package.json/)];
                    case 2:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); });
        it('should ignore plugins without workrail.workflows flag', function () { return __awaiter(void 0, void 0, void 0, function () {
            var mockPackageJson, workflows;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        mockPackageJson = {
                            name: 'workrail-workflows-test',
                            version: '1.0.0'
                            // missing workrail.workflows flag
                        };
                        mockExistsSync.mockReturnValue(true);
                        mockFs.readdir.mockResolvedValue([createMockDirent('workrail-workflows-test')]);
                        mockFs.stat.mockResolvedValue({ size: 1000 });
                        mockFs.readFile.mockResolvedValue(JSON.stringify(mockPackageJson));
                        return [4 /*yield*/, storage.loadAllWorkflows()];
                    case 1:
                        workflows = _a.sent();
                        expect(workflows).toEqual([]);
                        return [2 /*return*/];
                }
            });
        }); });
        it('should validate package name format', function () { return __awaiter(void 0, void 0, void 0, function () {
            var mockPackageJson;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        mockPackageJson = {
                            // missing name field
                            version: '1.0.0',
                            workrail: { workflows: true }
                        };
                        mockExistsSync.mockReturnValue(true);
                        mockFs.readdir.mockResolvedValue([createMockDirent('workrail-workflows-test')]);
                        mockFs.stat.mockResolvedValue({ size: 1000 });
                        mockFs.readFile.mockResolvedValue(JSON.stringify(mockPackageJson));
                        return [4 /*yield*/, expect(storage.loadAllWorkflows()).rejects.toThrow(error_handler_1.InvalidWorkflowError)];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, expect(storage.loadAllWorkflows()).rejects.toThrow(/Invalid package name/)];
                    case 2:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); });
    });
    describe('Workflow Loading and Validation', function () {
        beforeEach(function () {
            storage = new plugin_workflow_storage_1.PluginWorkflowStorage({
                pluginPaths: ['/test/node_modules']
            });
        });
        it('should successfully load valid workflows', function () { return __awaiter(void 0, void 0, void 0, function () {
            var mockWorkflow, mockPackageJson, workflows, summaries;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        mockWorkflow = {
                            id: 'test-workflow',
                            name: 'Test Workflow',
                            description: 'A test workflow',
                            version: '1.0.0',
                            steps: []
                        };
                        mockExistsSync.mockReturnValue(true);
                        mockFs.readdir.mockImplementation(function (dirPath) {
                            var pathStr = dirPath.toString();
                            if (pathStr.endsWith('node_modules')) {
                                return Promise.resolve(['workrail-workflows-test']);
                            }
                            if (pathStr.endsWith('workflows')) {
                                return Promise.resolve(['test-workflow.json']);
                            }
                            return Promise.resolve([]);
                        });
                        mockPackageJson = {
                            name: 'workrail-workflows-test',
                            version: '1.0.0',
                            workrail: { workflows: true },
                            author: 'Test Author',
                            description: 'Test plugin'
                        };
                        mockFs.stat.mockResolvedValue({ size: 1000 });
                        mockFs.readFile.mockImplementation(function (filePath) {
                            var pathStr = filePath.toString();
                            if (pathStr.endsWith('package.json')) {
                                return Promise.resolve(JSON.stringify(mockPackageJson));
                            }
                            if (pathStr.endsWith('test-workflow.json')) {
                                return Promise.resolve(JSON.stringify(mockWorkflow));
                            }
                            return Promise.resolve('[]');
                        });
                        return [4 /*yield*/, storage.loadAllWorkflows()];
                    case 1:
                        workflows = _a.sent();
                        expect(workflows).toEqual([mockWorkflow]);
                        return [4 /*yield*/, storage.listWorkflowSummaries()];
                    case 2:
                        summaries = _a.sent();
                        expect(summaries).toEqual([{
                                id: 'test-workflow',
                                name: 'Test Workflow',
                                description: 'A test workflow',
                                category: 'plugin',
                                version: '1.0.0'
                            }]);
                        return [2 /*return*/];
                }
            });
        }); });
        it('should find workflow by ID correctly', function () { return __awaiter(void 0, void 0, void 0, function () {
            var mockWorkflow, mockPackageJson, found, notFound;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        mockWorkflow = {
                            id: 'test-workflow',
                            name: 'Test Workflow',
                            description: 'A test workflow',
                            version: '1.0.0',
                            steps: []
                        };
                        // Setup successful workflow loading
                        mockExistsSync.mockReturnValue(true);
                        mockFs.readdir.mockImplementation(function (dirPath) {
                            var pathStr = dirPath.toString();
                            if (pathStr.endsWith('node_modules')) {
                                return Promise.resolve(['workrail-workflows-test']);
                            }
                            if (pathStr.endsWith('workflows')) {
                                return Promise.resolve(['test-workflow.json']);
                            }
                            return Promise.resolve([]);
                        });
                        mockPackageJson = {
                            name: 'workrail-workflows-test',
                            version: '1.0.0',
                            workrail: { workflows: true }
                        };
                        mockFs.stat.mockResolvedValue({ size: 1000 });
                        mockFs.readFile.mockImplementation(function (filePath) {
                            var pathStr = filePath.toString();
                            if (pathStr.endsWith('package.json')) {
                                return Promise.resolve(JSON.stringify(mockPackageJson));
                            }
                            return Promise.resolve(JSON.stringify(mockWorkflow));
                        });
                        return [4 /*yield*/, storage.getWorkflowById('test-workflow')];
                    case 1:
                        found = _a.sent();
                        expect(found).toEqual(mockWorkflow);
                        return [4 /*yield*/, storage.getWorkflowById('nonexistent')];
                    case 2:
                        notFound = _a.sent();
                        expect(notFound).toBeNull();
                        return [2 /*return*/];
                }
            });
        }); });
        it('should handle invalid workflow JSON gracefully', function () { return __awaiter(void 0, void 0, void 0, function () {
            var mockPackageJson;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        mockExistsSync.mockReturnValue(true);
                        mockFs.readdir.mockImplementation(function (dirPath) {
                            var pathStr = dirPath.toString();
                            if (pathStr.endsWith('node_modules')) {
                                return Promise.resolve(['workrail-workflows-test']);
                            }
                            if (pathStr.endsWith('workflows')) {
                                return Promise.resolve(['invalid.json']);
                            }
                            return Promise.resolve([]);
                        });
                        mockPackageJson = {
                            name: 'workrail-workflows-test',
                            version: '1.0.0',
                            workrail: { workflows: true }
                        };
                        mockFs.stat.mockResolvedValue({ size: 1000 });
                        mockFs.readFile.mockImplementation(function (filePath) {
                            var pathStr = filePath.toString();
                            if (pathStr.endsWith('package.json')) {
                                return Promise.resolve(JSON.stringify(mockPackageJson));
                            }
                            return Promise.resolve('invalid json content');
                        });
                        return [4 /*yield*/, expect(storage.loadAllWorkflows()).rejects.toThrow(error_handler_1.InvalidWorkflowError)];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, expect(storage.loadAllWorkflows()).rejects.toThrow(/Invalid JSON in workflow file/)];
                    case 2:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); });
    });
    describe('Error Handling', function () {
        beforeEach(function () {
            storage = new plugin_workflow_storage_1.PluginWorkflowStorage({
                pluginPaths: ['/test/node_modules']
            });
        });
        it('should handle directory access errors gracefully', function () { return __awaiter(void 0, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        mockExistsSync.mockReturnValue(true);
                        mockFs.readdir.mockRejectedValue(new Error('Permission denied'));
                        return [4 /*yield*/, expect(storage.loadAllWorkflows()).rejects.toThrow(error_handler_1.StorageError)];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, expect(storage.loadAllWorkflows()).rejects.toThrow(/Failed to scan plugin directory/)];
                    case 2:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); });
        it('should throw error for save operations', function () { return __awaiter(void 0, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, expect(storage.save()).rejects.toThrow(error_handler_1.StorageError)];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, expect(storage.save()).rejects.toThrow(/read-only/)];
                    case 2:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); });
        it('should handle file system errors during loading', function () { return __awaiter(void 0, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        mockExistsSync.mockReturnValue(true);
                        mockFs.readdir.mockImplementation(function (dirPath) {
                            var pathStr = dirPath.toString();
                            if (pathStr.endsWith('node_modules')) {
                                return Promise.resolve(['workrail-workflows-test']);
                            }
                            return Promise.resolve([]);
                        });
                        mockFs.stat.mockRejectedValue(new Error('File system error'));
                        return [4 /*yield*/, expect(storage.loadAllWorkflows()).rejects.toThrow(error_handler_1.StorageError)];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); });
    });
    describe('Caching and Performance', function () {
        beforeEach(function () {
            storage = new plugin_workflow_storage_1.PluginWorkflowStorage({
                pluginPaths: ['/test/node_modules'],
                scanInterval: 60000 // 1 minute
            });
        });
        it('should respect scan interval for caching', function () { return __awaiter(void 0, void 0, void 0, function () {
            var originalDateNow;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        mockExistsSync.mockReturnValue(true);
                        mockFs.readdir.mockResolvedValue([]);
                        // First call should trigger scan
                        return [4 /*yield*/, storage.loadAllWorkflows()];
                    case 1:
                        // First call should trigger scan
                        _a.sent();
                        expect(mockFs.readdir).toHaveBeenCalledTimes(1);
                        // Second call within interval should use cache
                        return [4 /*yield*/, storage.loadAllWorkflows()];
                    case 2:
                        // Second call within interval should use cache
                        _a.sent();
                        expect(mockFs.readdir).toHaveBeenCalledTimes(1); // No additional calls
                        originalDateNow = Date.now;
                        Date.now = jest.fn(function () { return originalDateNow() + 70000; }); // 70 seconds later
                        // Third call after interval should trigger new scan
                        return [4 /*yield*/, storage.loadAllWorkflows()];
                    case 3:
                        // Third call after interval should trigger new scan
                        _a.sent();
                        expect(mockFs.readdir).toHaveBeenCalledTimes(2);
                        // Restore Date.now
                        Date.now = originalDateNow;
                        return [2 /*return*/];
                }
            });
        }); });
        it('should provide access to loaded plugins', function () { return __awaiter(void 0, void 0, void 0, function () {
            var mockPackageJson, plugins;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        mockPackageJson = {
                            name: 'test-plugin',
                            version: '1.0.0',
                            workrail: { workflows: true },
                            author: 'Test Author'
                        };
                        mockExistsSync.mockReturnValue(true);
                        mockFs.readdir.mockImplementation(function (dirPath) {
                            var pathStr = dirPath.toString();
                            if (pathStr.endsWith('node_modules')) {
                                return Promise.resolve(['workrail-workflows-test']);
                            }
                            return Promise.resolve([]);
                        });
                        mockFs.stat.mockResolvedValue({ size: 1000 });
                        mockFs.readFile.mockResolvedValue(JSON.stringify(mockPackageJson));
                        return [4 /*yield*/, storage.loadAllWorkflows()];
                    case 1:
                        _b.sent();
                        plugins = storage.getLoadedPlugins();
                        expect(plugins).toHaveLength(1);
                        expect(plugins[0].name).toBe('test-plugin');
                        expect((_a = plugins[0].metadata) === null || _a === void 0 ? void 0 : _a.author).toBe('Test Author');
                        return [2 /*return*/];
                }
            });
        }); });
    });
});
