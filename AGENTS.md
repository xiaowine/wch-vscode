# Repository Guidelines

## 工程约束

- 只使用 pnpm 管理依赖和执行脚本；不要使用 npm、yarn 或手工修改锁文件。
- 未经用户明确确认，不要执行任何 `git commit`、`git commit --amend`、`git rebase` 等提交或改写提交记录的操作。
- 不要手工修改 `out/`、`node_modules/` 等生成目录。

## 代码地图

项目结构和模块职责见 [CODE_MAP.md](CODE_MAP.md)。

## 基本约定

- TypeScript，`strict` 开启，保持现有 4 空格缩进和分号风格。
- VS Code 命令 ID 统一使用 `wchVscode.*`，视图 ID 与 `package.json` 保持一致。
- 修改代码后至少执行 `pnpm run compile` 和 `pnpm run lint`。

## 文档约定

- `CHANGELOG.md` 面向最终用户，只描述用户能感知的新增、修复和变更；不要写内部实现细节（函数名、编码方式、命令行参数、内部协议等）。
