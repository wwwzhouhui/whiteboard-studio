# Progress Log

## 2026-10-30 - Task: 同步 GitHub 最新代码到本地运行环境
### What was done
- 从 origin/main 拉取最新提交 `e7645c3`（feat: run on local Qwen3-8B (vLLM) with switchable model source），本地从 `5a05d72` 快进到最新，无冲突。
- 因提交变更了 package.json / pnpm-lock.yaml 并新增 pnpm 补丁（@agent-native/core 0.221.0）与 rolldown override，重新执行 `pnpm install`，补丁与依赖安装成功。
### Testing
- `pnpm typecheck`（DO_NOT_TRACK=1 AGENT_NATIVE_TELEMETRY_DISABLED=1）：通过，无错误。
- `pnpm agent-native:doctor`：发现 5 条 no-env-credentials 提示，全部位于本次拉取的 `server/model-endpoints.ts`（LOCAL_MODEL_* 与 STUDIO_PUBLIC_URL 读取 process.env），属于上游提交既有内容，非本次同步引入，未擅自修改，已向用户汇报。
### Notes
- 本任务改动文件清单：
  - `progress.md`：新建，本文件首条记录。
  - 其余文件变更均来自拉取的用户提交 `e7645c3`（16 个文件，含新增本地/云端模型切换路由、模型设置页、pnpm 补丁、README 重写等）。
- 回滚方式：`git reset --hard 5a05d72` 可回到同步前状态（会丢弃拉取的更新）；仅回滚依赖可删除 node_modules 后在 `5a05d72` 重新 `pnpm install`。

## 2026-10-31 - Task: README 参照 in_animation 结构补充社区章节
### What was done
- 参照 `in_animation/README.md` 的目录结构，为 README.md 补齐社区与项目信息章节：技术交流群、作者联系、打赏、Star History、License（MIT）、更新日志、致谢、贡献指南，并同步更新文首「目录」锚点。
- 更新日志按仓库真实提交历史撰写：v1.0.0（2026-10-29 首次发布）、v1.1.0（2026-10-30 本地 Qwen3-8B 支持）。二维码图片复用作者已有图床链接，联系信息与 in_animation 保持一致。
### Testing
- `grep -n "^## "` 确认 12 个章节全部就位；`git diff --stat` 确认为纯新增 103 行，未改动原有内容。
### Notes
- 改动文件清单：
  - `README.md`：文首目录追加 8 个锚点；尾部追加技术交流群、作者联系、打赏、Star History、License、更新日志、致谢、贡献指南共 103 行。
  - `progress.md`：追加本条记录。
- 回滚方式：`git checkout -- README.md progress.md` 可撤销本次改动（README.md 原本无未提交修改，回滚即回到拉取后状态）。

## 2026-10-31 - Task: 提交推送 README 视频嵌入修改并合并远程改动
### What was done
- 将用户本地对 README 视频嵌入标记的简化（移除 `<p align="center">` 包裹）提交推送；期间远程已存在用户在 GitHub 网页端上传新演示视频并替换链接的提交（d6938cb），rebase 时同一区域产生冲突，手动合并为「简化标记 + 新视频链接（3b1566cd）」，推送为 7be8071。
- 附带诊断结论：旧视频附件（c9348c99）经 ffprobe 远程探测文件本身完好（H.264、88.8 秒、与本地 5MB 文件一致），此前播放器 0:00 不是文件损坏，问题在页面播放链路；已由用户换用新上传附件。
### Testing
- `git log` 确认提交序列 5987969 → d6938cb → 7be8071；`git push` 成功（d6938cb..7be8071）；合并后 README 第 12-17 行确认为简化标记 + 新链接。
### Notes
- 改动文件清单：
  - `README.md`：视频效果区合并为简化 `<video>` 标签并保留用户新上传的附件链接。
  - `progress.md`：追加本条记录。
- 回滚方式：`git revert 7be8071` 撤销本次合并提交并重新推送。
