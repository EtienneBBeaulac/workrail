"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var condition_evaluator_1 = require("../../src/utils/condition-evaluator");
describe('Condition Evaluator', function () {
    describe('evaluateCondition', function () {
        it('should return true for null/undefined conditions', function () {
            expect((0, condition_evaluator_1.evaluateCondition)(null)).toBe(true);
            expect((0, condition_evaluator_1.evaluateCondition)(undefined)).toBe(true);
            expect((0, condition_evaluator_1.evaluateCondition)({})).toBe(true);
        });
        it('should evaluate simple variable conditions', function () {
            var context = { taskScope: 'small', userLevel: 'expert' };
            expect((0, condition_evaluator_1.evaluateCondition)({ var: 'taskScope', equals: 'small' }, context)).toBe(true);
            expect((0, condition_evaluator_1.evaluateCondition)({ var: 'taskScope', equals: 'large' }, context)).toBe(false);
            expect((0, condition_evaluator_1.evaluateCondition)({ var: 'userLevel', not_equals: 'novice' }, context)).toBe(true);
            expect((0, condition_evaluator_1.evaluateCondition)({ var: 'userLevel', not_equals: 'expert' }, context)).toBe(false);
        });
        it('should evaluate numeric comparisons', function () {
            var context = { complexity: 0.7, score: 85 };
            expect((0, condition_evaluator_1.evaluateCondition)({ var: 'complexity', gt: 0.5 }, context)).toBe(true);
            expect((0, condition_evaluator_1.evaluateCondition)({ var: 'complexity', gt: 0.8 }, context)).toBe(false);
            expect((0, condition_evaluator_1.evaluateCondition)({ var: 'complexity', gte: 0.7 }, context)).toBe(true);
            expect((0, condition_evaluator_1.evaluateCondition)({ var: 'score', lt: 100 }, context)).toBe(true);
            expect((0, condition_evaluator_1.evaluateCondition)({ var: 'score', lte: 85 }, context)).toBe(true);
            expect((0, condition_evaluator_1.evaluateCondition)({ var: 'score', lte: 80 }, context)).toBe(false);
        });
        it('should evaluate logical operators', function () {
            var context = { taskScope: 'large', userLevel: 'expert', complexity: 0.8 };
            expect((0, condition_evaluator_1.evaluateCondition)({
                and: [
                    { var: 'taskScope', equals: 'large' },
                    { var: 'userLevel', equals: 'expert' }
                ]
            }, context)).toBe(true);
            expect((0, condition_evaluator_1.evaluateCondition)({
                or: [
                    { var: 'taskScope', equals: 'small' },
                    { var: 'userLevel', equals: 'expert' }
                ]
            }, context)).toBe(true);
            expect((0, condition_evaluator_1.evaluateCondition)({
                not: { var: 'taskScope', equals: 'small' }
            }, context)).toBe(true);
        });
        it('should handle missing variables gracefully', function () {
            var context = { taskScope: 'small' };
            expect((0, condition_evaluator_1.evaluateCondition)({ var: 'nonexistent', equals: 'value' }, context)).toBe(false);
            expect((0, condition_evaluator_1.evaluateCondition)({ var: 'nonexistent', gt: 0 }, context)).toBe(false);
        });
        it('should handle invalid conditions safely', function () {
            var context = { taskScope: 'small' };
            // Test with invalid condition objects by casting to any
            expect((0, condition_evaluator_1.evaluateCondition)({ invalid: 'operator' }, context)).toBe(false);
            expect((0, condition_evaluator_1.evaluateCondition)({ and: 'not-an-array' }, context)).toBe(false);
        });
        it('should evaluate variable truthiness', function () {
            var context = { enabled: true, disabled: false, empty: '', value: 'test' };
            expect((0, condition_evaluator_1.evaluateCondition)({ var: 'enabled' }, context)).toBe(true);
            expect((0, condition_evaluator_1.evaluateCondition)({ var: 'disabled' }, context)).toBe(false);
            expect((0, condition_evaluator_1.evaluateCondition)({ var: 'empty' }, context)).toBe(false);
            expect((0, condition_evaluator_1.evaluateCondition)({ var: 'value' }, context)).toBe(true);
        });
    });
    describe('validateCondition', function () {
        it('should accept valid conditions', function () {
            expect(function () { return (0, condition_evaluator_1.validateCondition)({ var: 'test', equals: 'value' }); }).not.toThrow();
            expect(function () { return (0, condition_evaluator_1.validateCondition)({ and: [{ var: 'a', equals: 1 }] }); }).not.toThrow();
            expect(function () { return (0, condition_evaluator_1.validateCondition)({ or: [{ var: 'a', gt: 0 }, { var: 'b', lt: 10 }] }); }).not.toThrow();
        });
        it('should reject invalid operators', function () {
            expect(function () { return (0, condition_evaluator_1.validateCondition)({ var: 'test', invalid: 'operator' }); }).toThrow('Unsupported condition operators: invalid');
            expect(function () { return (0, condition_evaluator_1.validateCondition)({ badOperator: 'value' }); }).toThrow('Unsupported condition operators: badOperator');
        });
        it('should validate nested conditions', function () {
            expect(function () { return (0, condition_evaluator_1.validateCondition)({
                and: [
                    { var: 'a', equals: 1 },
                    { or: [{ var: 'b', gt: 0 }, { var: 'c', lt: 10 }] }
                ]
            }); }).not.toThrow();
            expect(function () { return (0, condition_evaluator_1.validateCondition)({
                and: [
                    { var: 'a', equals: 1 },
                    { invalid: 'nested' }
                ]
            }); }).toThrow('Unsupported condition operators: invalid');
        });
    });
});
