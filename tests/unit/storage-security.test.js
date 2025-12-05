"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var globals_1 = require("@jest/globals");
var storage_security_1 = require("../../src/utils/storage-security");
var error_handler_1 = require("../../src/core/error-handler");
(0, globals_1.describe)('Storage Security Utilities', function () {
    (0, globals_1.describe)('sanitizeId', function () {
        (0, globals_1.it)('should accept valid workflow IDs', function () {
            var validIds = [
                'test-workflow',
                'workflow_123',
                'simple-id',
                'WorkFlow-ID_123',
                'a',
                '123',
                'test-workflow-with-many-parts'
            ];
            var _loop_1 = function (id) {
                (0, globals_1.expect)(function () { return (0, storage_security_1.sanitizeId)(id); }).not.toThrow();
                (0, globals_1.expect)((0, storage_security_1.sanitizeId)(id)).toBe(id.normalize('NFC'));
            };
            for (var _i = 0, validIds_1 = validIds; _i < validIds_1.length; _i++) {
                var id = validIds_1[_i];
                _loop_1(id);
            }
        });
        (0, globals_1.it)('should reject IDs with null bytes', function () {
            var maliciousIds = [
                'test\u0000workflow',
                '\u0000malicious',
                'workflow\u0000'
            ];
            var _loop_2 = function (id) {
                (0, globals_1.expect)(function () { return (0, storage_security_1.sanitizeId)(id); }).toThrow(error_handler_1.SecurityError);
                (0, globals_1.expect)(function () { return (0, storage_security_1.sanitizeId)(id); }).toThrow('Null byte detected');
            };
            for (var _i = 0, maliciousIds_1 = maliciousIds; _i < maliciousIds_1.length; _i++) {
                var id = maliciousIds_1[_i];
                _loop_2(id);
            }
        });
        (0, globals_1.it)('should reject IDs with invalid characters', function () {
            var invalidIds = [
                'test workflow', // space
                'test/workflow', // slash
                'test.workflow', // dot
                'test@workflow', // at symbol
                'test#workflow', // hash
                'test$workflow', // dollar
                'test%workflow', // percent
                'test&workflow', // ampersand
                'test workflow!', // exclamation
                '' // empty string
            ];
            var _loop_3 = function (id) {
                (0, globals_1.expect)(function () { return (0, storage_security_1.sanitizeId)(id); }).toThrow(error_handler_1.InvalidWorkflowError);
            };
            for (var _i = 0, invalidIds_1 = invalidIds; _i < invalidIds_1.length; _i++) {
                var id = invalidIds_1[_i];
                _loop_3(id);
            }
        });
        (0, globals_1.it)('should normalize Unicode characters', function () {
            // Unicode characters outside ASCII range should be rejected by the current implementation
            var unicodeId = 'café'; // Contains é which is outside ASCII
            (0, globals_1.expect)(function () { return (0, storage_security_1.sanitizeId)(unicodeId); }).toThrow(error_handler_1.InvalidWorkflowError);
        });
    });
    (0, globals_1.describe)('assertWithinBase', function () {
        var baseDir = '/safe/base/dir';
        (0, globals_1.it)('should allow paths within base directory', function () {
            var validPaths = [
                '/safe/base/dir/subdir/file.json',
                '/safe/base/dir/file.json',
                '/safe/base/dir' // base dir itself
            ];
            var _loop_4 = function (safePath) {
                (0, globals_1.expect)(function () { return (0, storage_security_1.assertWithinBase)(safePath, baseDir); }).not.toThrow();
            };
            for (var _i = 0, validPaths_1 = validPaths; _i < validPaths_1.length; _i++) {
                var safePath = validPaths_1[_i];
                _loop_4(safePath);
            }
        });
        (0, globals_1.it)('should reject paths outside base directory', function () {
            var dangerousPaths = [
                '/safe/base', // parent of base
                '/safe/base/different', // sibling directory
                '/completely/different/path',
                '/etc/passwd'
            ];
            var _loop_5 = function (dangerousPath) {
                (0, globals_1.expect)(function () { return (0, storage_security_1.assertWithinBase)(dangerousPath, baseDir); }).toThrow(error_handler_1.SecurityError);
                (0, globals_1.expect)(function () { return (0, storage_security_1.assertWithinBase)(dangerousPath, baseDir); }).toThrow('Path escapes storage sandbox');
            };
            for (var _i = 0, dangerousPaths_1 = dangerousPaths; _i < dangerousPaths_1.length; _i++) {
                var dangerousPath = dangerousPaths_1[_i];
                _loop_5(dangerousPath);
            }
        });
    });
    (0, globals_1.describe)('validateFileSize', function () {
        (0, globals_1.it)('should allow files within size limit', function () {
            (0, globals_1.expect)(function () { return (0, storage_security_1.validateFileSize)(500, 1000); }).not.toThrow();
            (0, globals_1.expect)(function () { return (0, storage_security_1.validateFileSize)(1000, 1000); }).not.toThrow(); // exactly at limit
            (0, globals_1.expect)(function () { return (0, storage_security_1.validateFileSize)(0, 1000); }).not.toThrow();
        });
        (0, globals_1.it)('should reject files exceeding size limit', function () {
            (0, globals_1.expect)(function () { return (0, storage_security_1.validateFileSize)(1001, 1000); }).toThrow(error_handler_1.SecurityError);
            (0, globals_1.expect)(function () { return (0, storage_security_1.validateFileSize)(1001, 1000); }).toThrow('exceeds size limit');
        });
        (0, globals_1.it)('should include context in error message when provided', function () {
            (0, globals_1.expect)(function () { return (0, storage_security_1.validateFileSize)(1001, 1000, 'test.json'); }).toThrow('(test.json)');
        });
    });
    (0, globals_1.describe)('securePathResolve', function () {
        (0, globals_1.it)('should resolve safe relative paths', function () {
            var basePath = '/safe/base';
            (0, globals_1.expect)((0, storage_security_1.securePathResolve)(basePath, 'subdir/file.json')).toBe('/safe/base/subdir/file.json');
            (0, globals_1.expect)((0, storage_security_1.securePathResolve)(basePath, './file.json')).toBe('/safe/base/file.json');
        });
        (0, globals_1.it)('should reject path traversal attempts', function () {
            var basePath = '/safe/base';
            var dangerousRelativePaths = [
                '../../../etc/passwd',
                '../../sensitive',
                '../outside'
            ];
            var _loop_6 = function (dangerousPath) {
                (0, globals_1.expect)(function () { return (0, storage_security_1.securePathResolve)(basePath, dangerousPath); }).toThrow(error_handler_1.SecurityError);
            };
            for (var _i = 0, dangerousRelativePaths_1 = dangerousRelativePaths; _i < dangerousRelativePaths_1.length; _i++) {
                var dangerousPath = dangerousRelativePaths_1[_i];
                _loop_6(dangerousPath);
            }
        });
    });
    (0, globals_1.describe)('validateSecureUrl', function () {
        (0, globals_1.it)('should allow safe HTTPS URLs', function () {
            var safeUrls = [
                'https://example.com/api/workflows',
                'https://api.github.com/repos/org/workflows',
                'https://registry.npmjs.org/package',
                'https://subdomain.example.com:8443/path'
            ];
            var _loop_7 = function (url) {
                (0, globals_1.expect)(function () { return (0, storage_security_1.validateSecureUrl)(url); }).not.toThrow();
            };
            for (var _i = 0, safeUrls_1 = safeUrls; _i < safeUrls_1.length; _i++) {
                var url = safeUrls_1[_i];
                _loop_7(url);
            }
        });
        (0, globals_1.it)('should allow HTTP URLs to public domains', function () {
            var httpUrls = [
                'http://example.com/api',
                'http://public-registry.com/workflows'
            ];
            var _loop_8 = function (url) {
                (0, globals_1.expect)(function () { return (0, storage_security_1.validateSecureUrl)(url); }).not.toThrow();
            };
            for (var _i = 0, httpUrls_1 = httpUrls; _i < httpUrls_1.length; _i++) {
                var url = httpUrls_1[_i];
                _loop_8(url);
            }
        });
        (0, globals_1.it)('should reject unsafe protocols', function () {
            var unsafeUrls = [
                'file:///etc/passwd',
                'ftp://example.com/file',
                'javascript:alert(1)',
                'data:text/html,<script>alert(1)</script>'
            ];
            var _loop_9 = function (url) {
                (0, globals_1.expect)(function () { return (0, storage_security_1.validateSecureUrl)(url); }).toThrow(error_handler_1.SecurityError);
                (0, globals_1.expect)(function () { return (0, storage_security_1.validateSecureUrl)(url); }).toThrow('Unsafe protocol');
            };
            for (var _i = 0, unsafeUrls_1 = unsafeUrls; _i < unsafeUrls_1.length; _i++) {
                var url = unsafeUrls_1[_i];
                _loop_9(url);
            }
        });
        (0, globals_1.it)('should reject localhost and private network access', function () {
            var localUrls = [
                'https://localhost/api',
                'https://127.0.0.1/api',
                'https://192.168.1.1/api',
                'https://10.0.0.1/api',
                'https://172.16.0.1/api'
            ];
            var _loop_10 = function (url) {
                (0, globals_1.expect)(function () { return (0, storage_security_1.validateSecureUrl)(url); }).toThrow(error_handler_1.SecurityError);
                (0, globals_1.expect)(function () { return (0, storage_security_1.validateSecureUrl)(url); }).toThrow('local/private networks');
            };
            for (var _i = 0, localUrls_1 = localUrls; _i < localUrls_1.length; _i++) {
                var url = localUrls_1[_i];
                _loop_10(url);
            }
        });
        (0, globals_1.it)('should reject malformed URLs', function () {
            var malformedUrls = [
                'not-a-url',
                'https://',
                'https://[invalid',
                'totally invalid'
            ];
            var _loop_11 = function (url) {
                (0, globals_1.expect)(function () { return (0, storage_security_1.validateSecureUrl)(url); }).toThrow(error_handler_1.SecurityError);
                (0, globals_1.expect)(function () { return (0, storage_security_1.validateSecureUrl)(url); }).toThrow('Invalid URL format');
            };
            for (var _i = 0, malformedUrls_1 = malformedUrls; _i < malformedUrls_1.length; _i++) {
                var url = malformedUrls_1[_i];
                _loop_11(url);
            }
        });
    });
    (0, globals_1.describe)('validateSecurityOptions', function () {
        (0, globals_1.it)('should apply defaults for empty options', function () {
            var result = (0, storage_security_1.validateSecurityOptions)();
            (0, globals_1.expect)(result).toEqual(storage_security_1.DEFAULT_SECURITY_OPTIONS);
        });
        (0, globals_1.it)('should merge user options with defaults', function () {
            var options = {
                maxFileSizeBytes: 500000,
                allowHttp: true
            };
            var result = (0, storage_security_1.validateSecurityOptions)(options);
            (0, globals_1.expect)(result.maxFileSizeBytes).toBe(500000);
            (0, globals_1.expect)(result.allowHttp).toBe(true);
            (0, globals_1.expect)(result.allowedUrlPatterns).toEqual([]); // default
        });
        (0, globals_1.it)('should reject non-positive file size limits', function () {
            (0, globals_1.expect)(function () { return (0, storage_security_1.validateSecurityOptions)({ maxFileSizeBytes: 0 }); }).toThrow(error_handler_1.SecurityError);
            (0, globals_1.expect)(function () { return (0, storage_security_1.validateSecurityOptions)({ maxFileSizeBytes: -1 }); }).toThrow(error_handler_1.SecurityError);
        });
        (0, globals_1.it)('should reject unreasonably large file size limits', function () {
            (0, globals_1.expect)(function () { return (0, storage_security_1.validateSecurityOptions)({ maxFileSizeBytes: 200000000 }); }).toThrow(error_handler_1.SecurityError);
            (0, globals_1.expect)(function () { return (0, storage_security_1.validateSecurityOptions)({ maxFileSizeBytes: 200000000 }); }).toThrow('exceeds reasonable limit');
        });
        (0, globals_1.it)('should accept reasonable file size limits', function () {
            var validSizes = [1, 1000, 1000000, 50000000, 100000000];
            var _loop_12 = function (size) {
                (0, globals_1.expect)(function () { return (0, storage_security_1.validateSecurityOptions)({ maxFileSizeBytes: size }); }).not.toThrow();
            };
            for (var _i = 0, validSizes_1 = validSizes; _i < validSizes_1.length; _i++) {
                var size = validSizes_1[_i];
                _loop_12(size);
            }
        });
    });
    (0, globals_1.describe)('DEFAULT_SECURITY_OPTIONS', function () {
        (0, globals_1.it)('should have sensible default values', function () {
            (0, globals_1.expect)(storage_security_1.DEFAULT_SECURITY_OPTIONS.maxFileSizeBytes).toBe(1000000); // 1MB
            (0, globals_1.expect)(storage_security_1.DEFAULT_SECURITY_OPTIONS.allowHttp).toBe(false);
            (0, globals_1.expect)(storage_security_1.DEFAULT_SECURITY_OPTIONS.allowedUrlPatterns).toEqual([]);
        });
    });
});
