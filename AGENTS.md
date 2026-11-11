# LivingDiary 开发规范

LivingDiary 是 ChatLuna v2 的 QQ 空间插件，npm 包名为 `chatluna-plugin-livingdiary`。

## 项目规范

- 通用协作规则保留在本文件，插件使用说明放在 `README.md`，设计决策放在 `.agent/note/`。
- 除受控配置之外不在源码中写密钥；本地 `.env`、上传数据、依赖目录、构建输出和临时文件不进入交付源码包。
- 临时文件、脚本、截图与验证产物统一放入 `tmp/`。交付前执行构建、类型检查和针对主要业务闭环的集成验证，按实际结果更新交付文档。
- 迁移代码写在本仓库。QQ 空间发布、评论和回复使用模拟接口测试；真实账号写入须单独确认。

## 参考项目

- [LivingDiary v1](https://github.com/Procyon-Nan/chatluna-livingdiary)：核对原插件的行为和测试。
- [ChatLuna v2 开发文档](https://github.com/ChatLunaLab/doc)、[框架源码](https://github.com/ChatLunaLab/v2-mirror) 与 [插件开发模板](https://github.com/ChatLunaLab/boilerplate)：核对 v2 插件接口和开发环境。
- [qzone-sdk](https://github.com/Procyon-Nan/qzone-sdk)：核对 QQ 空间读写接口及写入结果的含义。
- [OneBot 适配器](https://github.com/koishijs/koishi-plugin-adapter-onebot) 与 [Milky 适配器](https://github.com/idranme/koishi-plugin-adapter-milky)：核对已登录机器人的 Cookie 获取接口。
- [LivingMemory v2](https://github.com/Procyon-Nan/chatluna-plugin-livingmemory)：核对每日日记所需的预设和记忆读取接口。

## 代码与设计

- 拒绝防御性编程和防御性设计。围绕已确认的需求、类型和接口契约实现，不为假设中的异常叠加判空、兜底、重试、兼容分支或抽象层。
- 在实际输入边界处理明确的校验和失败场景；内部代码遵循已建立的契约，不重复检查同一条件。契约被破坏时暴露具体错误，修复问题来源，不用默认值、空结果或静默捕获掩盖问题。
- 禁止大块、多重嵌套的三元表达式，尤其是 JSX 中连续嵌套的条件渲染。多分支使用清晰的 `if`、提前返回、具名函数或职责明确的组件；简单二选一可以使用单层三元表达式。
- 优先保证代码可读性。变量、分支和组件应直接表达业务含义，不为压缩行数将多个判断和操作挤在一起。

## 变更记录

- CHANGELOG.md 的提交哈希仅在版本更新提交时统一回填。日常提交保留 `pending`，不要每次提交后回填，也不要为回填单独创建提交。

## 说明与表达

以下约定适用于用户沟通、项目文档、代码注释与界面文字。

- 直接陈述实现、行为、结果和依据。禁止使用“这不是……”“这不代表……”等防御性、甩锅式说明，不添加与当前问题无关的免责声明。
- 需要说明能力范围时，用具体事实表达，例如“任务在当前页面内计时，关闭页面后暂停”，避免用免责式否定句代替行为说明。
- 不使用“可能”“大概”“也许”“未必”等模糊措辞替代核实。技术结论应以源码、文档、运行记录或实际验证为依据。
- 尚未核实的内容必须核实清楚，如果无法查证应当及时汇报；需要用户决定的需求直接提出问题。不得把推测写成确定结论。

## 代码结构

```text
livingdiary/
├── src/index.ts     # 插件入口：声明依赖、导出配置并注册加载函数
├── scripts/clean.mjs # 清理编译产物与增量编译记录
├── package.json     # 包信息、导出入口、依赖与构建、发布脚本
├── tsconfig.json    # 插件的 TypeScript 配置
├── .gitignore       # 依赖与构建产物的忽略规则
├── AGENTS.md        # 项目协作规范
├── README.md        # 插件说明
├── CHANGELOG.md     # 版本变更记录
└── .agent/note/     # Agent Note 工作流与设计决策
```

目录树记录当前已落地文件。新增、删除、移动或重命名文件时同步更新本节。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [README.md](README.md) | 插件简介、构建与发布方法 |
| [CHANGELOG.md](CHANGELOG.md) | 各版本的变更记录 |
| [.agent/note/README.zh.md](.agent/note/README.zh.md) | Agent Note 的撰写格式、分类、状态转换和归档规则 |

Agent Note 只保留工作流入口，具体记录通过生命周期、类别目录及文内交叉链接查找，不逐篇追加到本索引。
