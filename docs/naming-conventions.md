# Naming Conventions – Workflow Orchestration System

> **Status:** Adopted – Phase 3 completion

This document records the agreed-upon naming conventions and the result of the initial audit performed in Phase 3 of the refactor roadmap.

---

## 1  Coding-Symbol Conventions

| Element                        | Convention            | Example                          |
|--------------------------------|-----------------------|----------------------------------|
| Classes / Types / Interfaces   | `PascalCase`          | `FileWorkflowStorage`            |
| Functions & Variables          | `camelCase`           | `getWorkflowById()`              |
| Constants (module scoped)      | `UPPER_SNAKE_CASE`    | `WORKFLOW_SCHEMA_PATH`           |
| Enum members                   | `UPPER_SNAKE_CASE`    | `WORKFLOW_NOT_FOUND`             |
| Error Classes                  | Suffix `Error`        | `WorkflowNotFoundError`          |

## 2  File & Directory Names

* **Files:** `snake_case` with `.ts` extension (e.g., `workflow_get.ts`).
* **Directories:** `kebab-case` or lower-case single word (e.g., `workflow/`).

Rationale: File names remain friendlier on case-insensitive file systems; underscores map 1-to-1 with existing tool names.

## 3  Public API / JSON-RPC Methods

* Tool method names follow `snake_case` as defined in the MCP spec (e.g., `workflow_list`).

## 4  Audit Result (2025-07-10)

The entire `src/` tree was inspected. Findings:

| Category           | Issues Found | Resolution |
|--------------------|--------------|------------|
| File names         | **0**        | –          |
| Export identifiers | **0**        | –          |
| Enum / Const names | **0**        | –          |

Conclusion: Codebase already adheres to the conventions above. No renames were required.

## 5  Future Enforcement

* ESLint rule set to be extended with `@typescript-eslint/naming-convention` to automatically enforce the table above.
* Pull-request template updated to reference this document (TBD). 