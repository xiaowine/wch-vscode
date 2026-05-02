# Repository Guidelines

## Project Structure & Module Organization

This repository is a TypeScript VS Code extension. Source files live in `src/`, compiled output goes to `out/`, and extension icons/assets live in `media/`. Tests are currently under `src/test/` and should stay close to extension-facing behavior. Build-related code is grouped in `src/build/`, sidebar providers in `src/sidebar/`, and shared project parsing/model code in top-level `src/*.ts` plus `src/models/`.

Do not edit generated output in `out/` or dependency folders such as `node_modules/` and `.pnpm-store/`.

## Build, Test, and Development Commands

Use pnpm for package management; the lockfile is `pnpm-lock.yaml`.

- `pnpm install`: install dependencies.
- `pnpm run compile`: run `tsc -p ./` and emit JavaScript to `out/`.
- `pnpm run watch`: compile continuously during development.
- `pnpm run lint`: run ESLint on `src`.
- `pnpm test`: compile, lint, then run VS Code extension tests via `vscode-test`.
- `pnpm run vscode:prepublish`: compile before packaging/publishing.

## Coding Style & Naming Conventions

Use TypeScript targeting ES2022 with `strict` enabled. Follow the existing 4-space indentation and semicolon style. Prefer explicit types on exported functions, provider APIs, and model boundaries. Use `camelCase` for variables/functions, `PascalCase` for classes/types, and keep import names in `camelCase` or `PascalCase` as enforced by ESLint.

Keep VS Code command IDs under the `wchVscode.*` namespace and keep contributed view IDs aligned with `package.json`.

## Testing Guidelines

Tests use Mocha through the VS Code test runner. Place tests in `src/test/` and name files `*.test.ts`, for example `src/test/wchVscode.test.ts`. Add focused tests for project detection, XML parsing, model building, and command/task behavior when changing those areas. Run `pnpm test` before submitting changes; use `pnpm run compile` for a faster type-check during iteration.

## Commit & Pull Request Guidelines

Recent history uses short Chinese commit messages that describe the change, for example `添加项目文档和状态栏功能，增强用户体验` or `根据参数编译，添加重新编译与清理按钮`. Keep commits concise and outcome-focused.

Pull requests should include a brief summary, test results, and any setup notes such as required `wchVscode.mounRiverStudioPath` values. Include screenshots or short recordings for sidebar, status bar, or command UI changes. Link related issues when available and call out user-visible behavior changes.

## Security & Configuration Tips

Do not commit local MounRiver Studio paths, generated toolchain paths, or machine-specific workspace settings. Keep secrets and absolute user paths out of tests, fixtures, and documentation examples.
